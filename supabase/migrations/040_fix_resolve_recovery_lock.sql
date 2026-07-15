-- =============================================================
-- Migration 040 — fix resolve_recovery_lock RPC (H2 repair, bugs 5 & 7)
--
-- Decided proposal:
--   proposals/2026-07-15_h2-carrier-adjustment-repair_reviewed-2026-07-15_decided-2026-07-15.md
--     §3 (cap semantics: all three caps count recharge charges) + Review B1/B2/B3.
--   Supersedes the RPC body from migration 033 (which applied clean but threw at
--   runtime — see below).
--
-- Two fixes, landed together (Review B3: they MUST be atomic — fixing only one
-- re-introduces the other bug on the newly-live RPC path):
--
--   Bug 7 — the per-card join referenced a nonexistent column. 033 wrote
--     `JOIN stripe_intents si ON si.stripe_payment_intent_id = t.stripe_intent_id`
--     but stripe_intents has no `stripe_payment_intent_id` column (it is
--     `stripe_intent_id`). plpgsql resolves column names at EXECUTION, so 033
--     applied fine but every call raised 42703 → the caller
--     (_shared/adjustments.ts) caught it and fell to the unlocked per-shipment
--     fallback on EVERY call. The N2 FOR UPDATE serialization has therefore never
--     run in production. Fixed: `si.stripe_intent_id = t.stripe_intent_id`.
--
--   Bug 5 — the per-shipment sum counted SendMo's COST rows, not the customer
--     recharges. 033's per-shipment sum read `type='carrier_adjustment'` (the
--     negative cost row the webhook writes BEFORE the cap check), so a lone $5
--     adjustment double-counted (its own -500 cost row + the prospective +600
--     recharge = 1100 > the $10 cap) and false-flagged. The decided reconciliation
--     proposal §2.4 defines all three caps on the customer-RECHARGE side
--     ("auto-recharged adjustments" / "adjustment re-charges"), never on cost
--     rows. Fixed: the per-shipment sum now counts recharge charges on the same
--     basis as the per-card / per-user sums — `type='charge'` AND
--     `idempotency_key LIKE 'adjustment\_%'`. The current adjustment's own
--     recharge row does not exist yet at check time (it is written by
--     stripe-webhook when the PI succeeds), so it is correctly excluded.
--
-- The recharge ledger row is written by stripe-webhook's payment_intent.succeeded
-- arm with idempotency_key = `adjustment_<shipment>_<carrier_adjustment>_<attempt>`
-- (see the same-PR stripe-webhook change), which is what makes the `adjustment\_%`
-- LIKE filter match real rows — closing bug 6 for all three caps at once.
--
-- Surface, grants, SECURITY DEFINER, and search_path are identical to 033.
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
    -- Serialize concurrent resolveRecovery calls on the same shipment (N2).
    PERFORM 1 FROM public.shipments WHERE id = p_shipment_id FOR UPDATE;

    -- Per-shipment lifetime sum of adjustment RECHARGE charges (not cost rows).
    SELECT COALESCE(SUM(amount_cents), 0)
        INTO v_shipment_lifetime
        FROM public.transactions
        WHERE type = 'charge'
          AND idempotency_key LIKE 'adjustment\_%' ESCAPE '\'
          AND shipment_id = p_shipment_id;

    -- Per-card 24h sum of adjustment recharges. Joins stripe_intents (which
    -- carries payment_method_id) to the charge rows via the real column,
    -- stripe_intent_id (bug 7 fix — was the nonexistent stripe_payment_intent_id).
    SELECT COALESCE(SUM(t.amount_cents), 0)
        INTO v_card_24h
        FROM public.transactions t
        JOIN public.stripe_intents si
          ON si.stripe_intent_id = t.stripe_intent_id
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
    'per-card 24h, per-user 7d), ALL measured on the customer-recharge side '
    '(type=charge, idempotency_key LIKE ''adjustment_%''), inside one transaction. '
    'Supersedes migration 033 (fixed bug 5 cost-row double-count + bug 7 '
    'nonexistent-column join). Caller: _shared/adjustments.ts:resolveRecovery.';

REVOKE ALL ON FUNCTION public.resolve_recovery_lock(UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_recovery_lock(UUID, TEXT, UUID) TO service_role;
