import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { verifyAndParseWebhook, retrieveCharge } from "../_shared/stripe.ts";
import { sendEmail } from "../_shared/resend.ts";
import { paymentDeclinedReactivateEmail, radarBlockedPayerEmail } from "../_shared/email-templates.ts";

// POST /stripe-webhook
//
// SOLE LEDGER WRITER (Stripe Phase A, migration 017, proposal §3.4 + round-1 B4).
// This function is the only place charge / refund / chargeback rows land in
// the `transactions` ledger. The labels function writes only comp_grant rows.
//
// Events handled:
//   payment_intent.succeeded     → UPSERT stripe_intents (succeeded)
//                                  INSERT transactions (+charge)
//   payment_intent.payment_failed → UPSERT stripe_intents (failed); no ledger row
//   charge.refunded               → UPSERT refunds row
//                                  INSERT transactions (-refund)
//   charge.dispute.created        → INSERT transactions (-chargeback)
//   setup_intent.succeeded        → UPSERT stripe_intents (succeeded). No
//                                   payment_methods write — that happens on
//                                   payment_method.attached which carries
//                                   brand/last4/exp inline. (Phase B B1 fix.)
//   payment_method.attached       → INSERT payment_methods row (canonical
//                                   writer; reads card.brand/last4/exp from
//                                   the event payload).
//   payment_method.detached       → UPDATE payment_methods.deleted_at = now().
//                                   Auto-promotes most-recent active card to
//                                   default if the detached card was default
//                                   (Phase B N3 fix).
//
// Idempotency layers:
//   1. webhook_events.id UNIQUE → Stripe-side retry dedup
//   2. transactions.idempotency_key UNIQUE → ledger-row dedup
//   3. stripe_intents.stripe_intent_id UNIQUE → state-mirror upsert key

type StripeObj = Record<string, unknown>;

interface ChargeObj extends StripeObj {
    id: string;
    amount: number;
    amount_refunded?: number;
    payment_intent?: string;
    refunds?: { data?: Array<{ id: string; amount: number; reason?: string; status?: string }> };
}

interface PaymentIntentObj extends StripeObj {
    id: string;
    amount: number;
    amount_received?: number;
    currency?: string;
    capture_method?: string;
    payment_method?: string;
    latest_charge?: string | ChargeObj;
    metadata?: Record<string, string>;
    last_payment_error?: { message?: string };
}

interface DisputeObj extends StripeObj {
    id: string;
    amount: number;
    payment_intent?: string;
    charge?: string;
    reason?: string;
}

interface SetupIntentObj extends StripeObj {
    id: string;
    customer?: string | null;
    payment_method?: string | null;
    status?: string;
    usage?: string;
    metadata?: Record<string, string>;
}

interface PaymentMethodObj extends StripeObj {
    id: string;
    type?: string;
    customer?: string | null;
    card?: {
        brand?: string;
        last4?: string;
        exp_month?: number;
        exp_year?: number;
    };
    metadata?: Record<string, string>;
}

// Webhook lookup helper: given a Stripe Customer id and the resolved mode,
// find the SendMo profile that owns it. Returns null if no match (which can
// happen for events fired against a Customer we didn't create — e.g., test
// events from the Stripe dashboard "Send test webhook" tooling).
async function resolveUserByCustomer(
    supabase: ReturnType<typeof createClient>,
    customerId: string | null | undefined,
    liveMode: boolean,
): Promise<string | null> {
    if (!customerId) return null;
    const col = liveMode ? "stripe_customer_id_live" : "stripe_customer_id_test";
    const { data } = await supabase
        .from("profiles")
        .select("id")
        .eq(col, customerId)
        .maybeSingle();
    return (data as { id?: string } | null)?.id ?? null;
}

function resolveIdsFromMetadata(meta: Record<string, string> | undefined): {
    user_id: string | null;
    link_id: string | null;
    shipment_id: string | null;
    intent_role: string | null;
} {
    return {
        user_id: meta?.sendmo_user_id || null,
        link_id: meta?.link_id || null,
        shipment_id: meta?.shipment_id || null,
        intent_role: meta?.intent_role || null,
    };
}

serve(async (req: Request) => {
    const corsResponse = handleCors(req);
    if (corsResponse) return corsResponse;

    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    const sigHeader = req.headers.get("stripe-signature");
    const rawPayload = await req.text();

    let event: Record<string, unknown>;
    let liveMode: boolean;
    try {
        const result = await verifyAndParseWebhook(rawPayload, sigHeader);
        event = result.event;
        liveMode = result.liveMode;
    } catch (err) {
        const msg = err instanceof Error ? err.message : "signature verification failed";
        console.error("[stripe-webhook] verification failed:", msg);
        return new Response(JSON.stringify({ error: msg }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    const eventId = event.id as string;
    const eventType = event.type as string;
    const mode = liveMode ? "live" : "test";

    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Idempotency layer 1: webhook_events table. INSERT before processing
    // and bail if a row already exists for this event.id.
    const { data: existing } = await supabase
        .from("webhook_events")
        .select("id")
        .eq("event_id", eventId)
        .maybeSingle();
    if (existing) {
        return new Response(JSON.stringify({ ok: true, deduped: true }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    try {
        const obj = ((event.data as { object?: StripeObj })?.object || {}) as StripeObj;

        switch (eventType) {
            case "payment_intent.succeeded": {
                const pi = obj as PaymentIntentObj;
                const piId = pi.id;
                const amountCents = (pi.amount_received as number) ?? pi.amount;
                const meta = pi.metadata || {};
                const { user_id, link_id, shipment_id, intent_role } = resolveIdsFromMetadata(meta);

                // (1) UPSERT stripe_intents mirror — succeeded.
                //     Pattern D (Phase F): also populate payment_method_id for
                //     off_session shipment PIs so we can query "which PM was
                //     used for this shipment" without round-tripping Stripe.
                if (user_id) {
                    await supabase.from("stripe_intents").upsert({
                        user_id,
                        link_id,
                        shipment_id,
                        stripe_intent_id: piId,
                        intent_kind: "payment",
                        intent_role: intent_role ?? "shipment",
                        capture_method: pi.capture_method ?? "automatic",
                        funding_source: "card",
                        amount_cents: pi.amount,
                        captured_cents: amountCents,
                        payment_method_id: typeof pi.payment_method === "string" ? pi.payment_method : null,
                        status: "succeeded",
                        mode,
                        idempotency_key: `pi.${piId}:create`,
                        last_event_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    }, { onConflict: "stripe_intent_id" });
                }

                // (2) Append +charge ledger row.
                //     Works for every successful PI: full-label automatic-capture,
                //     flex-shipment off_session (Pattern D), and any leftover
                //     Phase E flex_hold captures still in flight at deploy time.
                //     user_id falls back to the system-profile UUID for events
                //     whose metadata.sendmo_user_id is missing.
                const ledgerUserId = user_id ?? "00000000-0000-0000-0000-000000000001";
                const { error: txErr } = await supabase.from("transactions").insert({
                    user_id: ledgerUserId,
                    shipment_id,
                    link_id,
                    stripe_intent_id: piId,
                    type: "charge",
                    funding_source: "card",
                    amount_cents: amountCents,
                    mode,
                    idempotency_key: `stripe.${eventId}:charge`,
                    description: `payment_intent.succeeded ${piId}`,
                });
                if (txErr && !/duplicate key|unique constraint/i.test(txErr.message)) {
                    throw new Error(`transactions insert failed: ${txErr.message}`);
                }

                // NB: Pattern D explicitly does NOT update holds.status or flip
                // sendmo_links.status here. Pre-Pattern D this handler updated
                // holds.captured and flipped flex links active→in_use; both
                // behaviors are vestigial under Pattern D (no holds rows for
                // new flex shipments; links stay 'active' indefinitely).
                // The active→in_use flip in labels/index.ts was also removed
                // in this PR for the same reason.

                log({
                    event_type: "stripe.payment_succeeded",
                    severity: "info",
                    entity_type: "payment_intent",
                    entity_id: piId,
                    properties: { amount_cents: amountCents, live_mode: liveMode, shipment_id, link_id, intent_role },
                });
                break;
            }

            case "payment_intent.amount_capturable_updated": {
                // Fires when a manual-capture PI is confirmed by the user and
                // moves to 'requires_capture' state. Pattern D (Phase F) does
                // not create manual-capture PIs for any new flow — this event
                // should only fire for in-flight Phase E flex_hold PIs at the
                // moment of deploy. Defensive handler: mirror state to
                // stripe_intents, log the event, do nothing else. (No holds-row
                // insert, no link status flip — both were Phase E artifacts.)
                const pi = obj as PaymentIntentObj;
                const piId = pi.id;
                const meta = pi.metadata || {};
                const { user_id, link_id, intent_role } = resolveIdsFromMetadata(meta);

                if (user_id) {
                    await supabase.from("stripe_intents").upsert({
                        user_id,
                        link_id,
                        stripe_intent_id: piId,
                        intent_kind: "payment",
                        intent_role: intent_role ?? "shipment",
                        capture_method: pi.capture_method ?? "manual",
                        funding_source: "card",
                        amount_cents: pi.amount,
                        payment_method_id: typeof pi.payment_method === "string" ? pi.payment_method : null,
                        status: "requires_capture",
                        mode,
                        idempotency_key: `pi.${piId}:create`,
                        last_event_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    }, { onConflict: "stripe_intent_id" });
                }

                log({
                    event_type: "stripe.amount_capturable_updated_unexpected",
                    severity: "warn",
                    entity_type: "payment_intent",
                    entity_id: piId,
                    properties: {
                        live_mode: liveMode,
                        link_id,
                        intent_role,
                        note: "Pattern D does not create manual-capture PIs; this likely is a Phase E in-flight remnant",
                    },
                });
                break;
            }

            case "payment_intent.canceled": {
                // Manual void or auto-expiration. Pattern D doesn't cancel
                // PIs from our own code (we don't create manual-capture
                // anymore), so this fires only for in-flight Phase E remnants
                // or external cancellations. Mirror state to stripe_intents;
                // no holds-table or link-status writes (both Phase E vestiges).
                const pi = obj as PaymentIntentObj;
                const piId = pi.id;
                const meta = pi.metadata || {};
                const { user_id, link_id, intent_role } = resolveIdsFromMetadata(meta);
                const cancellationReason = (pi as { cancellation_reason?: string }).cancellation_reason ?? null;

                if (user_id) {
                    await supabase.from("stripe_intents").upsert({
                        user_id,
                        link_id,
                        stripe_intent_id: piId,
                        intent_kind: "payment",
                        intent_role: intent_role ?? "shipment",
                        capture_method: pi.capture_method ?? "manual",
                        funding_source: "card",
                        amount_cents: pi.amount,
                        payment_method_id: typeof pi.payment_method === "string" ? pi.payment_method : null,
                        cancellation_reason: cancellationReason,
                        status: "canceled",
                        mode,
                        idempotency_key: `pi.${piId}:create`,
                        last_event_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    }, { onConflict: "stripe_intent_id" });
                }

                log({
                    event_type: "stripe.payment_canceled",
                    severity: "info",
                    entity_type: "payment_intent",
                    entity_id: piId,
                    properties: {
                        cancellation_reason: cancellationReason,
                        live_mode: liveMode,
                        link_id,
                        intent_role,
                    },
                });
                break;
            }

            case "payment_intent.payment_failed": {
                const pi = obj as PaymentIntentObj;
                const piId = pi.id;
                const failureMessage = pi.last_payment_error?.message ?? null;
                const failureCode = (pi.last_payment_error as { code?: string } | undefined)?.code ?? null;
                const meta = pi.metadata || {};
                const { user_id, link_id, shipment_id, intent_role } = resolveIdsFromMetadata(meta);
                const source = (meta as { source?: string }).source ?? null;

                if (user_id) {
                    await supabase.from("stripe_intents").upsert({
                        user_id,
                        link_id,
                        shipment_id,
                        stripe_intent_id: piId,
                        intent_kind: "payment",
                        intent_role: intent_role ?? "shipment",
                        capture_method: pi.capture_method ?? "automatic",
                        funding_source: "card",
                        amount_cents: pi.amount,
                        payment_method_id: typeof pi.payment_method === "string" ? pi.payment_method : null,
                        last_payment_error_code: failureCode,
                        status: "failed",
                        mode,
                        idempotency_key: `pi.${piId}:create`,
                        last_event_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    }, { onConflict: "stripe_intent_id" });
                }

                // No ledger row — failed charges don't move money.
                log({
                    event_type: "stripe.payment_failed",
                    severity: "warn",
                    entity_type: "payment_intent",
                    entity_id: piId,
                    properties: {
                        failure_message: failureMessage,
                        failure_code: failureCode,
                        live_mode: liveMode,
                        source,
                        link_id,
                    },
                });

                // ─── Pattern D: flex shipment decline-recovery ───
                // For off_session shipment PIs (source='flex_shipment') that
                // decline, write a link_state_events row and send the
                // recipient the decline-recovery email inline (5s timeout,
                // event_logs fallback on send failure). Dedup via
                // sendmo_links.last_decline_email_at (one email per link
                // per day max).
                //
                // The labels Edge Function already returns 402 to the sender
                // inline; this handler covers the async email side. If both
                // paths race (rare — webhook usually beats the inline path),
                // the dedup gate stops duplicate emails.
                if (source === "flex_shipment" && link_id) {
                    try {
                        // ── B4: detect a Stripe Radar block before the existing
                        // decline-recovery path. Authoritative signal is the
                        // failed charge's outcome.type === 'blocked' (Radar/your
                        // rules), distinct from 'issuer_declined' (real card
                        // decline). Fetched per-failure; failed flex PIs are
                        // rare so the cost is negligible. On any fetch failure
                        // we conservatively fall through to the decline path —
                        // a wrongly-sent decline email beats a wrongly-skipped
                        // one for an actual decline.
                        let radarBlocked = false;
                        const latestChargeId = (pi as { latest_charge?: string }).latest_charge;
                        if (latestChargeId) {
                            try {
                                const ch = await retrieveCharge(latestChargeId, liveMode);
                                radarBlocked = ch.outcome?.type === "blocked";
                            } catch (chErr) {
                                log({
                                    event_type: "stripe.radar_check_failed",
                                    severity: "warn",
                                    entity_type: "payment_intent",
                                    entity_id: piId,
                                    properties: {
                                        error_message: chErr instanceof Error ? chErr.message : String(chErr),
                                        latest_charge: latestChargeId,
                                    },
                                });
                            }
                        }

                        const { data: link } = await supabase
                            .from("sendmo_links")
                            .select("id, short_code, user_id, last_decline_email_at, profile:profiles!user_id(email)")
                            .eq("id", link_id)
                            .maybeSingle();

                        // ── B4: Radar-block branch — NOT a card decline. ────
                        // Do NOT send the decline-recovery email; do NOT write
                        // charge_failed or flip the link Inactive (the payer's
                        // card is fine). Write radar_blocked, log for SendMo
                        // visibility, gently notify the payer (O7 — every block).
                        if (!link && radarBlocked) {
                            // Defensive log — link_id from metadata didn't
                            // resolve, so we can't write the radar_blocked
                            // event or notify the payer. Shouldn't happen
                            // (link_id is set by labels/ from a resolved
                            // sendmo_links row) but make it observable.
                            log({
                                event_type: "stripe.radar_blocked_no_link",
                                severity: "warn",
                                entity_type: "payment_intent",
                                entity_id: piId,
                                properties: { link_id, mode, decline_code: failureCode },
                            });
                        }

                        if (link && radarBlocked) {
                            await supabase.from("link_state_events").insert({
                                link_id: link.id,
                                event: "radar_blocked",
                                // reason is the human-readable category; the
                                // Stripe last_payment_error.code goes in
                                // metadata so the audit row is unambiguous
                                // (review N-3 — failureCode is typically
                                // 'card_declined' and reads identically to
                                // a real decline if used as the reason).
                                reason: "radar_block",
                                metadata: {
                                    stripe_intent_id: piId,
                                    mode,
                                    last_payment_error_code: failureCode,
                                },
                            });
                            const payerEmail =
                                (link as { profile?: { email?: string } | null }).profile?.email ?? null;
                            if (payerEmail) {
                                const tpl = radarBlockedPayerEmail({
                                    linkId: link.id,
                                    shortCode: (link as { short_code: string }).short_code,
                                });
                                const acRb = new AbortController();
                                const tidRb = setTimeout(() => acRb.abort(), 5000);
                                try {
                                    await sendEmail({
                                        to: payerEmail, subject: tpl.subject, html: tpl.html,
                                        signal: acRb.signal,
                                    });
                                    clearTimeout(tidRb);
                                } catch (sendErr) {
                                    clearTimeout(tidRb);
                                    log({
                                        event_type: "stripe.radar_block_email_failed",
                                        severity: "error",
                                        entity_type: "sendmo_link",
                                        entity_id: link.id,
                                        properties: {
                                            error_message: sendErr instanceof Error ? sendErr.message : String(sendErr),
                                            recipient: payerEmail,
                                        },
                                    });
                                }
                            }
                            log({
                                event_type: "stripe.radar_blocked",
                                severity: "warn",
                                entity_type: "payment_intent",
                                entity_id: piId,
                                properties: {
                                    link_id: link.id,
                                    short_code: (link as { short_code: string }).short_code,
                                    mode,
                                    decline_code: failureCode,
                                    payer_email: payerEmail,
                                },
                            });
                        }

                        if (link && !radarBlocked) {
                            // Audit row — always written regardless of email outcome
                            await supabase.from("link_state_events").insert({
                                link_id: link.id,
                                event: "charge_failed",
                                reason: failureCode ?? failureMessage ?? "unknown",
                                metadata: { stripe_intent_id: piId, mode },
                            });

                            // Dedup: skip email if one was already sent today
                            const lastSent = (link as { last_decline_email_at?: string | null }).last_decline_email_at;
                            const todayStart = new Date();
                            todayStart.setHours(0, 0, 0, 0);
                            const dedupSkip = lastSent && new Date(lastSent) >= todayStart;

                            if (dedupSkip) {
                                log({
                                    event_type: "stripe.decline_email_deduped",
                                    severity: "info",
                                    entity_type: "sendmo_link",
                                    entity_id: link.id,
                                    properties: { last_sent: lastSent, stripe_intent_id: piId },
                                });
                            } else {
                                // Recipient email lookup. profile is typed loosely.
                                const recipientEmail =
                                    (link as { profile?: { email?: string } | null }).profile?.email ?? null;

                                if (recipientEmail) {
                                    // Sender name not available in this event payload;
                                    // labels-fn would have known it but we don't carry
                                    // it here. Default to null → "a sender".
                                    const tpl = paymentDeclinedReactivateEmail({
                                        senderName: null,
                                        linkId: link.id,
                                        shortCode: (link as { short_code: string }).short_code,
                                    });
                                    // 5s timeout via AbortController. If Resend is slow,
                                    // fail to event_logs rather than hold up the webhook.
                                    const ac = new AbortController();
                                    const timeoutId = setTimeout(() => ac.abort(), 5000);
                                    try {
                                        await sendEmail({
                                            to: recipientEmail,
                                            subject: tpl.subject,
                                            html: tpl.html,
                                            signal: ac.signal,
                                        });
                                        clearTimeout(timeoutId);
                                        await supabase
                                            .from("sendmo_links")
                                            .update({ last_decline_email_at: new Date().toISOString() })
                                            .eq("id", link.id);
                                        log({
                                            event_type: "stripe.decline_email_sent",
                                            severity: "info",
                                            entity_type: "sendmo_link",
                                            entity_id: link.id,
                                            properties: { stripe_intent_id: piId, recipient: recipientEmail },
                                        });
                                    } catch (sendErr) {
                                        clearTimeout(timeoutId);
                                        const sendErrMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
                                        console.error("[stripe-webhook] decline email send failed:", sendErrMsg);
                                        log({
                                            event_type: "decline_email.send_failed",
                                            severity: "error",
                                            entity_type: "sendmo_link",
                                            entity_id: link.id,
                                            properties: {
                                                stripe_intent_id: piId,
                                                recipient: recipientEmail,
                                                error_message: sendErrMsg,
                                            },
                                        });
                                    }
                                } else {
                                    log({
                                        event_type: "stripe.decline_email_no_recipient",
                                        severity: "warn",
                                        entity_type: "sendmo_link",
                                        entity_id: link.id,
                                        properties: { stripe_intent_id: piId },
                                    });
                                }
                            }
                        }
                    } catch (declineErr) {
                        // Never let decline-handling errors fail the webhook response.
                        const msg = declineErr instanceof Error ? declineErr.message : String(declineErr);
                        console.error("[stripe-webhook] flex decline handler error:", msg);
                        log({
                            event_type: "stripe.flex_decline_handler_error",
                            severity: "error",
                            entity_type: "payment_intent",
                            entity_id: piId,
                            properties: { error_message: msg, link_id },
                        });
                    }
                }
                break;
            }

            case "charge.refunded": {
                const charge = obj as ChargeObj;
                const piId = charge.payment_intent ?? null;
                const refundData = charge.refunds?.data?.[0];
                const refundAmount = (refundData?.amount ?? charge.amount_refunded ?? 0) as number;
                const stripeRefundId = refundData?.id ?? `${charge.id}_refund`;

                // Look up the originating shipment + user via the PI.
                let userId: string | null = null;
                let shipmentId: string | null = null;
                let linkId: string | null = null;
                if (piId) {
                    const { data: intentRow } = await supabase
                        .from("stripe_intents")
                        .select("user_id, shipment_id, link_id")
                        .eq("stripe_intent_id", piId)
                        .maybeSingle();
                    userId = intentRow?.user_id ?? null;
                    shipmentId = intentRow?.shipment_id ?? null;
                    linkId = intentRow?.link_id ?? null;
                }

                // (1) UPSERT refunds row.
                if (shipmentId && piId) {
                    await supabase.from("refunds").upsert({
                        shipment_id: shipmentId,
                        stripe_refund_id: stripeRefundId,
                        stripe_payment_intent_id: piId,
                        amount_cents: refundAmount,
                        reason: refundData?.reason ?? null,
                        status: refundData?.status ?? "succeeded",
                        mode,
                    }, { onConflict: "stripe_refund_id" });
                }

                // (2) Append −refund ledger row (negative — money returned to customer).
                const ledgerUserId = userId ?? "00000000-0000-0000-0000-000000000001";
                const { error: txErr } = await supabase.from("transactions").insert({
                    user_id: ledgerUserId,
                    shipment_id: shipmentId,
                    link_id: linkId,
                    stripe_intent_id: piId,
                    stripe_charge_id: charge.id,
                    type: "refund",
                    funding_source: "card",
                    amount_cents: -Math.abs(refundAmount),
                    mode,
                    idempotency_key: `stripe.${eventId}:refund`,
                    description: `charge.refunded ${charge.id}`,
                });
                if (txErr && !/duplicate key|unique constraint/i.test(txErr.message)) {
                    throw new Error(`transactions insert failed: ${txErr.message}`);
                }

                // Advance shipments.refund_status from 'submitted' → 'refunded'.
                // Set by cancel-label after a successful Stripe createRefund;
                // this is the async hand-off that closes the cancel state machine.
                // Per decided proposal label-cancel-and-change (2026-05-12).
                if (shipmentId) {
                    const { error: shipErr } = await supabase
                        .from("shipments")
                        .update({ refund_status: "refunded" })
                        .eq("id", shipmentId)
                        .eq("refund_status", "submitted");  // idempotent
                    if (shipErr) {
                        console.error("[stripe-webhook] shipments.refund_status update failed:", shipErr);
                    }
                }

                log({
                    event_type: "stripe.charge_refunded",
                    severity: "info",
                    entity_type: "payment_intent",
                    entity_id: piId,
                    properties: { amount_cents: refundAmount, live_mode: liveMode, shipment_id: shipmentId },
                });
                break;
            }

            case "charge.dispute.created": {
                const dispute = obj as DisputeObj;
                const piId = dispute.payment_intent ?? null;
                const chargeId = dispute.charge ?? null;

                let userId: string | null = null;
                let shipmentId: string | null = null;
                let linkId: string | null = null;
                if (piId) {
                    const { data: intentRow } = await supabase
                        .from("stripe_intents")
                        .select("user_id, shipment_id, link_id")
                        .eq("stripe_intent_id", piId)
                        .maybeSingle();
                    userId = intentRow?.user_id ?? null;
                    shipmentId = intentRow?.shipment_id ?? null;
                    linkId = intentRow?.link_id ?? null;
                }

                const ledgerUserId = userId ?? "00000000-0000-0000-0000-000000000001";
                const { error: txErr } = await supabase.from("transactions").insert({
                    user_id: ledgerUserId,
                    shipment_id: shipmentId,
                    link_id: linkId,
                    stripe_intent_id: piId,
                    stripe_charge_id: chargeId,
                    type: "chargeback",
                    funding_source: "card",
                    amount_cents: -Math.abs(dispute.amount),
                    mode,
                    idempotency_key: `stripe.${eventId}:chargeback`,
                    description: `charge.dispute.created ${dispute.id} reason=${dispute.reason ?? "?"}`,
                });
                if (txErr && !/duplicate key|unique constraint/i.test(txErr.message)) {
                    throw new Error(`transactions insert failed: ${txErr.message}`);
                }

                log({
                    event_type: "stripe.dispute_opened",
                    severity: "error",
                    entity_type: "payment_intent",
                    entity_id: piId ?? null,
                    properties: {
                        amount_cents: dispute.amount,
                        reason: dispute.reason,
                        live_mode: liveMode,
                        shipment_id: shipmentId,
                    },
                });
                break;
            }

            case "charge.refund.updated": {
                // H3 — D1 (decided 2026-05-22): failure-detection handler.
                //
                // Fires when a Stripe Refund's status changes. The only status
                // that matters in P1 is 'failed' — the customer's card couldn't
                // accept the refund (closed account, expired card). This is the
                // automated detection half of Decision #6: "never silent."
                //
                // D1 scopes to data-model + SendMo-visibility only:
                //   - Write a severity='error' event_logs row (durable record).
                //   - Send an alert email to the SendMo admin (John).
                //   - No customer-facing action; resolution is manual (John
                //     issues payment another way outside SendMo). Customer
                //     comms stay in P2 / H5.
                interface RefundObj extends StripeObj {
                    id: string;
                    amount: number;
                    status: string;
                    payment_intent?: string | null;
                    charge?: string | null;
                    failure_reason?: string | null;
                    failure_balance_transaction?: string | null;
                }
                const refundObj = obj as RefundObj;
                if (refundObj.status === "failed") {
                    // (1) Durable event_logs row — detection record.
                    await supabase.from("event_logs").insert({
                        event_type: "refund.failed",
                        severity: "error",
                        entity_type: "refund",
                        entity_id: refundObj.id,
                        properties: {
                            payment_intent: refundObj.payment_intent ?? null,
                            charge_id: refundObj.charge ?? null,
                            failure_reason: refundObj.failure_reason ?? null,
                            failure_balance_transaction: refundObj.failure_balance_transaction ?? null,
                            amount: refundObj.amount,
                            live_mode: liveMode,
                        },
                    });

                    // (2) Alert email to admin — manual resolution path.
                    // SENDMO_ADMIN_EMAIL env var; falls back to John's email.
                    const adminEmail = Deno.env.get("SENDMO_ADMIN_EMAIL") || "jsa7cornell@gmail.com";
                    const stripeDashboardUrl = liveMode
                        ? `https://dashboard.stripe.com/refunds/${refundObj.id}`
                        : `https://dashboard.stripe.com/test/refunds/${refundObj.id}`;
                    const amountDollars = (refundObj.amount / 100).toFixed(2);
                    try {
                        await sendEmail({
                            to: adminEmail,
                            subject: `[SendMo ALERT] Refund failed — manual resolution required`,
                            html: `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;">
<h2 style="color:#DC2626;">&#x26A0;&#xFE0F; Refund Failed — Action Required</h2>
<p>A Stripe refund could not be delivered to the customer's card.
The customer has not received their money. <strong>Manual resolution required.</strong></p>
<table style="border-collapse:collapse;width:100%;max-width:480px;">
  <tr><td style="padding:6px 0;color:#6B7280;width:180px;">Refund ID</td><td style="padding:6px 0;font-family:monospace;">${refundObj.id}</td></tr>
  <tr><td style="padding:6px 0;color:#6B7280;">Amount</td><td style="padding:6px 0;">$${amountDollars}</td></tr>
  <tr><td style="padding:6px 0;color:#6B7280;">Failure reason</td><td style="padding:6px 0;">${refundObj.failure_reason ?? "unknown"}</td></tr>
  <tr><td style="padding:6px 0;color:#6B7280;">PaymentIntent</td><td style="padding:6px 0;font-family:monospace;">${refundObj.payment_intent ?? "—"}</td></tr>
  <tr><td style="padding:6px 0;color:#6B7280;">Mode</td><td style="padding:6px 0;">${liveMode ? "LIVE" : "Test"}</td></tr>
</table>
<p><a href="${stripeDashboardUrl}" style="color:#2563EB;">View refund in Stripe Dashboard</a></p>
<p style="font-size:13px;color:#9CA3AF;margin-top:24px;">SendMo automated alert — stripe-webhook charge.refund.updated handler</p>
</body></html>`,
                        });
                    } catch (emailErr) {
                        // Never let email failure block the webhook response.
                        const msg = emailErr instanceof Error ? emailErr.message : String(emailErr);
                        console.error("[stripe-webhook] refund.failed alert email failed:", msg);
                        log({
                            event_type: "refund.failed_alert_email_error",
                            severity: "error",
                            entity_type: "refund",
                            entity_id: refundObj.id,
                            properties: { error_message: msg },
                        });
                    }

                    log({
                        event_type: "stripe.refund_failed_alerted",
                        severity: "info",
                        entity_type: "refund",
                        entity_id: refundObj.id,
                        properties: {
                            failure_reason: refundObj.failure_reason ?? null,
                            amount: refundObj.amount,
                            live_mode: liveMode,
                        },
                    });
                }
                // Other statuses (pending → succeeded, etc.) are informational;
                // no action needed in P1.
                break;
            }

            case "setup_intent.succeeded": {
                // Mirror SetupIntent state to stripe_intents. Card data
                // (brand/last4/exp) is NOT on this event — see Phase B B1
                // fix; that lives on payment_method.attached.
                // Pattern D (Phase F): also populate payment_method_id so
                // "current state of this PM" queries don't need a Stripe
                // round-trip.
                const seti = obj as SetupIntentObj;
                const userId = await resolveUserByCustomer(supabase, seti.customer, liveMode);
                if (userId) {
                    await supabase.from("stripe_intents").upsert({
                        user_id: userId,
                        stripe_intent_id: seti.id,
                        intent_kind: "setup",
                        funding_source: "card",
                        payment_method_id: typeof seti.payment_method === "string" ? seti.payment_method : null,
                        status: "succeeded",
                        mode,
                        idempotency_key: `seti.${seti.id}:create`,
                        last_event_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    }, { onConflict: "stripe_intent_id" });
                }
                log({
                    event_type: "stripe.setup_intent_succeeded",
                    severity: "info",
                    entity_type: "setup_intent",
                    entity_id: seti.id,
                    properties: { live_mode: liveMode, user_id: userId, payment_method: seti.payment_method ?? null },
                });
                break;
            }

            case "payment_method.attached": {
                // Canonical writer for payment_methods rows (Phase B B1).
                // The event's data.object IS the full PaymentMethod with
                // card.brand/last4/exp_month/exp_year inline.
                const pm = obj as PaymentMethodObj;
                const userId = await resolveUserByCustomer(supabase, pm.customer, liveMode);
                if (!userId) {
                    log({
                        event_type: "stripe.payment_method_attached_orphan",
                        severity: "warn",
                        entity_type: "payment_method",
                        entity_id: pm.id,
                        properties: { customer: pm.customer, live_mode: liveMode },
                    });
                    break;
                }

                // Determine is_default: TRUE iff no other active card exists
                // for (user, mode). Partial-unique index enforces at-most-one
                // default per (user, mode).
                //
                // KNOWN RACE (review I2, 2026-05-13): COUNT and INSERT are
                // not in a transaction. Two simultaneous payment_method.attached
                // events for the same (user_id, mode) could both observe
                // count=0 and both try INSERT with is_default=true. The
                // partial-unique-index `uniq_default_pm_per_user_mode` would
                // fail the second INSERT, the swallow below would catch it
                // as duplicate-key, and the SECOND CARD WOULD SILENTLY NOT
                // BE RECORDED. Functionally unreachable from the SendMo UI
                // (Stripe Elements forces sequential card-save flows; a user
                // can't double-confirm two SetupIntents in parallel), so we
                // accept the trade rather than wrapping in a stored proc.
                // If the race ever surfaces, fix path is: SELECT FOR UPDATE
                // on the count, or move the whole INSERT into a Postgres
                // function with an advisory lock keyed on user_id.
                const { count } = await supabase
                    .from("payment_methods")
                    .select("id", { count: "exact", head: true })
                    .eq("user_id", userId)
                    .eq("mode", mode)
                    .is("deleted_at", null);
                const setDefault = (count ?? 0) === 0;

                const { error: pmErr } = await supabase.from("payment_methods").insert({
                    user_id: userId,
                    stripe_payment_method_id: pm.id,
                    mode,
                    funding_source: pm.type === "us_bank_account" ? "us_bank_account" : "card",
                    brand: pm.card?.brand ?? null,
                    last4: pm.card?.last4 ?? null,
                    exp_month: pm.card?.exp_month ?? null,
                    exp_year: pm.card?.exp_year ?? null,
                    is_default: setDefault,
                });
                if (pmErr && !/duplicate key|unique constraint/i.test(pmErr.message)) {
                    throw new Error(`payment_methods insert failed: ${pmErr.message}`);
                }
                // The `duplicate key` swallow above covers two legitimate
                // cases — (a) Stripe webhook retry replays the same event,
                // (b) user-initiated DELETE already wrote a soft-delete row
                // that collides on (user_id, stripe_payment_method_id). It
                // ALSO masks the I2 race described above; that's a known
                // trade, not a bug to fix here.

                log({
                    event_type: "stripe.payment_method_attached",
                    severity: "info",
                    entity_type: "payment_method",
                    entity_id: pm.id,
                    properties: {
                        live_mode: liveMode,
                        user_id: userId,
                        brand: pm.card?.brand,
                        last4: pm.card?.last4,
                        is_default: setDefault,
                    },
                });

                // Pattern D (Phase F): when a recipient's first PM lands, flip
                // their draft flex links in this mode to 'active'. Also covers
                // the post-decline recovery path — if the recipient adds a new
                // card after a decline, any draft links activate; existing
                // active-but-Inactive-because-no-PM links re-render Active
                // automatically (computed; no DB write needed).
                if (setDefault) {
                    const { data: activated } = await supabase
                        .from("sendmo_links")
                        .update({ status: "active" })
                        .eq("user_id", userId)
                        .eq("link_type", "flexible")
                        .eq("status", "draft")
                        // sendmo_links has no `mode` column; links carry is_test
                        // (TRUE/FALSE) — match it to the current PM's mode.
                        .eq("is_test", mode === "test")
                        .select("id, short_code");

                    for (const link of activated ?? []) {
                        await supabase.from("link_state_events").insert({
                            link_id: link.id,
                            event: "activated",
                            reason: "first_pm_attached",
                            actor_user: userId,
                            metadata: { stripe_payment_method_id: pm.id, mode },
                        });
                    }
                    if (activated && activated.length > 0) {
                        log({
                            event_type: "stripe.flex_links_activated",
                            severity: "info",
                            entity_type: "payment_method",
                            entity_id: pm.id,
                            properties: {
                                user_id: userId,
                                mode,
                                activated_count: activated.length,
                            },
                        });
                    }
                }
                break;
            }

            case "payment_method.detached": {
                // Soft-delete + promote next default if needed.
                // Note: the detach event's pm.customer is often null (the PM
                // was just detached from the customer). Look up the row by
                // pm.id directly.
                const pm = obj as PaymentMethodObj;
                const { data: row } = await supabase
                    .from("payment_methods")
                    .select("id, user_id, mode, is_default")
                    .eq("stripe_payment_method_id", pm.id)
                    .is("deleted_at", null)
                    .maybeSingle();
                if (!row) {
                    // Already soft-deleted by the user-initiated DELETE path,
                    // or the row never existed. Idempotent no-op.
                    break;
                }

                await supabase
                    .from("payment_methods")
                    .update({ deleted_at: new Date().toISOString() })
                    .eq("id", row.id);

                // Auto-promote next default (Phase B N3): if the detached
                // card was default, find most-recent remaining active card
                // for the same (user, mode) and flip it to default.
                if (row.is_default) {
                    const { data: next } = await supabase
                        .from("payment_methods")
                        .select("id")
                        .eq("user_id", row.user_id)
                        .eq("mode", row.mode)
                        .is("deleted_at", null)
                        .neq("id", row.id)
                        .order("created_at", { ascending: false })
                        .limit(1)
                        .maybeSingle();
                    if (next?.id) {
                        await supabase
                            .from("payment_methods")
                            .update({ is_default: true })
                            .eq("id", next.id);
                    }
                }

                log({
                    event_type: "stripe.payment_method_detached",
                    severity: "info",
                    entity_type: "payment_method",
                    entity_id: pm.id,
                    properties: { live_mode: liveMode, user_id: row.user_id, was_default: row.is_default },
                });

                // Pattern D (Phase F): write link_state_events.pm_detached for
                // the user's active flex links in this mode. Useful for
                // support diagnostics ("why did this link suddenly go
                // Inactive?"). Pattern D's is_funded query will report
                // Inactive on next GET (no DB UPDATE needed — computed).
                if (row.is_default) {
                    const { data: flexLinks } = await supabase
                        .from("sendmo_links")
                        .select("id")
                        .eq("user_id", row.user_id)
                        .eq("link_type", "flexible")
                        .eq("is_test", row.mode === "test")
                        .eq("status", "active");
                    for (const link of flexLinks ?? []) {
                        await supabase.from("link_state_events").insert({
                            link_id: link.id,
                            event: "pm_detached",
                            reason: "default_pm_removed",
                            metadata: { stripe_payment_method_id: pm.id, mode: row.mode },
                        });
                    }
                }
                break;
            }

            case "payment_method.updated":
            case "payment_method.automatically_updated": {
                // Pattern D (Phase F). Two distinct events handled by the same
                // logic:
                //   .updated              → manual update (dashboard / API)
                //   .automatically_updated → Card Account Updater (CAU) push
                //                           from Visa/MC/Amex; issuer reissued
                //                           the card
                // Refresh our cached metadata (brand/last4/exp) so is_funded's
                // expiry check stays accurate. On brand change (CAU swapping
                // Visa→MC etc.), write a link_state_events.pm_expired row for
                // every active flex link the user owns — useful audit, no
                // behavioral change (Pattern D's is_funded re-evaluates from
                // the updated payment_methods row on next render).
                const pm = obj as PaymentMethodObj;
                const previous = (event.data as { previous_attributes?: { card?: { brand?: string } } } | undefined)
                    ?.previous_attributes;
                const brandChanged = !!(previous?.card?.brand && previous.card.brand !== pm.card?.brand);

                const { data: row } = await supabase
                    .from("payment_methods")
                    .select("id, user_id, mode, brand")
                    .eq("stripe_payment_method_id", pm.id)
                    .is("deleted_at", null)
                    .maybeSingle();

                if (!row) {
                    // Not ours (e.g., PM attached to a non-SendMo customer).
                    log({
                        event_type: "stripe.pm_updated_orphan",
                        severity: "info",
                        entity_type: "payment_method",
                        entity_id: pm.id,
                        properties: { event_type: eventType, live_mode: liveMode },
                    });
                    break;
                }

                await supabase
                    .from("payment_methods")
                    .update({
                        brand: pm.card?.brand ?? null,
                        last4: pm.card?.last4 ?? null,
                        exp_month: pm.card?.exp_month ?? null,
                        exp_year: pm.card?.exp_year ?? null,
                    })
                    .eq("id", row.id);

                if (brandChanged) {
                    // CAU-induced brand swap (e.g. issuer reissued the card as
                    // a different network). We log against the affected flex
                    // links so support can see the change history. Using the
                    // 'pm_expired' event from the CHECK enum because the
                    // semantic effect is the same — the prior card identity
                    // is dead. A `brand_changed` event value would be more
                    // semantically precise; deferred to a future migration
                    // that revises the enum.
                    const { data: flexLinks } = await supabase
                        .from("sendmo_links")
                        .select("id")
                        .eq("user_id", row.user_id)
                        .eq("link_type", "flexible")
                        .eq("is_test", row.mode === "test")
                        .eq("status", "active");
                    for (const link of flexLinks ?? []) {
                        await supabase.from("link_state_events").insert({
                            link_id: link.id,
                            event: "pm_expired",
                            reason: `brand_changed: ${previous?.card?.brand} → ${pm.card?.brand ?? "unknown"}`,
                            metadata: { stripe_payment_method_id: pm.id, mode: row.mode, source_event: eventType },
                        });
                    }
                }

                log({
                    event_type: eventType === "payment_method.automatically_updated"
                        ? "stripe.pm_auto_updated"
                        : "stripe.pm_updated",
                    severity: brandChanged ? "warn" : "info",
                    entity_type: "payment_method",
                    entity_id: pm.id,
                    properties: {
                        live_mode: liveMode,
                        user_id: row.user_id,
                        brand_changed: brandChanged,
                        new_brand: pm.card?.brand,
                        new_last4: pm.card?.last4,
                    },
                });
                break;
            }

            default:
                // Recorded for audit, no DB mutation.
                break;
        }

        // Record the event AFTER processing so a retry runs again on throw.
        await supabase.from("webhook_events").insert({
            event_id: eventId,
            source: "stripe",
            event_type: eventType,
            payload: event,
            processed: true,
        });

        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "handler error";
        console.error("[stripe-webhook] handler error:", msg);
        log({
            event_type: "stripe.webhook_handler_error",
            severity: "error",
            entity_type: "webhook_event",
            entity_id: eventId,
            properties: { error_message: msg, event_type: eventType },
        });
        return new Response(JSON.stringify({ error: msg }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
});
