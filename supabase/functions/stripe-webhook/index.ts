import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { verifyAndParseWebhook } from "../_shared/stripe.ts";

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
                        status: "succeeded",
                        mode,
                        idempotency_key: `pi.${piId}:create`,
                        last_event_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    }, { onConflict: "stripe_intent_id" });
                }

                // (2) Append +charge ledger row.
                // user_id falls back to the system-profile UUID for events whose
                // metadata.sendmo_user_id is missing (pre-Phase-A in-flight PIs).
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

                log({
                    event_type: "stripe.payment_succeeded",
                    severity: "info",
                    entity_type: "payment_intent",
                    entity_id: piId,
                    properties: { amount_cents: amountCents, live_mode: liveMode, shipment_id, link_id },
                });
                break;
            }

            case "payment_intent.payment_failed": {
                const pi = obj as PaymentIntentObj;
                const piId = pi.id;
                const failureReason = pi.last_payment_error?.message ?? null;
                const meta = pi.metadata || {};
                const { user_id, link_id, shipment_id, intent_role } = resolveIdsFromMetadata(meta);

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
                    properties: { failure_reason: failureReason, live_mode: liveMode },
                });
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

            case "setup_intent.succeeded": {
                // Mirror SetupIntent state to stripe_intents. Card data
                // (brand/last4/exp) is NOT on this event — see Phase B B1
                // fix; that lives on payment_method.attached.
                const seti = obj as SetupIntentObj;
                const userId = await resolveUserByCustomer(supabase, seti.customer, liveMode);
                if (userId) {
                    await supabase.from("stripe_intents").upsert({
                        user_id: userId,
                        stripe_intent_id: seti.id,
                        intent_kind: "setup",
                        funding_source: "card",
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
