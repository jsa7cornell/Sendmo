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

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { log } from "./logger.ts";
import { createAdjustmentRecharge } from "./stripe.ts";
import { sendEmail } from "./resend.ts";
import { carrierAdjustmentEmail } from "./email-templates.ts";

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
//   - inserts the `recovery_tx_id` link to the new transactions row
//     (the stripe-webhook's `charge.succeeded` arm writes the actual ledger
//     row; here we just patch the cross-reference after the PI returns
//     `succeeded` so the dashboard can show "Adjustment collected").
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

        // Success — patch the carrier_adjustments row's recovery_status +
        // anchor (recovery_tx_id stays NULL until the stripe-webhook lands
        // the corresponding `charge` transactions row; the join via
        // stripe_intent_id closes the loop in the Reconciliation dashboard).
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
//   SELECT COALESCE(SUM(amount_cents), 0) FROM transactions
//     WHERE type='carrier_adjustment'
//       AND shipment_id = :ship_id;     -- per-shipment
//   SELECT COALESCE(SUM(amount_cents), 0) FROM transactions
//     WHERE type='charge'
//       AND idempotency_key LIKE 'adjustment\_%'
//       AND stripe_intent_id IN (SELECT pi from cards last 24h);
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

    const { data: shipmentRows, error: shipErr } = await supabase
        .from("transactions")
        .select("amount_cents")
        .eq("type", "carrier_adjustment")
        .eq("shipment_id", shipmentId);

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
