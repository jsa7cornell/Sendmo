-- =============================================================
-- SendMo — Pattern D execution (Stripe Phase F)
-- Migration: 024_pattern_d_stripe_intents_link_state_events.sql
--
-- Decided proposal:
--   proposals/2026-05-16_flex-payment-pattern-d-execution_reviewed-2026-05-16_decided-2026-05-18.md
--   §3.1 schema; §2.2 is_funded query; §2.4 failure logging surfaces.
--
-- WHAT THIS DOES (atomic — single transaction):
--   1. ALTER stripe_intents    → add payment_method_id, cancellation_reason,
--                                last_payment_error_code (failure-logging surfaces)
--   2. ALTER sendmo_links      → add last_decline_email_at (dedup gate per
--                                proposal §2.4)
--   3. CREATE link_state_events → audit trail for flex link lifecycle
--                                 transitions (charge_failed, pm_detached,
--                                 rotated, etc.); RLS inline
--   4. UPDATE COMMENT ON holds → mark reserved for Phase 3 escrow; flex no
--                                longer writes here
--   5. Backfill legacy flex links: status='in_use' → 'active' (Pattern D
--      keeps flex links permanently 'active'; in_use was a Phase E artifact)
--
-- ROLLBACK STORY: Postgres' implicit migration transaction. Either we land
-- at 024 cleanly or we're back at 023. No partial state.
-- =============================================================


-- =============================================================
-- 1. stripe_intents — failure logging surfaces
-- =============================================================
ALTER TABLE public.stripe_intents
    ADD COLUMN IF NOT EXISTS payment_method_id      TEXT,
    ADD COLUMN IF NOT EXISTS cancellation_reason    TEXT,
    ADD COLUMN IF NOT EXISTS last_payment_error_code TEXT;

COMMENT ON COLUMN public.stripe_intents.payment_method_id IS
    'Stripe PaymentMethod id. Populated for off_session shipment PIs '
    '(via metadata + Stripe response) and for SetupIntents (via '
    'payment_method.attached webhook). Used by Pattern D queries that '
    'need "current state of this PM" without a Stripe round-trip.';
COMMENT ON COLUMN public.stripe_intents.cancellation_reason IS
    'Populated when status=''canceled''. From Stripe PI/SI '
    'cancellation_reason field. Helps diagnose abandoned vs auto-expired '
    'vs explicitly-canceled PIs.';
COMMENT ON COLUMN public.stripe_intents.last_payment_error_code IS
    'Populated when status=''failed''. Stripe decline_code or error.code. '
    'Per-decline analytics surface (proposal §2.4) — used to evaluate '
    'whether strict Pattern D is missing what Pattern D'' (ZDA verification) '
    'would have caught at link creation.';

CREATE INDEX IF NOT EXISTS idx_stripe_intents_payment_method
    ON public.stripe_intents (payment_method_id)
    WHERE payment_method_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stripe_intents_failed_recent
    ON public.stripe_intents (mode, created_at DESC)
    WHERE status = 'failed';


-- =============================================================
-- 2. sendmo_links — decline email dedup gate
-- =============================================================
ALTER TABLE public.sendmo_links
    ADD COLUMN IF NOT EXISTS last_decline_email_at TIMESTAMPTZ;

COMMENT ON COLUMN public.sendmo_links.last_decline_email_at IS
    'Timestamp of the last payment_declined_reactivate email sent to the '
    'recipient for this link. Gate for per-(link_id, day) email dedup '
    '(proposal §2.4). Prevents a fraud probe of a stale link from '
    'flooding the recipient with duplicate notifications. NULL means no '
    'decline email has been sent for this link.';


-- =============================================================
-- 3. link_state_events — flex link lifecycle audit trail
-- =============================================================
CREATE TABLE IF NOT EXISTS public.link_state_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    link_id     UUID NOT NULL REFERENCES public.sendmo_links(id) ON DELETE CASCADE,
    event       TEXT NOT NULL CHECK (event IN (
                  'created',           -- link inserted (status='draft')
                  'activated',         -- first PM attached + link flipped to active
                  'reactivated',       -- recipient added card after decline-induced inactive
                  'charge_failed',     -- off_session shipment PI declined
                  'pm_detached',       -- recipient's only/default PM was detached
                  'pm_expired',        -- default PM's stored exp passed
                  'rotated',           -- recipient rotated the short_code (old marked cancelled)
                  'cancelled_by_user'  -- recipient explicitly deactivated
                )),
    reason      TEXT,                  -- Stripe decline_code / error message / context
    actor_user  UUID REFERENCES public.profiles(id),
    metadata    JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.link_state_events IS
    'Append-only audit trail for flex link lifecycle transitions. Read by '
    'support diagnostics and (future) fraud-burst counters. Per proposal '
    '§3.1 — events emitted from labels Edge Function (charge_failed), '
    'stripe-webhook (pm_detached, pm_expired), links Edge Function '
    '(rotated, activated), and Dashboard (cancelled_by_user, reactivated).';

CREATE INDEX IF NOT EXISTS idx_lse_link_time
    ON public.link_state_events (link_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lse_event_time
    ON public.link_state_events (event, created_at DESC);

-- RLS
ALTER TABLE public.link_state_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role full" ON public.link_state_events
    FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "user reads own" ON public.link_state_events
    FOR SELECT TO authenticated
    USING (link_id IN (SELECT id FROM public.sendmo_links WHERE user_id = auth.uid()));


-- =============================================================
-- 4. holds — mark reserved for Phase 3 escrow
-- =============================================================
COMMENT ON TABLE public.holds IS
    'Reserved for Phase 3 escrow per master Stripe proposal §3.8. Flex flow no longer writes here as of migration 024 (Pattern D pivot). Legacy rows from Phase E commit ab92b3d may exist and are no-ops under Pattern D semantics.';


-- =============================================================
-- 5. Backfill: legacy flex links flipped to 'in_use' by Phase E shipments
--    revert to 'active'. Pattern D keeps flex links permanently 'active'
--    (reusable; the active→in_use transition has been removed from
--    labels/index.ts in this same PR).
-- =============================================================
UPDATE public.sendmo_links
SET status = 'active'
WHERE link_type = 'flexible'
  AND status = 'in_use';
