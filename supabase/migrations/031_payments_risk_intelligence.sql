-- =============================================================
-- SendMo — Payment risk intelligence
-- Migration: 031_payments_risk_intelligence.sql
--
-- Decided proposal:
--   proposals/2026-05-21_payments-risk-intelligence_reviewed-2026-05-22_decided-2026-05-22.md
--
-- WHAT THIS DOES (atomic — single transaction):
--   1. B6 — sendmo_links.max_price_cents default 10000 ($100) -> 5000 ($50).
--           Existing links keep their explicit values; only NEW links
--           default to $50.
--   2. B5 — profiles.daily_budget_cents / weekly_budget_cents: the per-account
--           Account Budget ($200/day, $500/week defaults). Admin-raised only.
--   3. B5 — set_account_budget() RPC: guarded mutator (SECURITY DEFINER),
--           mirrors set_admin_active_mode() from migration 022.
--   4. B5 — column-level REVOKE UPDATE on the budget columns so a user cannot
--           self-serve raise their own budget (the "Users can update own
--           profile" RLS policy would otherwise allow it). The RPC is the
--           sole sanctioned writer.
--   5. B4 — link_state_events.event CHECK enum gains 'radar_blocked'.
--
-- ROLLBACK STORY: Postgres' implicit migration transaction. Land at 031
-- cleanly or back at 030. No partial state.
-- =============================================================


-- =============================================================
-- 1. B6 — per-shipment cap default $100 -> $50
-- =============================================================
ALTER TABLE public.sendmo_links
    ALTER COLUMN max_price_cents SET DEFAULT 5000;

COMMENT ON COLUMN public.sendmo_links.max_price_cents IS
    'Max charge per individual shipment, server-enforced in the labels Edge '
    'Function. Default 5000 ($50) as of migration 031 (was 10000/$100). '
    'Recipients can deliberately raise it per link. Bounds single-charge '
    'blast radius; the per-account Account Budget (profiles.*_budget_cents) '
    'bounds cumulative spend.';


-- =============================================================
-- 2. B5 — Account Budget columns
-- =============================================================
ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS daily_budget_cents  INTEGER NOT NULL DEFAULT 20000,
    ADD COLUMN IF NOT EXISTS weekly_budget_cents INTEGER NOT NULL DEFAULT 50000;

COMMENT ON COLUMN public.profiles.daily_budget_cents IS
    'Account Budget — max total charges (flex 2a + full-label 2b) against '
    'this account per rolling 24h, per mode. Default 20000 ($200). Enforced '
    'in the labels + payments Edge Functions via _shared/budget.ts. Raised '
    'only by an admin via set_account_budget() — never self-serve (see the '
    'column-level REVOKE below).';
COMMENT ON COLUMN public.profiles.weekly_budget_cents IS
    'Account Budget — max total charges against this account per rolling 7d, '
    'per mode. Default 50000 ($500). Companion to daily_budget_cents.';


-- =============================================================
-- 3. B5 — set_account_budget() guarded mutator
--
-- SECURITY DEFINER + admin-role check, mirroring set_admin_active_mode()
-- (migration 022). Unlike that RPC, this one targets ANOTHER user's row
-- (an admin sets a customer's budget), so it takes target_user_id.
-- =============================================================
CREATE OR REPLACE FUNCTION public.set_account_budget(
    target_user_id UUID,
    daily_cents    INTEGER,
    weekly_cents   INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    caller_id   UUID;
    caller_role TEXT;
BEGIN
    caller_id := auth.uid();
    IF caller_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT role INTO caller_role FROM profiles WHERE id = caller_id;
    IF caller_role IS DISTINCT FROM 'admin' THEN
        RAISE EXCEPTION 'Only admin users can set an account budget';
    END IF;

    IF daily_cents IS NULL OR weekly_cents IS NULL
       OR daily_cents < 0 OR weekly_cents < 0 THEN
        RAISE EXCEPTION 'Budget values must be non-negative integers';
    END IF;
    IF daily_cents > 100000000 OR weekly_cents > 100000000 THEN
        RAISE EXCEPTION 'Budget value exceeds the sane maximum ($1,000,000)';
    END IF;

    UPDATE profiles
       SET daily_budget_cents  = daily_cents,
           weekly_budget_cents = weekly_cents
     WHERE id = target_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No profile for target_user_id %', target_user_id;
    END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_account_budget(UUID, INTEGER, INTEGER) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.set_account_budget(UUID, INTEGER, INTEGER) TO authenticated;

COMMENT ON FUNCTION public.set_account_budget(UUID, INTEGER, INTEGER) IS
    'Admin-only Account Budget setter. SECURITY DEFINER + role check + value '
    'validation. Sets profiles.daily_budget_cents/weekly_budget_cents for the '
    'target user. RAISEs on auth/role/value error. Called from the /admin UI.';


-- =============================================================
-- 4. B5 — lock the budget columns against self-serve raises
--
-- profiles has an RLS policy "Users can update own profile"
-- (USING auth.uid() = id), so without this a user could PATCH their own
-- budget_cents up via PostgREST. Column-level REVOKE UPDATE removes that
-- ability; the SECURITY DEFINER RPC (owner privileges) and service_role
-- are unaffected. REVOKE on a role that lacks the privilege is a harmless
-- no-op, so we cover PUBLIC + authenticated + anon.
-- =============================================================
REVOKE UPDATE (daily_budget_cents, weekly_budget_cents)
    ON public.profiles FROM PUBLIC;
REVOKE UPDATE (daily_budget_cents, weekly_budget_cents)
    ON public.profiles FROM authenticated, anon;


-- =============================================================
-- 5. B4 — link_state_events gains 'radar_blocked'
--
-- A Stripe Radar block on a flex off_session charge is NOT a card decline
-- and must be recorded distinctly (proposal §3.2 / B4). Drop + re-add the
-- inline CHECK constraint (auto-named link_state_events_event_check).
-- =============================================================
ALTER TABLE public.link_state_events
    DROP CONSTRAINT IF EXISTS link_state_events_event_check;
ALTER TABLE public.link_state_events
    ADD CONSTRAINT link_state_events_event_check CHECK (event IN (
        'created',
        'activated',
        'reactivated',
        'charge_failed',
        'pm_detached',
        'pm_expired',
        'rotated',
        'cancelled_by_user',
        'radar_blocked'      -- NEW (031): flex off_session charge blocked by Stripe Radar
    ));
