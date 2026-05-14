import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { createPaymentIntent, createCustomerSession, retrievePaymentIntent } from "../_shared/stripe.ts";

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

        const clientWantsLive = live_mode === true;

        // Resolve the calling user from the JWT, when present. The full-label
        // flow now reaches this endpoint authenticated (proposal
        // 2026-05-11_account-creation-timing). Stamping metadata.user_id on the
        // PI is groundwork for Phase B (Stripe Customer dedup).
        let resolvedUserId: string | null = null;
        let callerRole: string | null = null;
        let callerAdminMode: string = "test";
        let customerIdTest: string | null = null;
        let customerIdLive: string | null = null;
        const authHeader = req.headers.get("Authorization") || req.headers.get("authorization") || "";
        const token = authHeader.replace(/^Bearer\s+/i, "");
        const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("VITE_SUPABASE_ANON_KEY") || "";
        if (token && token !== anonKey) {
            const sbUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("VITE_SUPABASE_URL");
            const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SB_SERVICE_ROLE_KEY");
            if (sbUrl && sbKey) {
                const sb = createClient(sbUrl, sbKey, { auth: { autoRefreshToken: false, persistSession: false } });
                const { data: userResp } = await sb.auth.getUser(token);
                if (userResp?.user?.id) {
                    resolvedUserId = userResp.user.id;
                    const { data: profile } = await sb
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
        }

        // Phase C: server-derived liveMode. The client's live_mode param is
        // accepted ONLY when the caller is admin AND their server-truthed
        // admin_active_mode is 'live_charge'. (Live Comp shouldn't charge —
        // it's the no-Stripe path for comped labels.) PLAYBOOK Rule 14 +
        // master proposal §4.4.
        const isLive = clientWantsLive && callerRole === "admin" && callerAdminMode === "live_charge";

        // Phase C: live-charge allowlist gate. Even with the admin role + mode
        // checks above, restrict live charging to a comma-separated env
        // allowlist of UUIDs during the dogfood window. Empty allowlist =
        // closed (no live charges allowed). Round-1 P3 in the master Stripe
        // proposal §6 Phase C row.
        if (isLive) {
            const allowlist = (Deno.env.get("PAYMENTS_ALLOWED_USERS") || "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
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
                return new Response(
                    JSON.stringify({ error: "Live charges are not enabled for this account." }),
                    { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }
        }

        // Idempotency key: shipment_id ensures the same shipment never
        // gets two PaymentIntents. Stripe will return the existing PI if
        // we hit this endpoint again with the same key.
        const idempotencyKey = `pi_create_${easypost_shipment_id}`;

        // Mode-matched Customer (when the user has saved cards). Passing
        // customer to the PI lets PaymentElement render saved PMs as the
        // top option on the sender-flow payment step. Mode mismatch (test
        // PI with live Customer or vice versa) would 400 at Stripe, so we
        // only pass when isLive lines up with the stored Customer ID.
        const customerForPi = (isLive ? customerIdLive : customerIdTest) ?? undefined;

        const pi = await createPaymentIntent({
            amount_cents,
            currency: "usd",
            capture_method: "automatic", // full-label flow charges immediately
            customer: customerForPi,
            metadata: {
                easypost_shipment_id,
                session_id: sessionId,
                source: "sendmo_full_label",
                ...(resolvedUserId ? { user_id: resolvedUserId } : {}),
                ...(description ? { description } : {}),
            },
            receipt_email,
            idempotency_key: idempotencyKey,
            liveMode: isLive,
        });

        // Customer Session for saved-PM display in PaymentElement (dahlia
        // requirement). Only attempt when we have a customer; failure is
        // non-fatal — the form just falls back to bare new-card entry.
        let customerSessionClientSecret: string | null = null;
        if (customerForPi) {
            try {
                const cs = await createCustomerSession({
                    customer: customerForPi,
                    liveMode: isLive,
                });
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
                has_customer_session: customerSessionClientSecret !== null,
            },
        });

        return new Response(
            JSON.stringify({
                client_secret: pi.client_secret,
                payment_intent_id: pi.id,
                status: pi.status,
                customer_session_client_secret: customerSessionClientSecret,
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
