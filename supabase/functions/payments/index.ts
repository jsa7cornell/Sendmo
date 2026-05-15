import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import {
    createPaymentIntent,
    createCustomer,
    createCustomerSession,
    retrievePaymentIntent,
} from "../_shared/stripe.ts";

// POST /payments
//
// Creates a Stripe PaymentIntent for a SendMo shipment. Two distinct flows:
//
// 1. Full-label (immediate capture) — recipient knows exact price upfront.
//    Request: { easypost_shipment_id, amount_cents, live_mode?,
//               receipt_email?, description? }
//    Stripe: capture_method='automatic', tied to easypost_shipment_id.
//
// 2. Flex-hold (manual capture) — recipient authorizes a hold; sender
//    later picks a rate ≤ hold; labels function captures the actual rate
//    (Phase E, master proposal §3.4).
//    Request: { intent_role: 'flex_hold', link_id, amount_cents, live_mode? }
//    Stripe: capture_method='manual', setup_future_usage='off_session' so
//    the PM is reusable for carrier-adjustment overages (§3.7). Customer
//    is auto-created if missing.
//    Side effects: writes stripe_intents row (intent_role='flex_hold') +
//    holds row (status='authorized', expires_at = now + 7d). The webhook
//    flips sendmo_links.status='active' when Stripe confirms the hold.
//
// Response:
//   { client_secret, payment_intent_id, status,
//     customer_session_client_secret? }

interface PaymentsRequestBody {
    // Discriminator — defaults to 'shipment' (full-label) for backward compat.
    intent_role?: "shipment" | "flex_hold";
    // Full-label fields
    easypost_shipment_id?: string;
    receipt_email?: string;
    description?: string;
    // Flex-hold fields
    link_id?: string;
    // Common
    amount_cents?: number;
    live_mode?: boolean;
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

async function ensureCustomer(
    supabase: ReturnType<typeof createClient>,
    userId: string,
    email: string | null,
    liveMode: boolean,
): Promise<string> {
    const col = liveMode ? "stripe_customer_id_live" : "stripe_customer_id_test";
    const { data: row } = await supabase
        .from("profiles")
        .select(col)
        .eq("id", userId)
        .maybeSingle();

    const existing = (row as Record<string, string | null> | null)?.[col];
    if (existing) return existing;

    const customer = await createCustomer({
        email: email || undefined,
        metadata: { sendmo_user_id: userId, mode: liveMode ? "live" : "test" },
        liveMode,
    });

    await supabase.from("profiles").update({ [col]: customer.id }).eq("id", userId);
    return customer.id;
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
        const intentRole: "shipment" | "flex_hold" =
            body.intent_role === "flex_hold" ? "flex_hold" : "shipment";

        const { amount_cents, live_mode } = body;
        if (typeof amount_cents !== "number" || amount_cents < 50) {
            return jsonResponse({ error: "amount_cents must be a number >= 50" }, 400);
        }

        if (intentRole === "shipment") {
            if (!body.easypost_shipment_id || typeof body.easypost_shipment_id !== "string") {
                return jsonResponse(
                    { error: "Missing required field: easypost_shipment_id" }, 400,
                );
            }
        } else {
            // flex_hold
            if (!body.link_id || typeof body.link_id !== "string") {
                return jsonResponse(
                    { error: "Missing required field: link_id (flex_hold)" }, 400,
                );
            }
        }

        const clientWantsLive = live_mode === true;

        // Resolve the calling user from the JWT, when present. Required for
        // flex_hold (we need a Customer); optional for full-label (anonymous
        // PIs are still permitted but no saved-PM display).
        let resolvedUserId: string | null = null;
        let callerRole: string | null = null;
        let callerAdminMode: string = "test";
        let callerEmail: string | null = null;
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
                callerEmail = userResp.user.email ?? null;
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
                        intent_role: intentRole,
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

        // ─── Branch by intent role ──────────────────────────────────────
        if (intentRole === "flex_hold") {
            return await handleFlexHold({
                sbAdmin,
                resolvedUserId,
                callerEmail,
                isLive,
                customerIdTest,
                customerIdLive,
                linkId: body.link_id!,
                amountCents: amount_cents,
                sessionId,
                start,
            });
        }

        // ─── Full-label (existing immediate-capture path) ───────────────
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
                easypost_shipment_id: body.easypost_shipment_id!,
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

// ─── Flex-hold path ──────────────────────────────────────────────────────

interface FlexHoldArgs {
    sbAdmin: ReturnType<typeof createClient> | null;
    resolvedUserId: string | null;
    callerEmail: string | null;
    isLive: boolean;
    customerIdTest: string | null;
    customerIdLive: string | null;
    linkId: string;
    amountCents: number;
    sessionId: string;
    start: number;
}

async function handleFlexHold(args: FlexHoldArgs): Promise<Response> {
    const {
        sbAdmin, resolvedUserId, callerEmail, isLive,
        customerIdTest, customerIdLive, linkId, amountCents, sessionId, start,
    } = args;

    if (!sbAdmin) {
        return jsonResponse({ error: "Server not configured (Supabase admin missing)" }, 500);
    }
    if (!resolvedUserId) {
        return jsonResponse({ error: "Authentication required for flex_hold" }, 401);
    }

    // Verify the link exists, belongs to this user, and is in a state that
    // can accept a hold. 'draft' is the expected starting state.
    const { data: link } = await sbAdmin
        .from("sendmo_links")
        .select("id, user_id, status, link_type, is_test")
        .eq("id", linkId)
        .maybeSingle();
    if (!link) return jsonResponse({ error: "Link not found" }, 404);
    if (link.user_id !== resolvedUserId) {
        return jsonResponse({ error: "Forbidden (not link owner)" }, 403);
    }
    if (link.link_type !== "flexible") {
        return jsonResponse({ error: "Link is not a flexible link" }, 400);
    }
    if (link.status !== "draft" && link.status !== "active") {
        return jsonResponse(
            { error: `Link cannot accept a hold (status=${link.status})` }, 409,
        );
    }
    // Mode check — link's is_test must align with this hold's mode.
    if (link.is_test === isLive) {
        return jsonResponse(
            { error: `Mode mismatch: link is_test=${link.is_test} but request liveMode=${isLive}` }, 400,
        );
    }

    // Idempotency: if there's already an active stripe_intent for this link
    // with intent_role='flex_hold', return its client_secret instead of
    // creating a new one. Lets a refreshed page resume cleanly.
    const { data: existingIntent } = await sbAdmin
        .from("stripe_intents")
        .select("stripe_intent_id, status, amount_cents")
        .eq("link_id", linkId)
        .eq("intent_role", "flex_hold")
        .in("status", ["requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    let customerId: string | null = isLive ? customerIdLive : customerIdTest;
    if (!customerId) {
        customerId = await ensureCustomer(sbAdmin, resolvedUserId, callerEmail, isLive);
    }

    if (existingIntent && existingIntent.amount_cents === amountCents) {
        // Same hold — refresh client_secret by retrieving from Stripe.
        try {
            const pi = await retrievePaymentIntent(existingIntent.stripe_intent_id, isLive);
            const cs = await createCustomerSession({ customer: customerId, liveMode: isLive });
            log({
                event_type: "payment.flex_hold_resumed",
                session_id: sessionId,
                severity: "info",
                entity_type: "payment_intent",
                entity_id: pi.id,
                properties: { link_id: linkId, status: pi.status, live_mode: isLive },
            });
            return jsonResponse({
                client_secret: pi.client_secret,
                payment_intent_id: pi.id,
                status: pi.status,
                customer_session_client_secret: cs.client_secret,
            });
        } catch {
            // Fall through and create a fresh PI.
        }
    }

    const idempotencyKey = `pi_create_flex_hold_${linkId}_${customerId}_${amountCents}`;

    const pi = await createPaymentIntent({
        amount_cents: amountCents,
        currency: "usd",
        capture_method: "manual",
        customer: customerId,
        // Attach the PM to the customer so we can charge overages off_session
        // later (master proposal §3.7 carrier_adjustment).
        setup_future_usage: "off_session",
        metadata: {
            link_id: linkId,
            session_id: sessionId,
            source: "sendmo_flex_hold",
            intent_role: "flex_hold",
            sendmo_user_id: resolvedUserId,
        },
        idempotency_key: idempotencyKey,
        liveMode: isLive,
    });

    const mode = isLive ? "live" : "test";

    // Mirror state in stripe_intents (UPSERT on stripe_intent_id). The
    // webhook will UPDATE on lifecycle transitions and INSERT the holds
    // row when amount_capturable_updated fires (post-confirmation).
    // Status here is the pre-confirmation Stripe status (likely
    // 'requires_payment_method' or 'requires_confirmation').
    await sbAdmin
        .from("stripe_intents")
        .upsert({
            user_id: resolvedUserId,
            link_id: linkId,
            stripe_intent_id: pi.id,
            intent_kind: "payment",
            intent_role: "flex_hold",
            capture_method: "manual",
            funding_source: "card",
            amount_cents: pi.amount,
            status: pi.status,
            mode,
            idempotency_key: idempotencyKey,
        }, { onConflict: "stripe_intent_id" });

    let customerSessionClientSecret: string | null = null;
    try {
        const cs = await createCustomerSession({ customer: customerId, liveMode: isLive });
        customerSessionClientSecret = cs.client_secret;
    } catch (csErr) {
        log({
            event_type: "payment.customer_session_failed",
            session_id: sessionId,
            severity: "warn",
            entity_type: "customer_session",
            properties: {
                error_message: csErr instanceof Error ? csErr.message : "unknown",
                customer_id: customerId,
                live_mode: isLive,
            },
        });
    }

    log({
        event_type: "payment.flex_hold_created",
        session_id: sessionId,
        severity: "info",
        entity_type: "payment_intent",
        entity_id: pi.id,
        duration_ms: Date.now() - start,
        properties: {
            link_id: linkId,
            amount_cents: pi.amount,
            status: pi.status,
            live_mode: isLive,
            has_customer_session: customerSessionClientSecret !== null,
        },
    });

    return jsonResponse({
        client_secret: pi.client_secret,
        payment_intent_id: pi.id,
        status: pi.status,
        customer_session_client_secret: customerSessionClientSecret,
    });
}

// Re-export so other helpers (label flow) can verify a PI exists + succeeded
export { retrievePaymentIntent };
