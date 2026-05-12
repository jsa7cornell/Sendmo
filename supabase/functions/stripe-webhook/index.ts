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
