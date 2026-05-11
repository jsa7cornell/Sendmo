import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { createPaymentIntent, retrievePaymentIntent } from "../_shared/stripe.ts";

// POST /payments
//
// Creates (or retrieves the existing) Stripe PaymentIntent for a SendMo
// shipment. The `easypost_shipment_id` is the natural idempotency key —
// retries from a flaky network won't double-charge, and the same call
// from a refreshed page returns the same client_secret.
//
// Request body:
//   { easypost_shipment_id: string,
//     amount_cents: number,           // total inc. SendMo margin + insurance
//     live_mode?: boolean,            // defaults to false (test mode)
//     receipt_email?: string,
//     description?: string }
//
// Response:
//   { client_secret: string, payment_intent_id: string, status: string }

serve(async (req: Request) => {
    const corsResponse = handleCors(req);
    if (corsResponse) return corsResponse;

    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    const sessionId = req.headers.get("x-session-id") || "unknown";
    const start = Date.now();

    try {
        const {
            easypost_shipment_id,
            amount_cents,
            live_mode,
            receipt_email,
            description,
        } = await req.json();

        if (!easypost_shipment_id || typeof easypost_shipment_id !== "string") {
            return new Response(
                JSON.stringify({ error: "Missing required field: easypost_shipment_id" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }
        if (typeof amount_cents !== "number" || amount_cents < 50) {
            return new Response(
                JSON.stringify({ error: "amount_cents must be a number >= 50" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const isLive = live_mode === true;

        // Idempotency key: shipment_id ensures the same shipment never
        // gets two PaymentIntents. Stripe will return the existing PI if
        // we hit this endpoint again with the same key.
        const idempotencyKey = `pi_create_${easypost_shipment_id}`;

        const pi = await createPaymentIntent({
            amount_cents,
            currency: "usd",
            capture_method: "automatic", // full-label flow charges immediately
            metadata: {
                easypost_shipment_id,
                session_id: sessionId,
                source: "sendmo_full_label",
                ...(description ? { description } : {}),
            },
            receipt_email,
            idempotency_key: idempotencyKey,
            liveMode: isLive,
        });

        const elapsed = Date.now() - start;
        log({
            event_type: "payment.intent_created",
            session_id: sessionId,
            severity: "info",
            entity_type: "payment_intent",
            entity_id: pi.id,
            duration_ms: elapsed,
            properties: {
                amount_cents: pi.amount,
                currency: pi.currency,
                status: pi.status,
                easypost_shipment_id,
                live_mode: isLive,
            },
        });

        return new Response(
            JSON.stringify({
                client_secret: pi.client_secret,
                payment_intent_id: pi.id,
                status: pi.status,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Internal server error";
        const elapsed = Date.now() - start;
        console.error(`[Session ${sessionId}] [payments] error:`, msg);
        log({
            event_type: "payment.intent_error",
            session_id: sessionId,
            severity: "error",
            entity_type: "payment_intent",
            duration_ms: elapsed,
            properties: { error_message: msg },
        });
        return new Response(
            JSON.stringify({ error: msg }),
            { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});

// Re-export so other helpers (label flow) can verify a PI exists + succeeded
export { retrievePaymentIntent };
