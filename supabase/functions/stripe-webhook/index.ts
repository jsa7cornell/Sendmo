import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { verifyAndParseWebhook } from "../_shared/stripe.ts";

// POST /stripe-webhook
//
// Receives webhook events from Stripe (test + live, same endpoint —
// signature verification picks the right secret). Handles a small set
// of payment lifecycle events we care about:
//
//   - payment_intent.succeeded         → mark payment captured
//   - payment_intent.payment_failed    → mark payment failed
//   - charge.refunded                  → mark payment refunded
//   - charge.dispute.created           → flag for review
//
// Idempotent on event.id via the webhook_events table.

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

    // Idempotency check via webhook_events table
    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: existing } = await supabase
        .from("webhook_events")
        .select("id")
        .eq("id", eventId)
        .maybeSingle();
    if (existing) {
        return new Response(JSON.stringify({ ok: true, deduped: true }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    // Handle the events we care about. Unknown events get a 200 OK with no
    // action — Stripe will stop retrying. We still record them so we have
    // a trail of what was sent.
    try {
        const obj = (event.data as { object?: Record<string, unknown> })?.object || {};

        switch (eventType) {
            case "payment_intent.succeeded": {
                const piId = obj.id as string;
                const amountCents = obj.amount as number;
                await supabase
                    .from("payments")
                    .update({ status: "captured", amount_cents: amountCents, updated_at: new Date().toISOString() })
                    .eq("stripe_payment_intent_id", piId);
                log({
                    event_type: "stripe.payment_succeeded",
                    severity: "info",
                    entity_type: "payment_intent",
                    entity_id: piId,
                    properties: { amount_cents: amountCents, live_mode: liveMode },
                });
                break;
            }
            case "payment_intent.payment_failed": {
                const piId = obj.id as string;
                const failureReason =
                    (obj.last_payment_error as { message?: string } | undefined)?.message ?? null;
                await supabase
                    .from("payments")
                    .update({ status: "failed", updated_at: new Date().toISOString() })
                    .eq("stripe_payment_intent_id", piId);
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
                const piId = obj.payment_intent as string;
                if (piId) {
                    await supabase
                        .from("payments")
                        .update({ status: "refunded", updated_at: new Date().toISOString() })
                        .eq("stripe_payment_intent_id", piId);
                }
                log({
                    event_type: "stripe.charge_refunded",
                    severity: "info",
                    entity_type: "payment_intent",
                    entity_id: piId,
                    properties: { live_mode: liveMode },
                });
                break;
            }
            case "charge.dispute.created": {
                const piId = obj.payment_intent as string | undefined;
                log({
                    event_type: "stripe.dispute_opened",
                    severity: "error",
                    entity_type: "payment_intent",
                    entity_id: piId ?? null,
                    properties: {
                        amount_cents: obj.amount as number,
                        reason: obj.reason as string,
                        live_mode: liveMode,
                    },
                });
                // No automatic action — needs human review (Stripe dashboard).
                break;
            }
            default:
                // Recorded for audit, no DB mutation
                break;
        }

        // Insert event record AFTER processing — if processing throws we don't
        // mark it processed, so a retry will run again.
        await supabase.from("webhook_events").insert({
            id: eventId,
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
