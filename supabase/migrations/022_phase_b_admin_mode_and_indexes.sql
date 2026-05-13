-- =============================================================
-- SendMo — Stripe Phase B: Admin mode + Stripe Customer indexes
-- Migration: 022_phase_b_admin_mode_and_indexes.sql
--
-- Decided proposal:
--   proposals/2026-05-13_phase-b-saved-cards-implementation_reviewed-2026-05-13_decided-2026-05-13.md
--   B2 fix (admin_active_mode column + RPC), B4 fix (stripe_customer_id indexes).
--
-- WHAT THIS DOES:
--
--   1. profiles.admin_active_mode  — server-trusted admin toolbar state.
--                                    Only role='admin' can move off 'test'.
--   2. set_admin_active_mode() RPC — guarded mutator (SECURITY DEFINER).
--   3. Two partial indexes on profiles.stripe_customer_id_{test,live} so
--      the stripe-webhook function's per-event user lookup isn't a seq scan.
--
-- Per master proposal §4.4 (Rule 14): server never trusts a client-supplied
-- mode. Phase B's /payment-methods function reads admin_active_mode server-side
-- to determine live vs test for SetupIntent creation and detach calls.
-- =============================================================


-- =============================================================
-- 1. profiles.admin_active_mode
-- =============================================================
ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS admin_active_mode TEXT NOT NULL DEFAULT 'test'
        CHECK (admin_active_mode IN ('test','live_comp','live_charge'));

COMMENT ON COLUMN public.profiles.admin_active_mode IS
    'Server-trusted admin toolbar state. Only profiles.role=''admin'' can move '
    'this off ''test'' via the set_admin_active_mode() RPC. Non-admins always '
    'read ''test''. Per Phase B proposal B2 fix / Rule 14 — never trust client '
    'for mode selection. Read by /payment-methods, AppHeader admin toolbar, '
    'and any future Phase C/E surface that needs the active mode.';


-- =============================================================
-- 2. set_admin_active_mode() — guarded mutator
--
-- SECURITY DEFINER so the role check happens in the function body rather
-- than via RLS on the column (the column is part of profiles which has
-- existing per-user-row RLS; we want admins to UPDATE their own row only,
-- and only admins, and only to a valid value).
-- =============================================================
CREATE OR REPLACE FUNCTION public.set_admin_active_mode(new_mode TEXT)
RETURNS TEXT
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
        RAISE EXCEPTION 'Only admin users can set admin_active_mode';
    END IF;

    IF new_mode NOT IN ('test','live_comp','live_charge') THEN
        RAISE EXCEPTION 'Invalid admin_active_mode: %', new_mode;
    END IF;

    UPDATE profiles SET admin_active_mode = new_mode WHERE id = caller_id;
    RETURN new_mode;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_admin_active_mode(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.set_admin_active_mode(TEXT) TO authenticated;

COMMENT ON FUNCTION public.set_admin_active_mode(TEXT) IS
    'Admin toolbar setter. SECURITY DEFINER + role check + value check. '
    'Returns the new mode on success; RAISEs on auth/role/value error. '
    'Called by AppHeader admin toolbar on toggle click.';


-- =============================================================
-- 3. Indexes for stripe-webhook user lookup
--
-- Webhook handler does: SELECT id FROM profiles WHERE stripe_customer_id_{mode} = $1
-- on every payment_method.attached / .detached / setup_intent.succeeded event
-- (and every charge.succeeded / charge.refunded in Phase C+). Partial indexes
-- (only rows with a non-NULL customer id) keep them tight.
-- =============================================================
CREATE INDEX IF NOT EXISTS idx_profiles_stripe_customer_test
    ON public.profiles (stripe_customer_id_test)
    WHERE stripe_customer_id_test IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_stripe_customer_live
    ON public.profiles (stripe_customer_id_live)
    WHERE stripe_customer_id_live IS NOT NULL;
