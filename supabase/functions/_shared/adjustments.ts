// _shared/adjustments.ts
//
// Carrier-adjustment tiered-recovery engine — H2 of the pre-launch P1 build.
// Decided proposal:
//   proposals/2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_decided-2026-05-22.md
//     §2.4 (tiered policy) | D2 (technical fixes — N2 race guard, N5 send-site)
// Handoff plan:
//   proposals/2026-05-23_pre-launch-handoff-plan.md §Package H2
//
// Public surface:
//   resolveRecovery(supabase, shipment, deltaCents, paymentContext)
//     → { decision, amount_cents, blocked_by_cap?, reason }
//
// Tiered decision (delta_cents signed; + = carrier billed more):
//   delta_cents ≤ $1               → absorb
//   $1.01 ≤ delta_cents ≤ $10      → recharge for delta + $1 handling fee
//   delta_cents > $10              → flag (manual review in Reconciliation tab)
//   delta_cents < 0 (carrier credit) → absorb (credit lands in wallet; record only)
//   comp shipment (no PI / customer) → absorb (no customer to charge)
//   no usable saved PM             → flag
//
// Caps (auto-recharge tier only — manual admin overrides bypass):
//   ≤ $10 per shipment lifetime    (per shipment_id)
//   ≤ $20 per card per 24h         (per payment_method_id)
//   ≤ $50 per user per 7d          (per user_id)
//
// Race condition (N2 fix, load-bearing): the cap-math reads sums INSIDE a
// transaction with `SELECT ... FOR UPDATE` on the shipment row, so two
// near-simultaneous adjustments serialize and can't both pass the same cap.
// Without this guard, two adjustments arriving within ~100ms could both read
// "current sum = $0" and both pass the per-shipment-$10 cap, recharging the
// shipment for $11+ total. See pitfall N2 in the decided proposal review.
//
// Adjustment recharges BYPASS checkAccountBudget — the adjustment-specific
// caps govern (per the build-LOG amendment from the decided proposal
// close-out). Account Budget is for prevention of runaway customer charges;
// adjustments are post-pickup carrier corrections that already have their
// own three-cap policy. Documented in this session's LOG entry.
//
// Customer notification email send-site (N5): a successful recharge fires
// `carrierAdjustmentEmail` from this file immediately after the recharge PI
// returns `succeeded`. notifications_log dedup keyed on carrier_adjustment_id.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.97.0";
import { log } from "./logger.ts";
import { createAdjustmentRecharge } from "./stripe.ts";
import { sendEmail } from "./resend.ts";
import { carrierAdjustmentEmail } from "./email-templates.ts";
import { sendAdminAlert } from "./alert.ts";

// Admin-alert base URL for the /admin deep link. Read lazily + guarded so this
// vitest-imported module never touches `Deno` at import time (Deno is undefined
// under Node/Vitest).
function adminAppUrl(): string {
    return (typeof Deno !== "undefined" ? Deno.env.get("APP_URL") : undefined) ?? "https://sendmo.co";
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const ABSORB_THRESHOLD_CENTS = 100;        // ≤ $1.00 = absorb
export const RECHARGE_CEILING_CENTS = 1000;       // > $10.00 = flag
export const HANDLING_FEE_CENTS = 100;            // $1.00 added to every recharge

export const CAP_PER_SHIPMENT_CENTS = 1000;       // $10 lifetime per shipment
export const CAP_PER_CARD_24H_CENTS = 2000;       // $20 / 24h per payment_method
export const CAP_PER_USER_7D_CENTS = 5000;        // $50 / 7d per user_id

// Carrier dispute windows for surfaced Needs-Attention rows (N3 — not used
// in resolveRecovery directly; consumed by the admin Reconciliation surface).
export const DISPUTE_WINDOW_DAYS: Record<string, number> = {
    USPS: 60,
    UPS: 120,
    FedEx: 90,
};

// ─── Public types ─────────────────────────────────────────────────────────────

export interface AdjustmentShipment {
    id: string;                                    // UUID
    public_code: string;
    user_id: string;
    carrier: string | null;
    is_test: boolean;
    stripe_payment_intent_id: string | null;       // null = comp shipment
}

export interface AdjustmentPaymentContext {
    payment_method_id: string | null;              // null = no saved PM
    user_id: string;
    customer_id: string | null;                    // null = no Stripe Customer
}

export type RecoveryDecision = "absorb" | "recharge" | "flag";

export type CapBreachReason =
    | "shipment_lifetime"
    | "24h_card"
    | "7d_user";

export interface RecoveryResolution {
    decision: RecoveryDecision;
    amount_cents: number;                          // 0 for absorb/flag; delta+fee for recharge
    blocked_by_cap?: CapBreachReason;
    reason: string;
}

export interface ResolveRecoveryParams {
    supabase: SupabaseClient;
    sessionId: string;
    shipment: AdjustmentShipment;
    carrierAdjustmentId: string;                   // UUID — anchors the recharge idempotency key
    deltaCents: number;                            // signed; + = carrier billed more
    paymentContext: AdjustmentPaymentContext;
    // Optional pieces consumed by the customer notification email.
    reasonText?: string;                           // EasyPost adjustment_reason
    trackingUrl?: string;                          // /t/<public_code>
    receiptEmail?: string | null;                  // where the carrierAdjustmentEmail goes
    // Test affordances
    attempt?: number;                              // default 1; appended to PI idempotency key
}

// ─── resolveRecovery — the main entrypoint ────────────────────────────────────
//
// Returns the resolution and updates `carrier_adjustments.recovery_status` to
// the resolved state. On a successful recharge:
//   - marks recovery_status='recovered'. It does NOT write the transactions
//     ledger row and does NOT set recovery_tx_id — the recharge PI fires a
//     Stripe `payment_intent.succeeded` webhook, and THAT arm (in
//     stripe-webhook/index.ts) is the sole writer of the `charge` ledger row
//     (PLAYBOOK Rule 16) and patches carrier_adjustments.recovery_tx_id from
//     the PI metadata. Keeping a single durable, Stripe-retried writer avoids a
//     split-writer missing-row hole (decided 2026-07-15 proposal, Review B2).
//     recovery_tx_id is therefore null for the sub-second window until that
//     webhook lands; it self-heals.
//   - fires the customer notification email (N5 send-site).
//
// On flag: updates `recovery_status='pending'` (the default), records the
// cap-breach reason via metadata, surfaces in the Reconciliation tab.
//
// On absorb: updates `recovery_status='absorbed'` immediately.
//
// Failure modes (does NOT throw — wraps everything in try/catch):
//   - Stripe error during recharge → flag with reason; email NOT sent.
//   - DB error during cap-read → flag conservatively (the per-shipment cap
//     trigger remains the backstop).
//   - Email send failure → log severity=warn; recharge still succeeded.

export async function resolveRecovery(
    params: ResolveRecoveryParams,
): Promise<RecoveryResolution> {
    const {
        supabase, sessionId, shipment, carrierAdjustmentId, deltaCents,
        paymentContext, reasonText, trackingUrl, receiptEmail,
        attempt = 1,
    } = params;

    // ── Absorb cases (no cap-check, no charge needed) ─────────────────────────

    // Carrier credit — wallet gains; record only.
    if (deltaCents < 0) {
        const resolution: RecoveryResolution = {
            decision: "absorb",
            amount_cents: 0,
            reason: "carrier_credit",
        };
        await markAdjustmentResolved(supabase, carrierAdjustmentId, "absorbed", null, sessionId);
        return resolution;
    }

    // ≤ $1 → absorb the cost (admin overhead exceeds the recovery).
    if (deltaCents <= ABSORB_THRESHOLD_CENTS) {
        const resolution: RecoveryResolution = {
            decision: "absorb",
            amount_cents: 0,
            reason: "below_floor",
        };
        await markAdjustmentResolved(supabase, carrierAdjustmentId, "absorbed", null, sessionId);
        return resolution;
    }

    // > $10 → flag for admin review; no auto-recharge.
    if (deltaCents > RECHARGE_CEILING_CENTS) {
        const resolution: RecoveryResolution = {
            decision: "flag",
            amount_cents: 0,
            reason: "above_ceiling",
        };
        // Leave recovery_status='pending' (the default); admin handles via
        // /admin Reconciliation tab.
        log({
            event_type: "adjustment.flagged",
            session_id: sessionId,
            severity: "warn",
            entity_type: "carrier_adjustment",
            entity_id: carrierAdjustmentId,
            properties: {
                shipment_id: shipment.id,
                delta_cents: deltaCents,
                reason: "above_ceiling",
            },
        });
        await sendAdjustmentAdminAlert({
            supabase, sessionId, carrierAdjustmentId, shipment,
            variant: "alert", deltaCents, reasonText,
            flagReason: `Over the $${(RECHARGE_CEILING_CENTS / 100).toFixed(0)} auto-recharge ceiling — review manually.`,
        });
        return resolution;
    }

    // Comp shipment — no PI to recharge against.
    if (!shipment.stripe_payment_intent_id) {
        const resolution: RecoveryResolution = {
            decision: "absorb",
            amount_cents: 0,
            reason: "comp_shipment",
        };
        await markAdjustmentResolved(supabase, carrierAdjustmentId, "absorbed", null, sessionId);
        return resolution;
    }

    // No usable saved PM → flag (admin must charge manually).
    if (!paymentContext.payment_method_id || !paymentContext.customer_id) {
        log({
            event_type: "adjustment.no_saved_pm",
            session_id: sessionId,
            severity: "warn",
            entity_type: "carrier_adjustment",
            entity_id: carrierAdjustmentId,
            properties: {
                shipment_id: shipment.id,
                delta_cents: deltaCents,
                has_pm: !!paymentContext.payment_method_id,
                has_customer: !!paymentContext.customer_id,
            },
        });
        await sendAdjustmentAdminAlert({
            supabase, sessionId, carrierAdjustmentId, shipment,
            variant: "alert", deltaCents, reasonText,
            flagReason: "No usable saved card on file — charge the customer manually.",
        });
        return {
            decision: "flag",
            amount_cents: 0,
            reason: "no_saved_pm",
        };
    }

    // ── Cap-checks — read sums INSIDE a transaction with row-level lock (N2) ──
    //
    // The lock target is the shipments row. PostgreSQL's `FOR UPDATE` blocks
    // any concurrent transaction that attempts the same `SELECT ... FOR UPDATE`
    // on the row until this one commits, so two near-simultaneous adjustment
    // arrivals serialize.
    //
    // Implementation note: Supabase's JS client doesn't expose explicit
    // BEGIN/COMMIT, so we drive serialization via the `resolve_recovery_lock`
    // RPC (a SECURITY DEFINER plpgsql function that wraps the row-lock + sum
    // reads in a single transaction). If the RPC isn't available (e.g. local
    // dev hasn't applied the migration yet), we fall back to the unlocked
    // sums + log the degradation — fail-safer than fail-loud since the
    // per-shipment $10 cap is itself a backstop.

    const capCheck = await checkCapsWithLock({
        supabase,
        shipmentId: shipment.id,
        paymentMethodId: paymentContext.payment_method_id,
        userId: paymentContext.user_id,
        deltaCents,
        sessionId,
    });

    if (capCheck.blocked) {
        log({
            event_type: "adjustment.cap_breach",
            session_id: sessionId,
            severity: "warn",
            entity_type: "carrier_adjustment",
            entity_id: carrierAdjustmentId,
            properties: {
                shipment_id: shipment.id,
                delta_cents: deltaCents,
                blocked_by: capCheck.blocked,
                ...(capCheck.sums ? { sums: capCheck.sums } : {}),
            },
        });
        await sendAdjustmentAdminAlert({
            supabase, sessionId, carrierAdjustmentId, shipment,
            variant: "alert", deltaCents, reasonText,
            flagReason: `Recovery cap breached (${capCheck.blocked}) — review before charging.`,
        });
        return {
            decision: "flag",
            amount_cents: 0,
            blocked_by_cap: capCheck.blocked,
            reason: "cap_breach",
        };
    }

    // ── Recharge tier — fire the off_session PI ───────────────────────────────

    const rechargeAmount = deltaCents + HANDLING_FEE_CENTS;

    try {
        const pi = await createAdjustmentRecharge({
            shipmentId: shipment.id,
            publicCode: shipment.public_code,
            carrierAdjustmentId,
            userId: paymentContext.user_id,
            deltaCents,
            attempt,
            paymentMethodId: paymentContext.payment_method_id,
            customerId: paymentContext.customer_id,
            reason: reasonText,
            liveMode: !shipment.is_test,
        });

        if (pi.status !== "succeeded") {
            // Off_session PI didn't auto-capture — likely 3DS required or
            // a soft decline. Treat as flag — admin handles via /admin.
            log({
                event_type: "adjustment.recharge_not_succeeded",
                session_id: sessionId,
                severity: "warn",
                entity_type: "carrier_adjustment",
                entity_id: carrierAdjustmentId,
                properties: {
                    shipment_id: shipment.id,
                    pi_status: pi.status,
                    pi_id: pi.id,
                    delta_cents: deltaCents,
                    recharge_amount: rechargeAmount,
                },
            });
            return {
                decision: "flag",
                amount_cents: 0,
                reason: `recharge_${pi.status}`,
            };
        }

        // Success — mark recovery_status='recovered'. recovery_tx_id stays NULL
        // here; the stripe-webhook payment_intent.succeeded arm writes the
        // `charge` ledger row and patches recovery_tx_id from the PI metadata
        // once Stripe delivers the event (Review B2 — single durable writer).
        await markAdjustmentResolved(
            supabase, carrierAdjustmentId, "recovered", null, sessionId,
        );

        log({
            event_type: "adjustment.recharged",
            session_id: sessionId,
            severity: "info",
            entity_type: "carrier_adjustment",
            entity_id: carrierAdjustmentId,
            properties: {
                shipment_id: shipment.id,
                delta_cents: deltaCents,
                fee_cents: HANDLING_FEE_CENTS,
                recharge_amount: rechargeAmount,
                pi_id: pi.id,
            },
        });

        // ── Customer notification (N5 send-site) ──────────────────────────────
        if (receiptEmail) {
            await sendCarrierAdjustmentEmail({
                supabase,
                sessionId,
                carrierAdjustmentId,
                shipmentId: shipment.id,
                receiptEmail,
                amountCents: rechargeAmount,
                feeCents: HANDLING_FEE_CENTS,
                carrier: shipment.carrier ?? "the carrier",
                reasonText,
                publicCode: shipment.public_code,
                trackingUrl: trackingUrl ?? `https://sendmo.co/t/${shipment.public_code}`,
            });
        }

        // ── Admin ops notice (John requirement 2026-07-15) — live recharges ───
        await sendAdjustmentAdminAlert({
            supabase,
            sessionId,
            carrierAdjustmentId,
            shipment,
            variant: "notice",
            deltaCents,
            reasonText,
            rechargeAmount,
            piId: pi.id,
        });

        return {
            decision: "recharge",
            amount_cents: rechargeAmount,
            reason: "succeeded",
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log({
            event_type: "adjustment.recharge_error",
            session_id: sessionId,
            severity: "error",
            entity_type: "carrier_adjustment",
            entity_id: carrierAdjustmentId,
            properties: {
                shipment_id: shipment.id,
                delta_cents: deltaCents,
                error_message: msg,
            },
        });
        return {
            decision: "flag",
            amount_cents: 0,
            reason: `recharge_error: ${msg}`,
        };
    }
}

// ─── Helper: cap-check with row-level lock ───────────────────────────────────
//
// Three caps are evaluated in a single Postgres call so the read window stays
// short. The RPC `resolve_recovery_lock` performs:
//
//   BEGIN;
//   SELECT id FROM shipments WHERE id = :ship_id FOR UPDATE;
//   -- All three caps measure the customer-RECHARGE side (decided §2.4), i.e.
//   -- type='charge' rows keyed `adjustment_%` — NOT the negative carrier_adjustment
//   -- cost rows (counting those was bug 5's double-count).
//   SELECT COALESCE(SUM(amount_cents), 0) FROM transactions
//     WHERE type='charge'
//       AND idempotency_key LIKE 'adjustment\_%'
//       AND shipment_id = :ship_id;     -- per-shipment lifetime
//   SELECT COALESCE(SUM(t.amount_cents), 0) FROM transactions t
//     JOIN stripe_intents si ON si.stripe_intent_id = t.stripe_intent_id
//     WHERE t.type='charge'
//       AND t.idempotency_key LIKE 'adjustment\_%'
//       AND si.payment_method_id = :pm AND t.created_at > now() - interval '24 hours';
//   SELECT COALESCE(SUM(amount_cents), 0) FROM transactions
//     WHERE type='charge'
//       AND idempotency_key LIKE 'adjustment\_%'
//       AND user_id = :user_id
//       AND created_at > now() - interval '7 days';
//   COMMIT;
//
// In the absence of that RPC (e.g. fresh migration state), the helper falls
// back to unlocked reads + logs a `degraded` severity=warn event. The
// per-shipment cap stays enforced; the per-card and per-user caps degrade
// to best-effort. Documented in the LOG entry.

interface CapCheckResult {
    blocked: CapBreachReason | null;
    sums?: {
        shipment_lifetime: number;
        card_24h: number;
        user_7d: number;
    };
}

async function checkCapsWithLock(params: {
    supabase: SupabaseClient;
    shipmentId: string;
    paymentMethodId: string;
    userId: string;
    deltaCents: number;
    sessionId: string;
}): Promise<CapCheckResult> {
    const { supabase, shipmentId, paymentMethodId, userId, deltaCents, sessionId } = params;
    const rechargeAmount = deltaCents + HANDLING_FEE_CENTS;

    // Try the RPC first (proper FOR UPDATE serialization).
    try {
        const { data, error } = await supabase.rpc("resolve_recovery_lock", {
            p_shipment_id: shipmentId,
            p_payment_method_id: paymentMethodId,
            p_user_id: userId,
        }) as { data: { shipment_lifetime: number; card_24h: number; user_7d: number } | null; error: { code?: string; message: string } | null };

        if (!error && data) {
            const shipmentLifetime = Number(data.shipment_lifetime) || 0;
            const card24h = Number(data.card_24h) || 0;
            const user7d = Number(data.user_7d) || 0;

            // Already-accumulated values are signed sums of past charges
            // attributed to adjustments. Use absolute values for cap math —
            // we're tracking how much we've collected, not net margin.
            const shipmentAbs = Math.abs(shipmentLifetime);
            const cardAbs = Math.abs(card24h);
            const userAbs = Math.abs(user7d);

            if (shipmentAbs + rechargeAmount > CAP_PER_SHIPMENT_CENTS) {
                return {
                    blocked: "shipment_lifetime",
                    sums: { shipment_lifetime: shipmentAbs, card_24h: cardAbs, user_7d: userAbs },
                };
            }
            if (cardAbs + rechargeAmount > CAP_PER_CARD_24H_CENTS) {
                return {
                    blocked: "24h_card",
                    sums: { shipment_lifetime: shipmentAbs, card_24h: cardAbs, user_7d: userAbs },
                };
            }
            if (userAbs + rechargeAmount > CAP_PER_USER_7D_CENTS) {
                return {
                    blocked: "7d_user",
                    sums: { shipment_lifetime: shipmentAbs, card_24h: cardAbs, user_7d: userAbs },
                };
            }
            return { blocked: null, sums: { shipment_lifetime: shipmentAbs, card_24h: cardAbs, user_7d: userAbs } };
        }

        // RPC is missing or errored — fall through to unlocked path.
        // PGRST202 = function not found; 42883 = function does not exist.
        log({
            event_type: "adjustment.cap_lock_rpc_unavailable",
            session_id: sessionId,
            severity: "warn",
            entity_type: "carrier_adjustment",
            properties: {
                error_code: error?.code ?? null,
                error_message: error?.message ?? null,
            },
        });
    } catch (err) {
        log({
            event_type: "adjustment.cap_lock_rpc_threw",
            session_id: sessionId,
            severity: "warn",
            entity_type: "carrier_adjustment",
            properties: {
                error_message: err instanceof Error ? err.message : String(err),
            },
        });
    }

    // ── Unlocked fallback ─────────────────────────────────────────────────────
    // Still enforce the per-shipment cap (the highest-priority cap; without
    // it a fast double-fire could chain >$10 of recharge on one shipment).
    // The per-card and per-user caps degrade to best-effort.
    //
    // The per-shipment sum uses the SAME recharge-charge basis as the RPC
    // (type='charge' + idempotency_key LIKE 'adjustment_%') — NOT the negative
    // carrier_adjustment cost rows. Counting cost rows was bug 5 (double-count:
    // the webhook writes the cost row before this check runs) and drift from the
    // decided §2.4, which measures every cap on the customer-recharge side.
    // Fallback and RPC MUST agree (Review B3), so keep these two queries aligned.

    const { data: shipmentRows, error: shipErr } = await supabase
        .from("transactions")
        .select("amount_cents")
        .eq("type", "charge")
        .eq("shipment_id", shipmentId)
        .like("idempotency_key", "adjustment\\_%");

    if (shipErr) {
        // Conservative: fail-safe, treat as cap breach.
        log({
            event_type: "adjustment.cap_read_error",
            session_id: sessionId,
            severity: "error",
            entity_type: "carrier_adjustment",
            properties: { error_message: shipErr.message },
        });
        return { blocked: "shipment_lifetime" };
    }

    const shipmentAbs = (shipmentRows ?? [])
        .reduce((acc, r) => acc + Math.abs(Number((r as { amount_cents: number }).amount_cents)), 0);

    if (shipmentAbs + rechargeAmount > CAP_PER_SHIPMENT_CENTS) {
        return { blocked: "shipment_lifetime", sums: { shipment_lifetime: shipmentAbs, card_24h: 0, user_7d: 0 } };
    }

    // Best-effort per-user-7d (no per-card window without the RPC's join shape).
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: userRows } = await supabase
        .from("transactions")
        .select("amount_cents")
        .eq("type", "charge")
        .eq("user_id", userId)
        .like("idempotency_key", "adjustment\\_%")
        .gte("created_at", sevenDaysAgo);

    const userAbs = (userRows ?? [])
        .reduce((acc, r) => acc + Math.abs(Number((r as { amount_cents: number }).amount_cents)), 0);

    if (userAbs + rechargeAmount > CAP_PER_USER_7D_CENTS) {
        return { blocked: "7d_user", sums: { shipment_lifetime: shipmentAbs, card_24h: 0, user_7d: userAbs } };
    }

    return { blocked: null, sums: { shipment_lifetime: shipmentAbs, card_24h: 0, user_7d: userAbs } };
}

// ─── Helper: mark resolved ───────────────────────────────────────────────────

async function markAdjustmentResolved(
    supabase: SupabaseClient,
    carrierAdjustmentId: string,
    status: "recovered" | "absorbed" | "disputed" | "rejected",
    recoveryTxId: string | null,
    sessionId: string,
): Promise<void> {
    const { error } = await supabase
        .from("carrier_adjustments")
        .update({
            recovery_status: status,
            ...(recoveryTxId ? { recovery_tx_id: recoveryTxId } : {}),
            resolved_at: new Date().toISOString(),
        })
        .eq("id", carrierAdjustmentId);

    if (error) {
        log({
            event_type: "adjustment.mark_resolved_failed",
            session_id: sessionId,
            severity: "error",
            entity_type: "carrier_adjustment",
            entity_id: carrierAdjustmentId,
            properties: {
                error_message: error.message,
                attempted_status: status,
            },
        });
    }
}

// ─── Helper: send customer notification email + dedup ────────────────────────
//
// Dedup keyed per carrier_adjustments.id via notifications_log row (event_type
// 'carrier_adjustment.recharged'). Email failure logged but never breaks the
// recovery flow — the recharge already succeeded by this point.

async function sendCarrierAdjustmentEmail(params: {
    supabase: SupabaseClient;
    sessionId: string;
    carrierAdjustmentId: string;
    shipmentId: string;
    receiptEmail: string;
    amountCents: number;
    feeCents: number;
    carrier: string;
    reasonText?: string;
    publicCode: string;
    trackingUrl: string;
}): Promise<void> {
    const {
        supabase, sessionId, carrierAdjustmentId, shipmentId, receiptEmail,
        amountCents, feeCents, carrier, reasonText, publicCode, trackingUrl,
    } = params;

    // Idempotency: check if we already sent this email.
    // notifications_log shape: (shipment_id, event_type, status).
    // We don't have a contact_id here; we use a synthetic per-adjustment marker
    // via the event_type suffix so the existing UNIQUE-by-(shipment, contact,
    // event_type, status) constraint dedups correctly across retries.
    const eventType = `carrier_adjustment.recharged:${carrierAdjustmentId}`;

    const { data: existing } = await supabase
        .from("notifications_log")
        .select("id")
        .eq("shipment_id", shipmentId)
        .eq("event_type", eventType)
        .eq("status", "sent")
        .limit(1);

    if (existing && existing.length > 0) {
        return; // already sent; skip silently
    }

    try {
        const tpl = carrierAdjustmentEmail({
            amount_cents: amountCents,
            fee_cents: feeCents,
            carrier,
            reason: reasonText ?? "weight adjustment",
            public_code: publicCode,
            tracking_url: trackingUrl,
        });
        const ac = new AbortController();
        const tid = setTimeout(() => ac.abort(), 5000);
        const result = await sendEmail({
            to: receiptEmail,
            subject: tpl.subject,
            html: tpl.html,
            signal: ac.signal,
        });
        clearTimeout(tid);

        await supabase.from("notifications_log").insert({
            shipment_id: shipmentId,
            contact_id: null,
            channel: "email",
            event_type: eventType,
            status: "sent",
            provider_id: result?.id ?? null,
        });

        log({
            event_type: "adjustment.email_sent",
            session_id: sessionId,
            severity: "info",
            entity_type: "carrier_adjustment",
            entity_id: carrierAdjustmentId,
            properties: { recipient: receiptEmail, provider_id: result?.id ?? null },
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log({
            event_type: "adjustment.email_failed",
            session_id: sessionId,
            severity: "warn",
            entity_type: "carrier_adjustment",
            entity_id: carrierAdjustmentId,
            properties: { recipient: receiptEmail, error_message: msg },
        });
        await supabase.from("notifications_log").insert({
            shipment_id: shipmentId,
            contact_id: null,
            channel: "email",
            event_type: eventType,
            status: "failed",
            error_message: msg,
        }).then(() => {}, () => {});  // swallow inner failure
    }
}

// ─── Helper: admin ops alert on a live recharge / flag (John req. 2026-07-15) ─
//
// John asked to be emailed any time H2 fires on a LIVE shipment. Scope: the
// money-moving and needs-review outcomes only — a successful `recharge`
// (variant:"notice") and every `flag` (variant:"alert"). Silent `absorb` cases
// never alert. Extends the shared _shared/alert.ts:sendAdminAlert (Rule 6).
//
// Guards:
//   - LIVE only — test-mode verification and the integration harness never email.
//   - Deduped per (carrier_adjustment_id, variant) via a notifications_log marker
//     so a `.updated` re-fire or webhook retry can't double-email. A flag that is
//     later corrected to a recharge still sends both (distinct variants).
// sendAdminAlert never throws, so a send failure can't break the recovery flow.

async function sendAdjustmentAdminAlert(params: {
    supabase: SupabaseClient;
    sessionId: string;
    carrierAdjustmentId: string;
    shipment: AdjustmentShipment;
    variant: "alert" | "notice";
    deltaCents: number;
    reasonText?: string;
    flagReason?: string;      // variant "alert"
    rechargeAmount?: number;  // variant "notice"
    piId?: string;            // variant "notice"
}): Promise<void> {
    const {
        supabase, sessionId, carrierAdjustmentId, shipment, variant,
        deltaCents, reasonText, flagReason, rechargeAmount, piId,
    } = params;

    // Live-only.
    if (shipment.is_test) return;

    const eventType = `admin_alert.${variant}.carrier_adjustment:${carrierAdjustmentId}`;

    // Dedup.
    const { data: existing } = await supabase
        .from("notifications_log")
        .select("id")
        .eq("shipment_id", shipment.id)
        .eq("event_type", eventType)
        .eq("status", "sent")
        .limit(1);
    if (existing && existing.length > 0) return;

    const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
    const carrier = shipment.carrier ?? "the carrier";
    const rows = [
        { label: "Shipment", value: shipment.public_code },
        { label: "Carrier", value: carrier },
        { label: "Reason", value: reasonText ?? "adjustment" },
        { label: "Carrier delta", value: dollars(deltaCents) },
    ];

    if (variant === "notice") {
        if (rechargeAmount != null) rows.push({ label: "Recharged", value: dollars(rechargeAmount) });
        if (piId) rows.push({ label: "PaymentIntent", value: piId });
    } else if (flagReason) {
        rows.push({ label: "Action needed", value: flagReason });
    }

    await sendAdminAlert({
        variant,
        subject: variant === "notice"
            ? `Carrier adjustment recharged — ${shipment.public_code}`
            : `Carrier adjustment flagged — ${shipment.public_code}`,
        heading: variant === "notice"
            ? "H2 auto-recovered a carrier adjustment"
            : "Carrier adjustment needs your review",
        intro: variant === "notice"
            ? `A live shipment was re-billed ${dollars(deltaCents)} by ${carrier}; SendMo auto-collected ${rechargeAmount != null ? dollars(rechargeAmount) : "the amount"} off-session.`
            : `A live shipment was re-billed ${dollars(deltaCents)} by ${carrier} and could not be auto-recharged. ${flagReason ?? ""}`,
        rows,
        actionUrl: `${adminAppUrl()}/admin?shipment=${shipment.id}`,
        actionLabel: "Open in admin",
        source: "adjustments resolveRecovery",
    });

    await supabase.from("notifications_log").insert({
        shipment_id: shipment.id,
        contact_id: null,
        channel: "email",
        event_type: eventType,
        status: "sent",
    }).then(() => {}, () => {});
}
