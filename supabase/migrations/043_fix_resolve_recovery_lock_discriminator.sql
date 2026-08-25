-- =============================================================
-- Migration 043 — repair resolve_recovery_lock (033)
--
-- Found 2026-08-24 by auditing production event_logs by severity, after the
-- checkout-404 incident prompted a sweep for guards that fail quietly.
--
-- TWO defects, either of which alone disables two of the three H2 spend caps:
--
--  1. WRONG COLUMN. 033 joined `stripe_intents si ON si.stripe_payment_intent_id
--     = t.stripe_intent_id`. That column does not exist — the table's column is
--     `stripe_intent_id`. Every call raised Postgres 42703, which
--     _shared/adjustments.ts catches and logs as
--     `adjustment.cap_lock_rpc_unavailable` before falling through to the
--     unlocked path. 41 such rows, every night, since 033 deployed.
--
--  2. WRONG DISCRIMINATOR — the one that survives fixing #1. Both cap queries
--     selected adjustment charges with `idempotency_key LIKE 'adjustment\_%'`.
--     That prefix is the **Stripe** idempotency key minted by
--     createAdjustmentRecharge (_shared/stripe.ts) for the PaymentIntent. It is
--     never written to `transactions.idempotency_key` — the ledger's charge rows
--     are keyed `stripe.evt_<id>:charge` by stripe-webhook. The two namespaces
--     were conflated. Verified against production: ZERO rows in `transactions`
--     match that prefix, across every transaction type.
--
--     So even with the column fixed, card_24h and user_7d would have returned 0
--     forever — the caps would have gone from loudly broken to silently absent.
--
-- The durable discriminator is the PaymentIntent's role, which
-- createAdjustmentRecharge stamps as metadata `intent_role:
-- 'carrier_adjustment'` and stripe-webhook persists to
-- `stripe_intents.intent_role`. That is a column we own, populated on the same
-- write path as the charge row itself.
--
-- Net effect: restores the per-card-24h and per-user-7d caps, which have never
-- been enforced in production. The per-shipment cap was unaffected throughout
-- (it keys off type='carrier_adjustment' + shipment_id) and is why no recharge
-- has actually escaped.
--
-- Surface is unchanged from 033 — same name, args, and return shape, so
-- _shared/adjustments.ts needs no signature change.
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
    -- Serialize concurrent resolveRecovery calls for this shipment. Released
    -- when the implicit transaction around the function call commits.
    PERFORM 1 FROM public.shipments WHERE id = p_shipment_id FOR UPDATE;

    -- Per-shipment lifetime sum of carrier_adjustment rows. (Unchanged from
    -- 033 — this cap has always worked.)
    SELECT COALESCE(SUM(amount_cents), 0)
        INTO v_shipment_lifetime
        FROM public.transactions
        WHERE type = 'carrier_adjustment'
          AND shipment_id = p_shipment_id;

    -- Per-card 24h sum of adjustment recharges. Joined on the real column and
    -- discriminated by intent_role rather than a Stripe-side idempotency key
    -- that never reaches this table.
    SELECT COALESCE(SUM(t.amount_cents), 0)
        INTO v_card_24h
        FROM public.transactions t
        JOIN public.stripe_intents si
          ON si.stripe_intent_id = t.stripe_intent_id
        WHERE t.type = 'charge'
          AND si.intent_role = 'carrier_adjustment'
          AND si.payment_method_id = p_payment_method_id
          AND t.created_at > now() - interval '24 hours';

    -- Per-user 7d sum of adjustment recharges. Same discriminator; scoped by
    -- the ledger's own user_id so a user with several cards is still capped.
    SELECT COALESCE(SUM(t.amount_cents), 0)
        INTO v_user_7d
        FROM public.transactions t
        JOIN public.stripe_intents si
          ON si.stripe_intent_id = t.stripe_intent_id
        WHERE t.type = 'charge'
          AND si.intent_role = 'carrier_adjustment'
          AND t.user_id = p_user_id
          AND t.created_at > now() - interval '7 days';

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
    'per-card 24h, per-user 7d) inside the same transaction. Adjustment charges '
    'are identified by stripe_intents.intent_role = ''carrier_adjustment'' — NOT '
    'by an idempotency_key prefix, which is Stripe-side and never lands in '
    'transactions (repaired in 043). Caller: _shared/adjustments.ts:resolveRecovery.';

REVOKE ALL ON FUNCTION public.resolve_recovery_lock(UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_recovery_lock(UUID, TEXT, UUID) TO service_role;
