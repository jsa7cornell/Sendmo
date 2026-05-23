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
//                    (positive; cash in). Two writers, both keyed on the
//                    EasyPost Refund object id (rfnd_…) per B4 of the review:
//                      • webhooks function — refund.successful push event
//                      • tracking function — lazy poll when user visits /t/<code>
//                    Idempotency key = 'easypost_refund_<refund_object_id>' ensures
//                    the three writers (webhook, poll, hypothetical retry) converge
//                    on a single row — UNIQUE collision is the expected safe no-op.
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
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
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
//
// Idempotency key = 'easypost_refund_<refund_object_id>' (keyed on the EasyPost
// Refund object id, NOT the shipment id — B4 fix from the decided proposal).
// This guarantees exactly one row per EasyPost refund event, even across the
// two writers racing on the same event.
//
// amount_cents: positive (SendMo gains back the label cost).
// If the refund amount cannot be sourced from the EasyPost payload, falls back
// to rate_cents (the declared EasyPost label cost at label-buy time).

export interface EasypostRefundParams {
    supabase: SupabaseClient;
    sessionId: string;
    shipmentId: string;                 // UUID
    userId: string;
    linkId: string | null;
    easypostShipmentId: string;         // 'shp_…' (for description / logging)
    easypostRefundObjectId: string;     // 'rfnd_…' — the idempotency key anchor
    refundAmountCents: number;          // positive — cash in
    mode: "test" | "live";
    isComp: boolean;
    source: "webhook" | "tracking_poll";
}

export async function writeEasypostRefund(
    params: EasypostRefundParams,
): Promise<{ ok: boolean; error?: string }> {
    const {
        supabase, sessionId, shipmentId, userId, linkId,
        easypostShipmentId, easypostRefundObjectId, refundAmountCents,
        mode, isComp, source,
    } = params;

    const amountCents = Math.abs(refundAmountCents);    // positive — cash in
    const idempotencyKey = `easypost_refund_${easypostRefundObjectId}`;
    const fundingSource = isComp ? "comp" : null;

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
