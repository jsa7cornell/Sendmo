// _shared/ledger.ts
//
// Bidirectional ledger writers — H1 of the pre-launch P1 build.
// Decided proposal:
//   proposals/2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_decided-2026-05-22.md
// Handoff plan:
//   proposals/2026-05-23_pre-launch-handoff-plan.md §Package H1
//
// Two new transaction types (admitted by migration 032):
//   label_cost     — SendMo paid EasyPost for the label (negative; cash out).
//                    Sole writer: labels function, at label-buy time.
//   easypost_refund— EasyPost credited SendMo on a confirmed carrier void
//                    (positive; cash in). THREE writers, all keyed on the
//                    EasyPost Refund object id (rfnd_…) per B4 of the review:
//                      • webhooks function — refund.successful push event
//                      • tracking function — lazy poll when user visits /t/<code>
//                      • cron-refund-sweep — 21-day stale-'submitted' resolver
//                    Idempotency key = 'easypost_refund_<refund_object_id>' ensures
//                    all writers converge on a single row — UNIQUE collision is
//                    the expected safe no-op.
//
// Design decisions:
//   - Writers are ADDITIVE — they do not break existing behavior. A failed
//     ledger write must never break the calling operation (label-buy or refund).
//     Both functions wrap their INSERT in try/catch and log a severity=error
//     event_logs row on failure.
//   - Type-only import for SupabaseClient follows the budget.ts precedent
//     (2026-05-23 LOG entry) so Vitest can import this file directly with a
//     typed mock client.
//
// PLAYBOOK Rule 16 (amended migration 032): this module is the SOLE PLACE
// where label_cost and easypost_refund rows are constructed. Do not inline
// INSERT logic elsewhere — extend these helpers instead.

// Type-only import — Vitest's TS transform erases this so no remote URL
// resolution is needed in the test environment.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.97.0";
import { log } from "./logger.ts";

// ─── writeLabelCost ───────────────────────────────────────────────────────────
//
// Called by labels/index.ts immediately after admin_insert_shipment succeeds.
// Wraps the INSERT in try/catch — a failed ledger write must not break
// label-buy. The caller awaits this but the function never throws; it returns
// { ok: true } on success, { ok: false, error } on failure.
//
// amount_cents: -rate_cents  (negative — SendMo paid EasyPost)
// idempotency_key: 'label_cost_<easypost_shipment_id>' — per EasyPost
//   shipment, deduplicates any retry scenario.

export interface LabelCostParams {
    supabase: SupabaseClient;
    sessionId: string;
    shipmentId: string;           // UUID from admin_insert_shipment
    userId: string;               // owner (resolvedLink.user_id ?? callerUserId ?? system)
    linkId: string | null;
    easypostShipmentId: string;   // 'shp_…' — part of the idempotency key
    rateCents: number;            // positive; amount_cents will be negated
    mode: "test" | "live";
    isComp: boolean;              // comp = no Stripe; funding_source = 'comp' | null
}

export async function writeLabelCost(
    params: LabelCostParams,
): Promise<{ ok: boolean; error?: string }> {
    const {
        supabase, sessionId, shipmentId, userId, linkId,
        easypostShipmentId, rateCents, mode, isComp,
    } = params;

    const amountCents = -Math.abs(rateCents);   // negative — cash out
    const idempotencyKey = `label_cost_${easypostShipmentId}`;
    const fundingSource = isComp ? "comp" : null;

    try {
        const { error: txErr } = await supabase.from("transactions").insert({
            user_id: userId,
            shipment_id: shipmentId,
            link_id: linkId,
            type: "label_cost",
            amount_cents: amountCents,
            funding_source: fundingSource,
            mode,
            idempotency_key: idempotencyKey,
            description: `EasyPost label cost — shipment ${easypostShipmentId}`,
        });

        if (txErr) {
            // UNIQUE collision (idempotency_key already exists) — safe no-op.
            // Postgres error code 23505 = unique_violation.
            if (txErr.code === "23505") {
                log({
                    event_type: "ledger.label_cost_duplicate",
                    session_id: sessionId,
                    severity: "info",
                    entity_type: "transaction",
                    entity_id: shipmentId,
                    properties: { idempotency_key: idempotencyKey, easypost_shipment_id: easypostShipmentId },
                });
                return { ok: true };
            }
            // Real error — log but don't throw.
            log({
                event_type: "ledger.label_cost_error",
                session_id: sessionId,
                severity: "error",
                entity_type: "transaction",
                entity_id: shipmentId,
                properties: {
                    error_message: txErr.message,
                    error_code: txErr.code ?? null,
                    idempotency_key: idempotencyKey,
                    easypost_shipment_id: easypostShipmentId,
                    amount_cents: amountCents,
                },
            });
            return { ok: false, error: txErr.message };
        }

        log({
            event_type: "ledger.label_cost_recorded",
            session_id: sessionId,
            severity: "info",
            entity_type: "transaction",
            entity_id: shipmentId,
            properties: {
                amount_cents: amountCents,
                rate_cents: rateCents,
                mode,
                idempotency_key: idempotencyKey,
            },
        });
        return { ok: true };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log({
            event_type: "ledger.label_cost_unhandled",
            session_id: sessionId,
            severity: "error",
            entity_type: "transaction",
            entity_id: shipmentId,
            properties: { error_message: msg, easypost_shipment_id: easypostShipmentId },
        });
        return { ok: false, error: msg };
    }
}

// ─── writeEasypostRefund ──────────────────────────────────────────────────────
//
// Called by:
//   • webhooks/index.ts — in the refund.successful arm, after the existing
//     easypost_refund_status update. Refund object id from payload.result.id.
//   • tracking/index.ts — in the lazy-poll refund branch when epRefundStatus
//     === 'refunded'. Refund object id from epShip.refunds[0].id.
//   • cron-refund-sweep/index.ts — when the 21-day resolver finds EP already
//     reporting 'refunded'. Refund object id from epShip.refunds[0].id.
//
// Idempotency key = 'easypost_refund_<refund_object_id>' (keyed on the EasyPost
// Refund object id, NOT the shipment id — B4 fix from the decided proposal).
// This guarantees exactly one row per EasyPost refund event, even across
// writers racing on the same event.
//
// amount_cents: positive (SendMo gains back the label cost). Sourced here —
// not by callers — via resolveEasypostRefundAmountCents: payload amount when
// present and a positive number, else rate_cents (the declared EasyPost label
// cost at buy time). EasyPost Refund objects carry NO amount field (confirmed
// empirically 2026-07-06), so rate_cents is the norm-case amount, and since
// label_cost is written as -rate_cents the pair cancels exactly in the
// net-margin identity. A resolved 0¢ amount (rate_cents missing too) is
// written for ledger completeness but logged as a warn — the reconciliation
// sweep flags live 0¢ rows for manual backfill.

// Pure amount-sourcing helper — exported for direct unit coverage.
// Guards the two payload hazards the 2026-07-06 review confirmed: a truthy
// non-numeric amount (parseFloat → NaN would violate amount_cents NOT NULL
// and silently drop the row) and a zero-string amount ('0.00' is truthy).
export function resolveEasypostRefundAmountCents(
    payloadAmount: string | number | null | undefined,
    rateCents: number | null | undefined,
): number {
    if (payloadAmount != null) {
        const parsed = parseFloat(String(payloadAmount));
        if (Number.isFinite(parsed) && parsed > 0) {
            return Math.round(parsed * 100);
        }
    }
    return Math.abs(rateCents ?? 0);    // positive — cash in
}

export interface EasypostRefundParams {
    supabase: SupabaseClient;
    sessionId: string;
    shipmentId: string;                 // UUID
    userId: string;
    linkId: string | null;
    easypostShipmentId: string;         // 'shp_…' (for description / logging)
    easypostRefundObjectId: string;     // 'rfnd_…' — the idempotency key anchor
    payloadAmount: string | number | null;  // Refund object's amount, if any (normally absent)
    rateCents: number | null;           // shipments.rate_cents — the norm-case amount
    mode: "test" | "live";
    isComp: boolean;
    source: "webhook" | "tracking_poll" | "cron_refund_sweep";
}

export async function writeEasypostRefund(
    params: EasypostRefundParams,
): Promise<{ ok: boolean; error?: string }> {
    const {
        supabase, sessionId, shipmentId, userId, linkId,
        easypostShipmentId, easypostRefundObjectId, payloadAmount, rateCents,
        mode, isComp, source,
    } = params;

    const amountCents = resolveEasypostRefundAmountCents(payloadAmount, rateCents);
    const idempotencyKey = `easypost_refund_${easypostRefundObjectId}`;
    const fundingSource = isComp ? "comp" : null;

    if (amountCents === 0) {
        log({
            event_type: "ledger.easypost_refund_zero_amount",
            session_id: sessionId,
            severity: "warn",
            entity_type: "transaction",
            entity_id: shipmentId,
            properties: {
                easypost_refund_id: easypostRefundObjectId,
                easypost_shipment_id: easypostShipmentId,
                payload_amount: payloadAmount,
                rate_cents: rateCents,
                mode,
                source,
            },
        });
    }

    try {
        const { error: txErr } = await supabase.from("transactions").insert({
            user_id: userId,
            shipment_id: shipmentId,
            link_id: linkId,
            type: "easypost_refund",
            amount_cents: amountCents,
            funding_source: fundingSource,
            mode,
            idempotency_key: idempotencyKey,
            description: `EasyPost refund confirmed — ${easypostRefundObjectId} (shipment ${easypostShipmentId})`,
        });

        if (txErr) {
            // UNIQUE collision — safe no-op (webhook and poll raced; first writer won).
            if (txErr.code === "23505") {
                log({
                    event_type: "ledger.easypost_refund_duplicate",
                    session_id: sessionId,
                    severity: "info",
                    entity_type: "transaction",
                    entity_id: shipmentId,
                    properties: {
                        idempotency_key: idempotencyKey,
                        easypost_refund_id: easypostRefundObjectId,
                        source,
                    },
                });
                return { ok: true };
            }
            log({
                event_type: "ledger.easypost_refund_error",
                session_id: sessionId,
                severity: "error",
                entity_type: "transaction",
                entity_id: shipmentId,
                properties: {
                    error_message: txErr.message,
                    error_code: txErr.code ?? null,
                    idempotency_key: idempotencyKey,
                    easypost_refund_id: easypostRefundObjectId,
                    easypost_shipment_id: easypostShipmentId,
                    amount_cents: amountCents,
                    source,
                },
            });
            return { ok: false, error: txErr.message };
        }

        log({
            event_type: "ledger.easypost_refund_recorded",
            session_id: sessionId,
            severity: "info",
            entity_type: "transaction",
            entity_id: shipmentId,
            properties: {
                amount_cents: amountCents,
                easypost_refund_id: easypostRefundObjectId,
                mode,
                idempotency_key: idempotencyKey,
                source,
            },
        });
        return { ok: true };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log({
            event_type: "ledger.easypost_refund_unhandled",
            session_id: sessionId,
            severity: "error",
            entity_type: "transaction",
            entity_id: shipmentId,
            properties: {
                error_message: msg,
                easypost_refund_id: easypostRefundObjectId,
                easypost_shipment_id: easypostShipmentId,
                source,
            },
        });
        return { ok: false, error: msg };
    }
}

// ─── writeStripeFee ────────────────────────────────────────────────────────
//
// Records Stripe's processing fee on a successful charge. Called by:
//   • stripe-webhook/index.ts — in the payment_intent.succeeded arm, after
//     the existing +charge ledger insert. We retrieve the charge with
//     ?expand[]=balance_transaction to source the fee directly from Stripe's
//     canonical BalanceTransaction object (rather than computing it).
//
// Idempotency key = 'fee_stripe_<balance_transaction_id>'. The BT id is
// unique per money movement, so this dedupes any retry / replay.
//
// amount_cents: negative (SendMo paid Stripe — cash out, mirrors label_cost
// semantics on the EasyPost side).
//
// Per PLAYBOOK Rule 16 (amended): this module is the SOLE PLACE where
// fee_stripe rows are constructed. Do not inline INSERT logic elsewhere —
// extend this helper instead.

export interface StripeFeeParams {
    supabase: SupabaseClient;
    sessionId: string;
    shipmentId: string | null;        // null when fee precedes a labels-row mint
    userId: string;
    linkId: string | null;
    stripeIntentId: string;           // 'pi_…' — for join symmetry with charge row
    balanceTransactionId: string;     // 'txn_…' — the idempotency anchor
    feeCents: number;                 // positive — Stripe's reported fee
    mode: "test" | "live";
    isComp: boolean;
}

export async function writeStripeFee(
    params: StripeFeeParams,
): Promise<{ ok: boolean; error?: string }> {
    const {
        supabase, sessionId, shipmentId, userId, linkId,
        stripeIntentId, balanceTransactionId, feeCents, mode, isComp,
    } = params;

    const amountCents = -Math.abs(feeCents);    // negative — cash out
    const idempotencyKey = `fee_stripe_${balanceTransactionId}`;
    const fundingSource = isComp ? "comp" : null;

    try {
        const { error: txErr } = await supabase.from("transactions").insert({
            user_id: userId,
            shipment_id: shipmentId,
            link_id: linkId,
            stripe_intent_id: stripeIntentId,
            type: "fee_stripe",
            amount_cents: amountCents,
            funding_source: fundingSource,
            mode,
            idempotency_key: idempotencyKey,
            description: `Stripe processing fee — ${balanceTransactionId} (intent ${stripeIntentId})`,
        });

        if (txErr) {
            if (txErr.code === "23505") {
                log({
                    event_type: "ledger.fee_stripe_duplicate",
                    session_id: sessionId,
                    severity: "info",
                    entity_type: "transaction",
                    entity_id: shipmentId,
                    properties: {
                        idempotency_key: idempotencyKey,
                        balance_transaction_id: balanceTransactionId,
                        stripe_intent_id: stripeIntentId,
                    },
                });
                return { ok: true };
            }
            log({
                event_type: "ledger.fee_stripe_error",
                session_id: sessionId,
                severity: "error",
                entity_type: "transaction",
                entity_id: shipmentId,
                properties: {
                    error_message: txErr.message,
                    error_code: txErr.code ?? null,
                    idempotency_key: idempotencyKey,
                    balance_transaction_id: balanceTransactionId,
                    stripe_intent_id: stripeIntentId,
                    amount_cents: amountCents,
                },
            });
            return { ok: false, error: txErr.message };
        }

        log({
            event_type: "ledger.fee_stripe_recorded",
            session_id: sessionId,
            severity: "info",
            entity_type: "transaction",
            entity_id: shipmentId,
            properties: {
                amount_cents: amountCents,
                fee_cents: feeCents,
                balance_transaction_id: balanceTransactionId,
                stripe_intent_id: stripeIntentId,
                mode,
                idempotency_key: idempotencyKey,
            },
        });
        return { ok: true };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log({
            event_type: "ledger.fee_stripe_unhandled",
            session_id: sessionId,
            severity: "error",
            entity_type: "transaction",
            entity_id: shipmentId,
            properties: {
                error_message: msg,
                balance_transaction_id: balanceTransactionId,
                stripe_intent_id: stripeIntentId,
            },
        });
        return { ok: false, error: msg };
    }
}
