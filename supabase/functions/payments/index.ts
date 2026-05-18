import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import {
    createPaymentIntent,
    createCustomerSession,
    retrievePaymentIntent,
} from "../_shared/stripe.ts";

// POST /payments
//
// Creates a Stripe PaymentIntent for the FULL-LABEL flow only.
//
// Full-label (immediate capture): recipient knows exact price upfront at
// step 12; Stripe charges card immediately; EasyPost mints label.
//   Request: { easypost_shipment_id, amount_cents, live_mode?,
//              receipt_email?, description? }
//   Stripe: capture_method='automatic', tied to easypost_shipment_id.
//   Response: { client_secret, payment_intent_id, status,
//               customer_session_client_secret? }
//
// FLEX-LINK FLOW (Pattern D — decided 2026-05-18) does NOT use this
// endpoint. Flex links collect the card via the SetupIntent flow at
// /payment-methods, then per-shipment charges happen off_session inside
// labels/index.ts via createOffSessionShipmentPI. The prior Phase E
// `flex_hold` intent_role branch was removed in this same PR.
//
// See proposals/2026-05-16_flex-payment-pattern-d-execution_reviewed-
// 2026-05-16_decided-2026-05-18.md.

interface PaymentsRequestBody {
    easypost_shipment_id?: string;
    receipt_email?: string;
    description?: string;
    amount_cents?: number;
    live_mode?: boolean;
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

serve(async (req: Request) => {
    const corsResponse = handleCors(req);
    if (corsResponse) return corsResponse;

    if (req.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const sessionId = req.headers.get("x-session-id") || "unknown";
    const start = Date.now();

    try {
        const body = (await req.json()) as PaymentsRequestBody;

        // Reject legacy flex_hold callers cleanly. If anything in-flight
        // tries to hit this endpoint with the old shape, surface a clear
        // error rather than silently routing through full-label.
        const legacyIntentRole = (body as { intent_role?: string }).intent_role;
        if (legacyIntentRole === "flex_hold") {
            return jsonResponse(
                {
                    error: "flex_hold intent_role removed (Pattern D, 2026-05-18). " +
                        "Use the SetupIntent flow at /payment-methods to save a card; " +
                        "flex shipments charge off_session inside labels/.",
                },
                410,
            );
        }

        const { amount_cents, live_mode } = body;
        if (typeof amount_cents !== "number" || amount_cents < 50) {
            return jsonResponse({ error: "amount_cents must be a number >= 50" }, 400);
        }
        if (!body.easypost_shipment_id || typeof body.easypost_shipment_id !== "string") {
            return jsonResponse(
                { error: "Missing required field: easypost_shipment_id" }, 400,
            );
        }

        const clientWantsLive = live_mode === true;

        // Resolve the calling user from the JWT, when present. Optional for
        // full-label — anonymous PIs are permitted but get no saved-PM display.
        let resolvedUserId: string | null = null;
        let callerRole: string | null = null;
        let callerAdminMode: string = "test";
        let customerIdTest: string | null = null;
        let customerIdLive: string | null = null;
        const sbUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("VITE_SUPABASE_URL");
        const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SB_SERVICE_ROLE_KEY");
        const sbAdmin = sbUrl && sbKey
            ? createClient(sbUrl, sbKey, { auth: { autoRefreshToken: false, persistSession: false } })
            : null;
        const authHeader = req.headers.get("Authorization") || req.headers.get("authorization") || "";
        const token = authHeader.replace(/^Bearer\s+/i, "");
        const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("VITE_SUPABASE_ANON_KEY") || "";
        if (token && token !== anonKey && sbAdmin) {
            const { data: userResp } = await sbAdmin.auth.getUser(token);
            if (userResp?.user?.id) {
                resolvedUserId = userResp.user.id;
                const { data: profile } = await sbAdmin
                    .from("profiles")
                    .select("role, admin_active_mode, stripe_customer_id_test, stripe_customer_id_live")
                    .eq("id", resolvedUserId)
                    .maybeSingle();
                callerRole = (profile?.role as string) ?? null;
                callerAdminMode = (profile?.admin_active_mode as string) ?? "test";
                customerIdTest = (profile?.stripe_customer_id_test as string) ?? null;
                customerIdLive = (profile?.stripe_customer_id_live as string) ?? null;
            }
        }

        // Server-derived liveMode (PLAYBOOK Rule 14, master proposal §4.4).
        const isLive = clientWantsLive && callerRole === "admin" && callerAdminMode === "live_charge";

        // Live-charge allowlist gate (Phase C dogfood window).
        if (isLive) {
            const allowlist = (Deno.env.get("PAYMENTS_ALLOWED_USERS") || "")
                .split(",").map((s) => s.trim()).filter(Boolean);
            if (!resolvedUserId || !allowlist.includes(resolvedUserId)) {
                log({
                    event_type: "payment.live_charge_blocked",
                    session_id: sessionId,
                    severity: "warn",
                    entity_type: "payment_intent",
                    properties: {
                        user_id: resolvedUserId,
                        reason: !resolvedUserId
                            ? "no_resolved_user"
                            : allowlist.length === 0
                                ? "allowlist_empty"
                                : "user_not_allowlisted",
                    },
                });
                return jsonResponse(
                    { error: "Live charges are not enabled for this account." }, 403,
                );
            }
        }

        // ─── Full-label PI creation ─────────────────────────────────────
        const customerForPi = (isLive ? customerIdLive : customerIdTest) ?? undefined;

        const idempotencyKey = customerForPi
            ? `pi_create_${body.easypost_shipment_id}_${customerForPi}`
            : `pi_create_${body.easypost_shipment_id}`;

        const pi = await createPaymentIntent({
            amount_cents,
            currency: "usd",
            capture_method: "automatic",
            customer: customerForPi,
            metadata: {
                easypost_shipment_id: body.easypost_shipment_id,
                session_id: sessionId,
                source: "sendmo_full_label",
                intent_role: "shipment",
                // sendmo_user_id is the key the stripe-webhook resolver reads
                // (resolveIdsFromMetadata in stripe-webhook/index.ts).
                ...(resolvedUserId ? { sendmo_user_id: resolvedUserId } : {}),
                ...(body.description ? { description: body.description } : {}),
            },
            receipt_email: body.receipt_email,
            idempotency_key: idempotencyKey,
            liveMode: isLive,
        });

        let customerSessionClientSecret: string | null = null;
        if (customerForPi) {
            try {
                const cs = await createCustomerSession({ customer: customerForPi, liveMode: isLive });
                customerSessionClientSecret = cs.client_secret;
            } catch (csErr) {
                log({
                    event_type: "payment.customer_session_failed",
                    session_id: sessionId,
                    severity: "warn",
                    entity_type: "customer_session",
                    properties: {
                        error_message: csErr instanceof Error ? csErr.message : "unknown",
                        customer_id: customerForPi,
                        live_mode: isLive,
                    },
                });
            }
        }

        log({
            event_type: "payment.intent_created",
            session_id: sessionId,
            severity: "info",
            entity_type: "payment_intent",
            entity_id: pi.id,
            duration_ms: Date.now() - start,
            properties: {
                amount_cents: pi.amount, currency: pi.currency, status: pi.status,
                easypost_shipment_id: body.easypost_shipment_id,
                live_mode: isLive,
                intent_role: "shipment",
                has_customer_session: customerSessionClientSecret !== null,
            },
        });

        return jsonResponse({
            client_secret: pi.client_secret,
            payment_intent_id: pi.id,
            status: pi.status,
            customer_session_client_secret: customerSessionClientSecret,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Internal server error";
        console.error(`[Session ${sessionId}] [payments] error:`, msg);
        log({
            event_type: "payment.intent_error",
            session_id: sessionId,
            severity: "error",
            entity_type: "payment_intent",
            duration_ms: Date.now() - start,
            properties: { error_message: msg },
        });
        return jsonResponse({ error: msg }, 500);
    }
});

// Re-export so other helpers (label flow) can verify a PI exists + succeeded
export { retrievePaymentIntent };
