import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { sendEmail } from "../_shared/resend.ts";
import { labelConfirmationEmail } from "../_shared/email-templates.ts";
import { retrievePaymentIntent, createRefund } from "../_shared/stripe.ts";

// Pricing markup MUST stay in sync with supabase/functions/rates/index.ts.
// Server-derives display_price_cents from EasyPost rate for the flex-link
// cap check (proposal 2026-05-11_sender-flow-wizard §3.6 / B5: client-supplied
// display_price_cents is not trusted).
const MARKUP_MULTIPLIER = 1.15;
const MARKUP_FLAT_CENTS = 100;

function applyMarkup(rateDollars: number): number {
    return Math.round(rateDollars * 100 * MARKUP_MULTIPLIER) + MARKUP_FLAT_CENTS;
}

serve(async (req: Request) => {
    // Handle CORS preflight
    const corsResponse = handleCors(req);
    if (corsResponse) return corsResponse;

    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    const sessionId = req.headers.get("x-session-id") || "unknown";

    try {
        const {
            easypost_shipment_id,
            easypost_rate_id,
            live_mode,
            from_address,
            to_address: bodyToAddress,
            parcel,
            display_price_cents: bodyDisplayPriceCents,
            recipient_email: bodyRecipientEmail,
            sender_email,
            payment_intent_id,
            comp,  // admin override — bypass payment requirement (live comp labels)
            link_short_code,  // sender-flow flex-link auth claim
        } = await req.json();

        // Per proposal 2026-05-11_sender-flow-wizard B3: when link_short_code is
        // present, the server resolves to_address + recipient_email and ignores
        // any client-supplied values for those fields. This prevents an attacker
        // from buying a label to a different address than the recipient set.
        let to_address = bodyToAddress;
        let recipient_email = bodyRecipientEmail;
        let display_price_cents = bodyDisplayPriceCents;

        if (!easypost_shipment_id || !easypost_rate_id) {
            return new Response(
                JSON.stringify({ error: "Missing required fields: easypost_shipment_id, easypost_rate_id" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const isLive = live_mode === true;
        const isComp = comp === true;

        // Service-role Supabase client (shared between link resolution and
        // post-buy persistence). Created lazily — only when we need it.
        const sbUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("VITE_SUPABASE_URL");
        const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SB_SERVICE_ROLE_KEY");
        const supabase = (sbUrl && sbKey)
            ? createClient(sbUrl, sbKey, { auth: { autoRefreshToken: false, persistSession: false } })
            : null;

        // ─── Flex-link resolution (proposal §3.5 + §3.6 + B3/B5) ─
        // When link_short_code is present, the server:
        //   1. Validates the link is active and is a flex link
        //   2. Resolves to_address from sendmo_links → addresses (FK)
        //   3. Resolves recipient_email from sendmo_links.user_id → profiles.email
        //   4. Server-derives display_price_cents from EasyPost rate and
        //      compares to link.max_price_cents (cap re-check)
        // The flex-link is the auth claim that authorizes the `comp` path —
        // see comp gate below.
        let resolvedLink: {
            id: string;
            short_code: string;
            user_id: string;
            max_price_cents: number;
        } | null = null;
        if (link_short_code) {
            if (typeof link_short_code !== "string" || !link_short_code.match(/^[a-zA-Z0-9]{1,20}$/)) {
                return new Response(
                    JSON.stringify({ error: "Invalid link_short_code" }),
                    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }
            if (!supabase) {
                return new Response(
                    JSON.stringify({ error: "Server configuration error" }),
                    { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }
            const { data: link, error: linkErr } = await supabase
                .from("sendmo_links")
                .select(`
                    id, short_code, user_id, status, link_type, max_price_cents,
                    recipient_address:addresses!recipient_address_id (
                        name, street1, street2, city, state, zip, country
                    )
                `)
                .eq("short_code", link_short_code)
                .single();
            if (linkErr || !link) {
                return new Response(
                    JSON.stringify({ error: "Link not found" }),
                    { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }
            if (link.status !== "active") {
                return new Response(
                    JSON.stringify({ error: `Link not active (status=${link.status})` }),
                    { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }
            // The DB stores 'flexible' (not 'flexible_link') per links/index.ts:189
            // and the migration-001 CHECK constraint. Author-response B1.
            if (link.link_type !== "flexible") {
                return new Response(
                    JSON.stringify({ error: "Link is not a flexible link" }),
                    { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }
            // Resolve to_address from the link (ignore any client-supplied value).
            const recipientAddr = link.recipient_address as unknown as {
                name: string; street1: string; street2: string | null;
                city: string; state: string; zip: string; country: string | null;
            } | null;
            if (!recipientAddr || !recipientAddr.street1) {
                return new Response(
                    JSON.stringify({ error: "Link has no resolvable destination address" }),
                    { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }
            to_address = {
                name: recipientAddr.name,
                street1: recipientAddr.street1,
                street2: recipientAddr.street2 ?? undefined,
                city: recipientAddr.city,
                state: recipientAddr.state,
                zip: recipientAddr.zip,
                country: recipientAddr.country ?? "US",
            };
            // Resolve recipient_email server-side (never returned to client).
            const { data: prof } = await supabase
                .from("profiles")
                .select("email")
                .eq("id", link.user_id)
                .single();
            recipient_email = prof?.email ?? null;
            resolvedLink = {
                id: link.id,
                short_code: link.short_code,
                user_id: link.user_id,
                max_price_cents: link.max_price_cents,
            };

            // Server-derive display_price_cents from EasyPost rate (B5).
            // Client-supplied value is used only for audit logging; the gate
            // decision is on the server-derived number.
            const rateLookupKey = Deno.env.get(isLive ? "EASYPOST_API_KEY" : "EASYPOST_TEST_API_KEY");
            if (!rateLookupKey) {
                return new Response(
                    JSON.stringify({ error: `EasyPost ${isLive ? 'Live' : 'Test'} API key not configured` }),
                    { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }
            const rateLookupResp = await fetch(
                `https://api.easypost.com/v2/shipments/${easypost_shipment_id}/rates/${easypost_rate_id}`,
                { headers: { Authorization: "Basic " + btoa(rateLookupKey + ":") } },
            );
            if (!rateLookupResp.ok) {
                // Fallback: pull the rate off the shipment payload (single roundtrip,
                // works regardless of EasyPost's per-rate endpoint availability).
                const shipResp = await fetch(
                    `https://api.easypost.com/v2/shipments/${easypost_shipment_id}`,
                    { headers: { Authorization: "Basic " + btoa(rateLookupKey + ":") } },
                );
                if (!shipResp.ok) {
                    return new Response(
                        JSON.stringify({ error: "Could not verify rate against price cap" }),
                        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                    );
                }
                const shipData = await shipResp.json();
                const matched = (shipData.rates || []).find((r: { id: string }) => r.id === easypost_rate_id);
                if (!matched) {
                    return new Response(
                        JSON.stringify({ error: "Rate not found on shipment" }),
                        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                    );
                }
                const serverCents = applyMarkup(parseFloat(matched.rate));
                if (serverCents > link.max_price_cents) {
                    log({
                        event_type: "label.cap_exceeded",
                        session_id: sessionId,
                        severity: "warn",
                        entity_type: "label",
                        entity_id: easypost_shipment_id,
                        properties: {
                            link_short_code,
                            server_derived_cents: serverCents,
                            client_supplied_cents: bodyDisplayPriceCents ?? null,
                            max_price_cents: link.max_price_cents,
                        },
                    });
                    return new Response(
                        JSON.stringify({ error: "Rate exceeds the recipient's price cap" }),
                        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                    );
                }
                display_price_cents = serverCents;
            } else {
                const rateData = await rateLookupResp.json();
                const serverCents = applyMarkup(parseFloat(rateData.rate));
                if (serverCents > link.max_price_cents) {
                    log({
                        event_type: "label.cap_exceeded",
                        session_id: sessionId,
                        severity: "warn",
                        entity_type: "label",
                        entity_id: easypost_shipment_id,
                        properties: {
                            link_short_code,
                            server_derived_cents: serverCents,
                            client_supplied_cents: bodyDisplayPriceCents ?? null,
                            max_price_cents: link.max_price_cents,
                        },
                    });
                    return new Response(
                        JSON.stringify({ error: "Rate exceeds the recipient's price cap" }),
                        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                    );
                }
                display_price_cents = serverCents;
            }
        }

        // ─── Caller identity (proposal 2026-05-11_account-creation-timing) ─
        // Resolve auth.uid() from the Authorization header when present.
        // Used downstream as shipments.user_id + payments.user_id for the
        // full-label flow now that step 11 verifies email via Supabase Auth
        // before the label call. Falls back to the system placeholder for
        // unauthenticated callers (admin comp without resolvedLink, legacy
        // anon flows during the rollout window).
        let callerUserId: string | null = null;
        {
            const ah = req.headers.get("Authorization") || req.headers.get("authorization") || "";
            const tok = ah.replace(/^Bearer\s+/i, "");
            const anon = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("VITE_SUPABASE_ANON_KEY") || "";
            if (tok && tok !== anon && supabase) {
                const { data: userResp } = await supabase.auth.getUser(tok);
                if (userResp?.user?.id) callerUserId = userResp.user.id;
            }
        }

        // ─── Comp-gate hardening (proposal §3.5) ────────────────
        // `comp: true` is now allowed only when EITHER (a) a valid active flex
        // link authorized the call (resolvedLink !== null), OR (b) the caller
        // has an admin JWT. Anonymous callers with comp=true are rejected.
        if (isComp && !resolvedLink) {
            const authHeader = req.headers.get("Authorization") || req.headers.get("authorization") || "";
            const token = authHeader.replace(/^Bearer\s+/i, "");
            const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("VITE_SUPABASE_ANON_KEY") || "";
            // Anon key carries no user identity; reject early.
            if (!token || token === anonKey) {
                log({
                    event_type: "label.comp_gate_rejected",
                    session_id: sessionId,
                    severity: "warn",
                    entity_type: "label",
                    entity_id: easypost_shipment_id,
                    properties: { reason: "no_jwt_no_link" },
                });
                return new Response(
                    JSON.stringify({ error: "Comp labels require an admin session or a valid flex link" }),
                    { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }
            if (!supabase) {
                return new Response(
                    JSON.stringify({ error: "Server configuration error" }),
                    { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }
            const { data: userResp, error: userErr } = await supabase.auth.getUser(token);
            if (userErr || !userResp?.user) {
                return new Response(
                    JSON.stringify({ error: "Invalid or expired token" }),
                    { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }
            const { data: profile } = await supabase
                .from("profiles")
                .select("role")
                .eq("id", userResp.user.id)
                .single();
            if (profile?.role !== "admin") {
                log({
                    event_type: "label.comp_gate_rejected",
                    session_id: sessionId,
                    severity: "warn",
                    entity_type: "label",
                    entity_id: easypost_shipment_id,
                    properties: { reason: "not_admin", user_id: userResp.user.id },
                });
                return new Response(
                    JSON.stringify({ error: "Comp labels require an admin session or a valid flex link" }),
                    { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }
        }

        // ─── Payment authorization gate ─────────────────────────
        // Every label purchase must reference a captured Stripe PaymentIntent
        // bound to the same easypost_shipment_id. The lone exception is `comp`
        // (admin/internal flow) which records a comp payment after the fact.
        let verifiedPaymentIntent: { id: string; amount: number; status: string } | null = null;
        if (!isComp) {
            if (!payment_intent_id || typeof payment_intent_id !== "string") {
                return new Response(
                    JSON.stringify({ error: "Missing required field: payment_intent_id" }),
                    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }
            try {
                const pi = await retrievePaymentIntent(payment_intent_id, isLive);
                if (pi.status !== "succeeded") {
                    return new Response(
                        JSON.stringify({ error: `Payment not captured (status=${pi.status})` }),
                        { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                    );
                }
                if (pi.metadata?.easypost_shipment_id !== easypost_shipment_id) {
                    // Hard refuse: prevents one paid PI from being replayed against
                    // a different shipment.
                    log({
                        event_type: "label.pi_shipment_mismatch",
                        session_id: sessionId,
                        severity: "error",
                        entity_type: "payment_intent",
                        entity_id: payment_intent_id,
                        properties: {
                            requested_shipment_id: easypost_shipment_id,
                            pi_metadata_shipment_id: pi.metadata?.easypost_shipment_id ?? null,
                        },
                    });
                    return new Response(
                        JSON.stringify({ error: "PaymentIntent does not match shipment" }),
                        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                    );
                }
                verifiedPaymentIntent = { id: pi.id, amount: pi.amount, status: pi.status };
            } catch (err) {
                const msg = err instanceof Error ? err.message : "PI verification failed";
                console.error(`[Session ${sessionId}] [labels] PI verify error:`, msg);
                return new Response(
                    JSON.stringify({ error: `Payment verification failed: ${msg}` }),
                    { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }
        }

        const apiKey = Deno.env.get(isLive ? "EASYPOST_API_KEY" : "EASYPOST_TEST_API_KEY");
        if (!apiKey) {
            return new Response(
                JSON.stringify({ error: `EasyPost ${isLive ? 'Live' : 'Test'} API key not configured` }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const authHeader = "Basic " + btoa(apiKey + ":");

        // Create EndShipper (required for USPS labels)
        const endShipperStart = Date.now();
        const endShipperResponse = await fetch(
            "https://api.easypost.com/v2/end_shippers",
            {
                method: "POST",
                headers: {
                    Authorization: authHeader,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    address: {
                        name: Deno.env.get("SENDMO_COMPANY") || "SendMo",
                        company: Deno.env.get("SENDMO_COMPANY") || "SendMo",
                        street1: Deno.env.get("SENDMO_STREET") || "388 Townsend St",
                        city: Deno.env.get("SENDMO_CITY") || "San Francisco",
                        state: Deno.env.get("SENDMO_STATE") || "CA",
                        zip: Deno.env.get("SENDMO_ZIP") || "94107",
                        country: "US",
                        phone: Deno.env.get("SENDMO_PHONE") || "4155550100",
                        email: Deno.env.get("SENDMO_EMAIL") || "shipping@sendmo.co",
                    },
                }),
            }
        );

        const endShipperData = await endShipperResponse.json();
        const endShipperElapsed = Date.now() - endShipperStart;

        if (!endShipperResponse.ok || endShipperData.error) {
            const errorMsg = "Failed to create EndShipper: " + (endShipperData.error?.message || "Unknown error");
            console.error("EndShipper creation failed:", endShipperData);

            log({
                event_type: "label.endshipper_error",
                session_id: sessionId,
                severity: "error",
                entity_type: "label",
                entity_id: easypost_shipment_id,
                duration_ms: endShipperElapsed,
                properties: {
                    easypost_shipment_id,
                    error_message: endShipperData.error?.message ?? "Unknown error",
                    easypost_code: endShipperData.error?.code ?? null,
                    http_status: endShipperResponse.status,
                },
            });

            return new Response(
                JSON.stringify({ error: errorMsg }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Buy the label with EndShipper
        const buyStart = Date.now();
        const buyResponse = await fetch(
            `https://api.easypost.com/v2/shipments/${easypost_shipment_id}/buy`,
            {
                method: "POST",
                headers: {
                    Authorization: authHeader,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    rate: { id: easypost_rate_id },
                    end_shipper_id: endShipperData.id,
                }),
            }
        );

        const buyData = await buyResponse.json();
        const buyElapsed = Date.now() - buyStart;

        if (!buyResponse.ok || buyData.error) {
            const errorMsg = buyData.error?.message || "Failed to purchase label";

            log({
                event_type: "label.buy_error",
                session_id: sessionId,
                severity: "error",
                entity_type: "label",
                entity_id: easypost_shipment_id,
                duration_ms: buyElapsed,
                properties: {
                    easypost_shipment_id,
                    easypost_rate_id,
                    error_message: errorMsg,
                    easypost_code: buyData.error?.code ?? null,
                    http_status: buyResponse.status,
                },
            });

            // Auto-refund the captured payment if EasyPost couldn't deliver
            // the label. The user has been charged but has nothing to ship,
            // so this is a hard failure mode we need to make right.
            if (verifiedPaymentIntent) {
                try {
                    const refund = await createRefund({
                        payment_intent_id: verifiedPaymentIntent.id,
                        reason: "requested_by_customer",
                        metadata: {
                            easypost_shipment_id,
                            failure_reason: "easypost_buy_failed",
                            easypost_error: String(buyData.error?.code ?? "unknown"),
                        },
                        idempotency_key: `refund_${easypost_shipment_id}_buy_failed`,
                        liveMode: isLive,
                    });
                    log({
                        event_type: "label.auto_refund_issued",
                        session_id: sessionId,
                        severity: "warn",
                        entity_type: "payment_intent",
                        entity_id: verifiedPaymentIntent.id,
                        properties: { refund_id: refund.id, amount_cents: refund.amount, easypost_shipment_id },
                    });
                } catch (refundErr) {
                    // Refund failed — this is bad. The user was charged and
                    // we can't programmatically make it right. Log loud and
                    // surface in the response so the UI can tell the user
                    // to contact support.
                    const refundMsg = refundErr instanceof Error ? refundErr.message : String(refundErr);
                    console.error(`[Session ${sessionId}] [labels] AUTO-REFUND FAILED:`, refundMsg);
                    log({
                        event_type: "label.auto_refund_failed",
                        session_id: sessionId,
                        severity: "error",
                        entity_type: "payment_intent",
                        entity_id: verifiedPaymentIntent.id,
                        properties: { error_message: refundMsg, easypost_shipment_id },
                    });
                    return new Response(
                        JSON.stringify({
                            error: errorMsg,
                            payment_charged: true,
                            refund_failed: true,
                            payment_intent_id: verifiedPaymentIntent.id,
                            support_message: "Payment was charged but label generation failed and the automatic refund could not be processed. Please contact support@sendmo.co with this reference: " + verifiedPaymentIntent.id,
                        }),
                        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                    );
                }
            }

            return new Response(
                JSON.stringify({ error: errorMsg, refunded: !!verifiedPaymentIntent }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const carrier = buyData.selected_rate?.carrier || "";
        const service = buyData.selected_rate?.service || "";
        const trackingNumber = buyData.tracking_code;

        // Log: successful label purchase
        log({
            event_type: "label.created",
            session_id: sessionId,
            severity: "info",
            entity_type: "label",
            entity_id: easypost_shipment_id,
            duration_ms: buyElapsed,
            properties: {
                easypost_shipment_id,
                easypost_rate_id,
                tracking_number: trackingNumber ?? null,
                carrier,
                service,
                rate_cost: buyData.selected_rate?.rate ?? null,
                label_url: buyData.postage_label?.label_url ?? null,
                live_mode: isLive,
            },
        });

        // ─── DB persistence — AWAITED (proposal B2/B4) ──────────
        // The RPC is awaited so we can return public_code + shipment_id in
        // the response body. Email send remains fire-and-forget; payment-row
        // insert is awaited. This is the same `await`-discipline shift Stripe
        // Phase A round-2 B2 mandates; landing it here pre-empts that work.
        let dbShipmentId: string | null = null;
        let dbPublicCode: string | null = null;
        let dbShortCode: string | null = null;
        let dbCancelToken: string | null = null;
        if (from_address && to_address && supabase) {
            try {
                const { data, error } = await supabase.rpc('admin_insert_shipment', {
                    // Sender-flow flex-link shipments are owned by the link
                    // recipient (so they show up in their Dashboard). The
                    // system-user placeholder remains the right answer for
                    // admin-comp full-label flows that have no resolved link.
                    // Owner preference: flex-link recipient first (sender-flow case),
                    // then the authenticated caller (full-label after OTP per proposal
                    // 2026-05-11_account-creation-timing), then the system placeholder
                    // (admin comp with no link, legacy anon flows during rollout).
                    p_user_id: resolvedLink?.user_id ?? callerUserId ?? '00000000-0000-0000-0000-000000000001',
                    p_from_name: from_address.name,
                    p_from_street1: from_address.street1,
                    p_from_street2: from_address.street2 ?? null,
                    p_from_city: from_address.city,
                    p_from_state: from_address.state,
                    p_from_zip: from_address.zip,
                    p_from_country: from_address.country ?? 'US',
                    p_to_name: to_address.name,
                    p_to_street1: to_address.street1,
                    p_to_street2: to_address.street2 ?? null,
                    p_to_city: to_address.city,
                    p_to_state: to_address.state,
                    p_to_zip: to_address.zip,
                    p_to_country: to_address.country ?? 'US',
                    p_carrier: carrier,
                    p_service: service,
                    p_tracking_number: trackingNumber,
                    p_label_url: buyData.postage_label?.label_url || buyData.label_url,
                    p_easypost_shipment_id: easypost_shipment_id,
                    p_easypost_tracker_id: buyData.tracker?.id ?? null,
                    p_rate_cents: Math.round(parseFloat(buyData.selected_rate?.rate || "0") * 100),
                    p_display_price_cents: display_price_cents ?? Math.round(parseFloat(buyData.selected_rate?.rate || "0") * 100),
                    p_weight_oz: parcel?.weight_oz ?? 0,
                    p_length_in: parcel?.length_in ?? 0,
                    p_width_in: parcel?.width_in ?? 0,
                    p_height_in: parcel?.height_in ?? 0,
                    p_is_live: isLive,
                    p_promised_delivery_date: buyData.selected_rate?.delivery_date
                        ? new Date(buyData.selected_rate.delivery_date).toISOString().slice(0, 10)
                        : null
                });
                if (error) {
                    console.error('admin_insert_shipment error:', error);
                    log({
                        event_type: "label.db_persist_error",
                        session_id: sessionId,
                        severity: "error",
                        entity_type: "label",
                        entity_id: easypost_shipment_id,
                        duration_ms: 0,
                        properties: {
                            error_message: error.message,
                            error_details: error.details,
                        }
                    });
                } else {
                    // admin_insert_shipment returns TABLE(out_id, out_public_code, out_short_code) — array of rows.
                    // Migration 019 renamed OUT params with out_ prefix to avoid shadowing column names inside the RPC body.
                    const row = Array.isArray(data) ? data[0] : (data as { out_id: string; out_public_code: string; out_short_code: string } | null);
                    const shipmentId: string | undefined = row?.out_id;
                    const publicCode: string | undefined = row?.out_public_code;
                    const shortCode: string | undefined = row?.out_short_code;
                    dbShipmentId = shipmentId ?? null;
                    dbPublicCode = publicCode ?? null;
                    dbShortCode = shortCode ?? null;

                        // ── Cancel-flow Phase A (migration 020) ────────────
                        // Mint a per-shipment cancel_token used by /t/<code>?cancel=<hex>
                        // and the X-Cancel-Token header path in cancel-label.
                        // Decided proposal: 2026-05-11_label-cancel-and-change_decided-2026-05-12.
                        let mintedCancelToken: string | null = null;
                        if (shipmentId) {
                            try {
                                const tokenBytes = new Uint8Array(32);
                                crypto.getRandomValues(tokenBytes);
                                mintedCancelToken = Array.from(tokenBytes)
                                    .map(b => b.toString(16).padStart(2, '0')).join('');
                                const { error: tokErr } = await supabase
                                    .from('shipments')
                                    .update({ cancel_token: mintedCancelToken })
                                    .eq('id', shipmentId);
                                if (tokErr) {
                                    console.error('cancel_token write error:', tokErr);
                                    mintedCancelToken = null;
                                }
                            } catch (e) {
                                console.error('cancel_token mint error:', e);
                                mintedCancelToken = null;
                            }
                        }
                        dbCancelToken = mintedCancelToken;

                        // For FLEX links, flip status active → in_use. Full-label
                        // links are already minted at in_use by the RPC (migration 020).
                        // Optimistic update — no-op if already in_use (e.g. multi-shipment).
                        if (resolvedLink && resolvedLink.link_type === 'flexible') {
                            const { error: linkErr } = await supabase
                                .from('sendmo_links')
                                .update({ status: 'in_use' })
                                .eq('id', resolvedLink.id)
                                .eq('status', 'active');
                            if (linkErr) {
                                console.error('flex-link in_use flip error:', linkErr);
                            }
                        }

                        log({
                            event_type: "label.db_persisted",
                            session_id: sessionId,
                            severity: "info",
                            entity_type: "label",
                            entity_id: easypost_shipment_id,
                            duration_ms: 0,
                            properties: {
                                shipment_id: shipmentId,
                                public_code: publicCode,
                            }
                        });

                        // Send label-confirmation email now that we have a public_code
                        // and the shipment row is persisted. Synchronizing email send
                        // with DB persist (instead of doing both as siblings) fixes a
                        // latent bug where the email could fire even when persist failed.
                        if (publicCode && recipient_email && typeof recipient_email === "string") {
                            const eta = buyData.selected_rate?.delivery_days
                                ? `${buyData.selected_rate.delivery_days} business days`
                                : "Estimated upon pickup";
                            const trackingUrl = `https://sendmo.co/t/${publicCode}`;
                            const template = labelConfirmationEmail(
                                publicCode,
                                trackingNumber || "Pending",
                                carrier || "Standard",
                                eta,
                                trackingUrl,
                            );
                            sendEmail({
                                to: recipient_email,
                                subject: template.subject,
                                html: template.html,
                            })
                                .then(({ id }) => {
                                    log({
                                        event_type: "email.label_confirmation_sent",
                                        session_id: sessionId,
                                        severity: "info",
                                        entity_type: "label",
                                        entity_id: easypost_shipment_id,
                                        properties: { resend_id: id, public_code: publicCode },
                                    });
                                })
                                .catch((err) => {
                                    console.error("Failed to send label confirmation email:", err);
                                    log({
                                        event_type: "email.label_confirmation_error",
                                        session_id: sessionId,
                                        severity: "error",
                                        entity_type: "label",
                                        entity_id: easypost_shipment_id,
                                        properties: { error_message: err instanceof Error ? err.message : String(err) },
                                    });
                                });
                        }

                        // Store notification contacts for this shipment
                        if (shipmentId) {
                            const contacts: Array<{ shipment_id: string; role: string; channel: string; address: string }> = [];
                            if (recipient_email && typeof recipient_email === "string") {
                                contacts.push({ shipment_id: shipmentId, role: "recipient", channel: "email", address: recipient_email });
                            }
                            if (sender_email && typeof sender_email === "string") {
                                contacts.push({ shipment_id: shipmentId, role: "sender", channel: "email", address: sender_email });
                            }
                            if (contacts.length > 0) {
                                const { error: ncErr } = await supabase.from("notification_contacts").insert(contacts);
                                if (ncErr) {
                                    console.error("notification_contacts insert error:", ncErr);
                                    log({
                                        event_type: "label.notification_contacts_error",
                                        session_id: sessionId,
                                        severity: "error",
                                        entity_type: "shipment",
                                        entity_id: shipmentId,
                                        duration_ms: 0,
                                        properties: { error_message: ncErr.message, count: contacts.length },
                                    });
                                } else {
                                    log({
                                        event_type: "label.notification_contacts_stored",
                                        session_id: sessionId,
                                        severity: "info",
                                        entity_type: "shipment",
                                        entity_id: shipmentId,
                                        duration_ms: 0,
                                        properties: { count: contacts.length },
                                    });
                                }
                            } else {
                                log({
                                    event_type: "label.notification_contacts_none",
                                    session_id: sessionId,
                                    severity: "warn",
                                    entity_type: "shipment",
                                    entity_id: shipmentId,
                                    duration_ms: 0,
                                    properties: { recipient_email_provided: !!recipient_email, sender_email_provided: !!sender_email },
                                });
                            }
                        }

                        // ── Ledger write (Phase A — migration 017) ──────────
                        // Two paths:
                        //   (a) Stripe-charged label → NO LEDGER WRITE HERE.
                        //       Per proposal §3.4 + round-1 B4, the stripe-webhook
                        //       function is the sole writer for charge/refund/
                        //       chargeback transactions. The webhook lands within
                        //       seconds of payment_intent.succeeded and writes the
                        //       +charge and −fee_stripe rows. Reconciliation's 24h
                        //       grace window (§5.4) tolerates the in-flight gap.
                        //
                        //   (b) Admin comp (no Stripe path) → write the comp_grant
                        //       row directly. Awaited (not fire-and-forget) so the
                        //       insert error surfaces and we don't return 200 with
                        //       missing ledger state (round-2 B2 await discipline).
                        if (shipmentId && (isComp || (!verifiedPaymentIntent && isLive))) {
                            const rateCents = Math.round(parseFloat(buyData.selected_rate?.rate || "0") * 100);
                            // comp_grant amount is negative — SendMo absorbs the EasyPost cost.
                            const compAmountCents = -Math.abs(rateCents || display_price_cents || 0);
                            const userId = resolvedLink?.user_id ?? callerUserId ?? '00000000-0000-0000-0000-000000000001';
                            const mode = isLive ? 'live' : 'test';
                            const { error: txErr } = await supabase.from('transactions').insert({
                                user_id: userId,
                                shipment_id: shipmentId,
                                link_id: resolvedLink?.id ?? null,
                                type: 'comp_grant',
                                funding_source: 'comp',
                                amount_cents: compAmountCents,
                                mode,
                                idempotency_key: `label.${easypost_shipment_id}.comp_grant`,
                                description: 'Comp label — SendMo absorbs EasyPost cost',
                            });
                            if (txErr) {
                                console.error('Comp transaction insert error:', txErr);
                                log({
                                    event_type: "label.comp_grant_error",
                                    session_id: sessionId,
                                    severity: "error",
                                    entity_type: "transaction",
                                    entity_id: shipmentId,
                                    properties: { error_message: txErr.message },
                                });
                            } else {
                                log({
                                    event_type: "label.comp_grant_recorded",
                                    session_id: sessionId,
                                    severity: "info",
                                    entity_type: "transaction",
                                    entity_id: shipmentId,
                                    properties: { amount_cents: compAmountCents, rate_cents: rateCents },
                                });
                            }
                        }
                }
            } catch (err) {
                console.error('Unhandled DB insertion error:', err);
                log({
                    event_type: "label.db_persist_unhandled",
                    session_id: sessionId,
                    severity: "error",
                    entity_type: "label",
                    entity_id: easypost_shipment_id,
                    properties: { error_message: err instanceof Error ? err.message : String(err) },
                });
            }
        } else if (from_address && to_address && !supabase) {
            console.error("Missing SUPABASE_URL or SERVICE_ROLE_KEY for label persistence");
        }

        return new Response(
            JSON.stringify({
                tracking_number: trackingNumber,
                label_url: buyData.postage_label?.label_url || buyData.label_url,
                carrier,
                service,
                public_code: dbPublicCode,
                short_code: dbShortCode,
                shipment_id: dbShipmentId,
                cancel_token: dbCancelToken,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    } catch (err) {
        console.error("Label purchase error:", err);
        return new Response(
            JSON.stringify({ error: "Internal server error" }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});
