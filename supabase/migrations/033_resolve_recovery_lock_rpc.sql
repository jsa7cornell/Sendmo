-- =============================================================
-- Migration 033 — resolve_recovery_lock RPC (H2 cap-check serialization)
--
-- Decided proposal:
--   proposals/2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_decided-2026-05-22.md
--     §N2 (cap-math race condition) + ## Decision D2 (technical fixes accepted).
-- Handoff plan:
--   proposals/2026-05-23_pre-launch-handoff-plan.md §Package H2.
--
-- Why this RPC exists:
--   The H2 carrier-adjustment recovery engine reads three sums (per-shipment
--   lifetime, per-card-24h, per-user-7d) inside a single transaction with a
--   FOR UPDATE row-lock on the shipments row. Without serialization, two
--   adjustments arriving within ~100ms can both read "current sum = $0" and
--   both pass the per-shipment $10 cap, recharging the shipment for $11+ in
--   total — exactly the failure §3.7's caps were written to prevent.
--
--   Supabase's JS client doesn't expose explicit BEGIN/COMMIT, so we wrap
--   the lock + reads in a SECURITY DEFINER plpgsql function. The caller
--   (_shared/adjustments.ts:resolveRecovery) invokes via supabase.rpc().
--
-- Surface:
--   resolve_recovery_lock(
--     p_shipment_id        UUID,
--     p_payment_method_id  TEXT,
--     p_user_id            UUID
--   ) → JSONB { shipment_lifetime: BIGINT, card_24h: BIGINT, user_7d: BIGINT }
--
--   shipment_lifetime: sum of carrier_adjustment-type transaction amounts
--                      for this shipment (signed; should be summed by abs() in app code).
--   card_24h:          sum of charge-type transactions for adjustments on
--                      this payment_method in the trailing 24 hours.
--   user_7d:           sum of charge-type transactions for adjustments by
--                      this user_id in the trailing 7 days.
--
--   "Adjustments" are identified by idempotency_key LIKE 'adjustment\_%'
--   (the createAdjustmentRecharge key prefix). The escape character is
--   doubled because PostgreSQL's LIKE treats backslash as literal by default
--   in unescaped mode.
--
-- Failure modes:
--   - shipment row missing → returns all-zeros (the caller will then either
--     flag with a no_shipment reason or fall back to the unlocked path).
--   - any unexpected error → propagates; the caller's RPC wrapper logs and
--     falls back to the per-shipment-only unlocked path.
-- =============================================================

CREATE OR REPLACE FUNCTION public.resolve_recovery_lock(
    p_shipment_id       UUID,
    p_payment_method_id TEXT,
    p_user_id           UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_shipment_lifetime BIGINT;
    v_card_24h          BIGINT;
    v_user_7d           BIGINT;
BEGIN
    -- Lock the shipments row to serialize concurrent resolveRecovery calls
    -- that target the same shipment. Other transactions that PERFORM the
    -- same SELECT ... FOR UPDATE will block until this function returns;
    -- queries that don't FOR UPDATE the row (e.g. the user's tracking page)
    -- are unaffected. The lock is released when the implicit transaction
    -- around this function call commits.
    PERFORM 1 FROM public.shipments WHERE id = p_shipment_id FOR UPDATE;

    -- Per-shipment lifetime sum of carrier_adjustment rows.
    SELECT COALESCE(SUM(amount_cents), 0)
        INTO v_shipment_lifetime
        FROM public.transactions
        WHERE type = 'carrier_adjustment'
          AND shipment_id = p_shipment_id;

    -- Per-card 24h sum of adjustment recharges. Joins through stripe_intents
    -- since transactions.idempotency_key carries the adjustment prefix and
    -- the actual payment_method_id lives in the PI metadata. We approximate
    -- by joining stripe_intents (which carries payment_method_id) to the
    -- charge transactions written by stripe-webhook.
    SELECT COALESCE(SUM(t.amount_cents), 0)
        INTO v_card_24h
        FROM public.transactions t
        JOIN public.stripe_intents si
          ON si.stripe_payment_intent_id = t.stripe_intent_id
        WHERE t.type = 'charge'
          AND t.idempotency_key LIKE 'adjustment\_%' ESCAPE '\'
          AND si.payment_method_id = p_payment_method_id
          AND t.created_at > now() - interval '24 hours';

    -- Per-user 7d sum of adjustment recharges.
    SELECT COALESCE(SUM(amount_cents), 0)
        INTO v_user_7d
        FROM public.transactions
        WHERE type = 'charge'
          AND idempotency_key LIKE 'adjustment\_%' ESCAPE '\'
          AND user_id = p_user_id
          AND created_at > now() - interval '7 days';

    RETURN jsonb_build_object(
        'shipment_lifetime', v_shipment_lifetime,
        'card_24h',          v_card_24h,
        'user_7d',           v_user_7d
    );
END;
$$;

COMMENT ON FUNCTION public.resolve_recovery_lock(UUID, TEXT, UUID) IS
    'Cap-check helper for H2 carrier-adjustment recovery. Locks the shipments '
    'row (FOR UPDATE) then returns the three cap sums (shipment lifetime, '
    'per-card 24h, per-user 7d) inside the same transaction. SECURITY DEFINER '
    'so it can read from transactions / stripe_intents under service_role '
    'context. Caller: supabase/functions/_shared/adjustments.ts:resolveRecovery.';

-- service_role can call; anon and authenticated cannot.
REVOKE ALL ON FUNCTION public.resolve_recovery_lock(UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_recovery_lock(UUID, TEXT, UUID) TO service_role;
