import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { sendEmail } from "../_shared/resend.ts";
import { labelConfirmationEmail, budgetReachedEmail } from "../_shared/email-templates.ts";
import { checkAccountBudget } from "../_shared/budget.ts";
import { writeLabelCost } from "../_shared/ledger.ts";
import {
    retrievePaymentIntent,
    createRefund,
    createOffSessionShipmentPI,
    cancelPaymentIntent,
} from "../_shared/stripe.ts";

// Pricing markup MUST stay in sync with supabase/functions/rates/index.ts.
// Server-derives display_price_cents from EasyPost rate for the flex-link
// cap check (proposal 2026-05-11_sender-flow-wizard §3.6 / B5: client-supplied
// display_price_cents is not trusted).
const MARKUP_MULTIPLIER = 1.15;
const MARKUP_FLAT_CENTS = 100;

function applyMarkup(rateDollars: number): number {
    return Math.round(rateDollars * 100 * MARKUP_MULTIPLIER) + MARKUP_FLAT_CENTS;
}

// In-memory rate limit for the flex sender path (Pattern D, Phase F).
// 5 requests / 60s per (IP + link_short_code) — matches existing
// cancel-label/index.ts:41-53 pattern. Mitigates the labels-fn-as-back-gate
// fraud surface: under Pattern D, labels does a Stripe call on every public
// sender confirm, so an attacker who knows a short_code could spam the
// endpoint to probe the recipient's card state. The rate limit kicks in
// well before the attack rate becomes meaningful.
const FLEX_RATE_LIMIT_MAX = 5;
const FLEX_RATE_LIMIT_WINDOW_MS = 60_000;
const flexRateBucket = new Map<string, number[]>();
function isFlexRateLimited(key: string, now: number): boolean {
    const arr = (flexRateBucket.get(key) || []).filter((t) => now - t < FLEX_RATE_LIMIT_WINDOW_MS);
    if (arr.length >= FLEX_RATE_LIMIT_MAX) {
        flexRateBucket.set(key, arr);
        return true;
    }
    arr.push(now);
    flexRateBucket.set(key, arr);
    return false;
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
    // Sender IP — used for the flex rate-limit key and as a Radar metadata
    // signal on the off_session charge (B2). Computed once at handler scope.
    const senderIp = req.headers.get("x-forwarded-for")?.split(",")[0].trim()
        ?? req.headers.get("x-real-ip")
        ?? "unknown";

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

        // Pattern D rate limit (flex sender path only). The full-label path
        // is JWT-authenticated and the comp path requires admin, so neither
        // needs anonymous-URL rate limiting. Only the flex sender-confirm
        // path (link_short_code present, no JWT, no comp) is hit here.
        if (link_short_code && !comp) {
            const rateKey = `${senderIp}:${link_short_code}`;
            if (isFlexRateLimited(rateKey, Date.now())) {
                log({
                    event_type: "label.flex_rate_limited",
                    session_id: sessionId,
                    severity: "warn",
                    entity_type: "label",
                    entity_id: easypost_shipment_id,
                    properties: { ip: senderIp, link_short_code },
                });
                return new Response(
                    JSON.stringify({ error: "Too many attempts. Please wait a moment and try again." }),
                    { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }
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
            is_test: boolean;
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
                    id, short_code, user_id, status, link_type, max_price_cents, is_test,
                    recipient_address:addresses!recipient_address_id (
                        name, street1, street2, city, state, zip, country, phone
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
                phone: string | null;
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
                phone: recipientAddr.phone ?? undefined,
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
                is_test: link.is_test === true,
            };

            // Mode-mismatch defense (Pattern D, Phase F): link.is_test is the
            // server-side source of truth for whether this link runs in test
            // or live mode. The sender's `live_mode` request body field is
            // public input and can't be trusted. If the sender request's
            // isLive doesn't match the link's is_test, reject — otherwise
            // the off_session PM lookup would pick the wrong-mode PM (or
            // none) and return a misleading 402.
            const linkIsLive = !resolvedLink.is_test;
            if (linkIsLive !== isLive) {
                log({
                    event_type: "label.flex_mode_mismatch",
                    session_id: sessionId,
                    severity: "warn",
                    entity_type: "label",
                    entity_id: easypost_shipment_id,
                    properties: {
                        link_short_code,
                        link_is_test: resolvedLink.is_test,
                        request_is_live: isLive,
                    },
                });
                return new Response(
                    JSON.stringify({ error: "Link mode mismatch" }),
                    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }

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
        // Three branches:
        //   1. comp=true (admin/internal) — bypass payment entirely; record
        //      as comp_grant in the post-buy ledger flow.
        //   2. resolvedLink && !comp (FLEX, Pattern D) — create a fresh
        //      off_session PaymentIntent against the recipient's default
        //      saved PM for display_price_cents. Auto-captures synchronously.
        //   3. else (FULL-LABEL) — verify the caller-supplied payment_intent_id
        //      is succeeded and metadata matches easypost_shipment_id.
        let verifiedPaymentIntent: { id: string; amount: number; status: string } | null = null;

        if (!isComp && resolvedLink) {
            // ── Flex off_session charge path (Pattern D, Phase F) ───
            // Per proposal
            // 2026-05-16_flex-payment-pattern-d-execution_reviewed-2026-05-16_decided-2026-05-18.md
            // §2.1. Replaces the Phase E capture-from-held-PI logic that
            // shipped in commit ab92b3d.
            if (!supabase) {
                return new Response(
                    JSON.stringify({ error: "Server configuration error" }),
                    { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }

            if (typeof display_price_cents !== "number" || display_price_cents <= 0) {
                return new Response(
                    JSON.stringify({ error: "Could not derive display price for charge" }),
                    { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }

            // Resolve recipient's default PM in the link's mode.
            const linkMode = isLive ? "live" : "test";
            const { data: defaultPm } = await supabase
                .from("payment_methods")
                .select("stripe_payment_method_id")
                .eq("user_id", resolvedLink.user_id)
                .eq("mode", linkMode)
                .eq("is_default", true)
                .is("deleted_at", null)
                .maybeSingle();

            if (!defaultPm?.stripe_payment_method_id) {
                log({
                    event_type: "label.flex_no_default_pm",
                    session_id: sessionId,
                    severity: "warn",
                    entity_type: "label",
                    entity_id: easypost_shipment_id,
                    properties: { link_short_code, link_id: resolvedLink.id, mode: linkMode },
                });
                return new Response(
                    JSON.stringify({
                        error: "This link isn't accepting payments right now. The recipient needs to update their payment method.",
                    }),
                    { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }

            // Resolve the recipient's Stripe Customer for this mode.
            const customerCol = isLive ? "stripe_customer_id_live" : "stripe_customer_id_test";
            const { data: recipientProfile } = await supabase
                .from("profiles")
                .select(customerCol)
                .eq("id", resolvedLink.user_id)
                .maybeSingle();
            const recipientCustomerId =
                (recipientProfile as Record<string, string | null> | null)?.[customerCol] ?? null;
            if (!recipientCustomerId) {
                log({
                    event_type: "label.flex_no_customer",
                    session_id: sessionId,
                    severity: "error",
                    entity_type: "label",
                    entity_id: easypost_shipment_id,
                    properties: { link_short_code, link_id: resolvedLink.id, mode: linkMode },
                });
                return new Response(
                    JSON.stringify({
                        error: "Recipient's payment account isn't set up. They need to re-add their card.",
                    }),
                    { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }

            // ─── B5 Account Budget check (proposal 2026-05-21, decided 2026-05-22) ──
            // Refuse the charge if it would breach the account holder's daily
            // or weekly spending budget. Runs BEFORE createOffSessionShipmentPI
            // so a refusal never leaves a charged-but-no-label race. Fails open
            // on a DB error (budget is a backstop; per-shipment cap + Radar
            // still apply).
            const budgetCheck = await checkAccountBudget(
                supabase, resolvedLink.user_id, linkMode, display_price_cents,
            );
            if (!budgetCheck.ok) {
                log({
                    event_type: "velocity.limit_hit",
                    session_id: sessionId,
                    severity: "warn",
                    entity_type: "sendmo_link",
                    entity_id: resolvedLink.id,
                    properties: {
                        layer: "account_budget",
                        window: budgetCheck.window,
                        limit_cents: budgetCheck.limit_cents,
                        spent_cents: budgetCheck.spent_cents,
                        attempted_cents: budgetCheck.attempted_cents,
                        user_id: resolvedLink.user_id,
                        mode: linkMode,
                        link_short_code: resolvedLink.short_code,
                    },
                });
                // Notify the account holder (fire-and-forget, 5s timeout).
                if (recipient_email) {
                    const acBud = new AbortController();
                    const tidBud = setTimeout(() => acBud.abort(), 5000);
                    try {
                        const tpl = budgetReachedEmail({
                            window: budgetCheck.window!,
                            limitCents: budgetCheck.limit_cents!,
                        });
                        await sendEmail({
                            to: recipient_email, subject: tpl.subject, html: tpl.html,
                            signal: acBud.signal,
                        });
                        clearTimeout(tidBud);
                    } catch (sendErr) {
                        clearTimeout(tidBud);
                        log({
                            event_type: "velocity.budget_email_failed",
                            session_id: sessionId,
                            severity: "error",
                            entity_type: "sendmo_link",
                            entity_id: resolvedLink.id,
                            properties: {
                                error_message: sendErr instanceof Error ? sendErr.message : String(sendErr),
                            },
                        });
                    }
                }
                return new Response(
                    JSON.stringify({
                        error: "This link has reached its spending limit. The link owner needs to contact SendMo to raise it.",
                    }),
                    { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }

            // Create fresh off_session PI for the actual rate. Sender's IP
            // is the natural idempotency key partition; we also include the
            // EasyPost shipment id so retries from the same client are safe.
            const idempotencyKey = `pi_offsess_${easypost_shipment_id}_${defaultPm.stripe_payment_method_id}`;
            try {
                const pi = await createOffSessionShipmentPI({
                    amount_cents: display_price_cents,
                    customer: recipientCustomerId,
                    payment_method: defaultPm.stripe_payment_method_id,
                    metadata: {
                        source: "flex_shipment",
                        intent_role: "shipment",
                        // txn_kind — Radar/Fraud-Teams discriminator (B2).
                        txn_kind: "mit_flex",
                        link_id: resolvedLink.id,
                        link_type: "flexible",
                        sendmo_user_id: resolvedLink.user_id,
                        easypost_shipment_id,
                        link_short_code: resolvedLink.short_code,
                        // sender_ip — the anonymous sender is invisible to Radar
                        // on an MIT; pass it explicitly for later Fraud-Teams rules.
                        sender_ip: senderIp,
                        ...(sender_email ? { sender_email: String(sender_email) } : {}),
                        ...(recipient_email ? { recipient_email: String(recipient_email) } : {}),
                    },
                    // shipping — destination address as a Radar signal (B2).
                    ...(to_address?.street1
                        ? {
                            shipping: {
                                name: String(to_address.name ?? ""),
                                ...(to_address.phone ? { phone: String(to_address.phone) } : {}),
                                address: {
                                    line1: String(to_address.street1),
                                    ...(to_address.street2 ? { line2: String(to_address.street2) } : {}),
                                    city: to_address.city ? String(to_address.city) : undefined,
                                    state: to_address.state ? String(to_address.state) : undefined,
                                    postal_code: to_address.zip ? String(to_address.zip) : undefined,
                                    country: to_address.country ? String(to_address.country) : undefined,
                                },
                            },
                        }
                        : {}),
                    idempotency_key: idempotencyKey,
                    liveMode: isLive,
                });

                if (pi.status === "succeeded") {
                    verifiedPaymentIntent = {
                        id: pi.id,
                        amount: (pi as { amount_received?: number }).amount_received ?? pi.amount,
                        status: pi.status,
                    };
                    log({
                        event_type: "label.flex_off_session_succeeded",
                        session_id: sessionId,
                        severity: "info",
                        entity_type: "payment_intent",
                        entity_id: pi.id,
                        properties: {
                            link_short_code,
                            amount_cents: verifiedPaymentIntent.amount,
                            live_mode: isLive,
                        },
                    });
                } else if (pi.status === "requires_action") {
                    // SCA/3DS required — off_session can't recover (US-only v1).
                    // Cancel the PI so it doesn't sit awaiting a non-existent
                    // confirmation, then return decline. Webhook payment_failed
                    // will fire and send the recipient the decline email.
                    try { await cancelPaymentIntent(pi.id, isLive); } catch { /* best effort */ }
                    log({
                        event_type: "label.flex_off_session_requires_action",
                        session_id: sessionId,
                        severity: "warn",
                        entity_type: "payment_intent",
                        entity_id: pi.id,
                        properties: { link_short_code, live_mode: isLive },
                    });
                    return new Response(
                        JSON.stringify({
                            error: "Your payment couldn't be processed right now. The link's been deactivated and we've notified the recipient.",
                        }),
                        { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                    );
                } else {
                    // Other non-succeeded states (requires_payment_method,
                    // canceled, processing). Treat as decline.
                    log({
                        event_type: "label.flex_off_session_not_succeeded",
                        session_id: sessionId,
                        severity: "warn",
                        entity_type: "payment_intent",
                        entity_id: pi.id,
                        properties: { link_short_code, status: pi.status, live_mode: isLive },
                    });
                    return new Response(
                        JSON.stringify({
                            error: "Your payment couldn't be processed right now. The link's been deactivated and we've notified the recipient.",
                        }),
                        { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                    );
                }
            } catch (err) {
                // Stripe API errors (card_declined, insufficient_funds, Radar
                // blocks, etc.) throw out of createOffSessionShipmentPI. The
                // webhook payment_intent.payment_failed fires from Stripe's
                // side and handles the canonical routing (decline-recovery
                // email, OR — per B4 — Radar-block branch via
                // retrieveCharge(outcome.type)).
                //
                // Here we return a friendly sender-facing message — and we
                // pick distinct copy for a likely Radar block vs a genuine
                // decline, because the two have different downstream state:
                //   decline    → link goes Inactive, recipient emailed to
                //                update card
                //   Radar block → link stays Active (the recipient's card is
                //                fine); the recipient is gently notified that
                //                a charge was blocked as suspicious (O7).
                // So telling a Radar-blocked sender "the link's been
                // deactivated" is wrong — it isn't.
                //
                // 'fraudulent' is the decline_code Stripe surfaces when Radar
                // blocks (or when the issuer suspects fraud). The authoritative
                // signal is the charge's outcome.type ('blocked' vs
                // 'issuer_declined') and the webhook is the source of truth
                // for downstream state. This decline_code is a fast synchronous
                // hint that aligns the sender message with the webhook's
                // upcoming decision (B-1 from the review).
                const errAny = err as {
                    stripeCode?: string;
                    stripeType?: string;
                    stripeDeclineCode?: string;
                    message?: string;
                };
                const msg = errAny.message ?? "Payment failed";
                const isLikelyRadarBlock = errAny.stripeDeclineCode === "fraudulent";
                console.error(`[Session ${sessionId}] [labels] flex off_session error:`, msg, errAny.stripeCode, errAny.stripeDeclineCode);
                if (isLikelyRadarBlock) {
                    log({
                        event_type: "label.flex_radar_blocked",
                        session_id: sessionId,
                        severity: "warn",
                        entity_type: "label",
                        entity_id: easypost_shipment_id,
                        properties: {
                            link_short_code,
                            error_message: msg,
                            stripe_code: errAny.stripeCode ?? null,
                            decline_code: errAny.stripeDeclineCode ?? null,
                            live_mode: isLive,
                        },
                    });
                    return new Response(
                        JSON.stringify({
                            error: "This payment was declined by our fraud protection. The link owner has been notified.",
                        }),
                        { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                    );
                }
                log({
                    event_type: "label.flex_off_session_error",
                    session_id: sessionId,
                    severity: "warn",
                    entity_type: "label",
                    entity_id: easypost_shipment_id,
                    properties: {
                        link_short_code,
                        error_message: msg,
                        stripe_code: errAny.stripeCode ?? null,
                        decline_code: errAny.stripeDeclineCode ?? null,
                        live_mode: isLive,
                    },
                });
                return new Response(
                    JSON.stringify({
                        error: "Your payment couldn't be processed right now. The link's been deactivated and we've notified the recipient.",
                    }),
                    { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }
        } else if (!isComp) {
            // ── Full-label path (existing) ──────────────────────
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

            // Friendly rewrite for the FedEx/UPS phone-required rejection.
            // New links always have a phone now (required at creation, 2026-05-19),
            // but links created before that can still hit this. EasyPost surfaces
            // it as PHONENUMBEREMPTY / "phone number is empty" — translate to an
            // actionable message instead of the raw carrier string.
            const isPhoneError = /phone\s*number|phonenumberempty/i.test(errorMsg);
            const friendlyMsg = isPhoneError
                ? "This shipment needs a phone number — FedEx and UPS require one for delivery. If you're shipping on a link created before phone numbers were required, ask the link owner to update their delivery address, or choose a USPS option."
                : errorMsg;
            return new Response(
                JSON.stringify({ error: friendlyMsg, refunded: !!verifiedPaymentIntent }),
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
                    p_from_phone: from_address.phone ?? null,
                    p_to_name: to_address.name,
                    p_to_street1: to_address.street1,
                    p_to_street2: to_address.street2 ?? null,
                    p_to_city: to_address.city,
                    p_to_state: to_address.state,
                    p_to_zip: to_address.zip,
                    p_to_country: to_address.country ?? 'US',
                    p_to_phone: to_address.phone ?? null,
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

                        // ── Ledger: label_cost (H1 — migration 032) ────────
                        // Write a label_cost transaction row recording that
                        // SendMo paid EasyPost for this label. Fire-and-forget
                        // wrapper — failure is logged but never breaks label-buy.
                        // Per PLAYBOOK Rule 16 (amended): labels is the sole
                        // writer for label_cost rows.
                        if (shipmentId) {
                            const rateCents = Math.round(parseFloat(buyData.selected_rate?.rate || "0") * 100);
                            writeLabelCost({
                                supabase,
                                sessionId,
                                shipmentId,
                                userId: resolvedLink?.user_id ?? callerUserId ?? '00000000-0000-0000-0000-000000000001',
                                linkId: resolvedLink?.id ?? null,
                                easypostShipmentId: easypost_shipment_id,
                                rateCents,
                                mode: isLive ? 'live' : 'test',
                                isComp,
                            }).catch((err) => {
                                // Synchronous throw from the helper itself (shouldn't
                                // happen — helper catches internally — but belt-and-suspenders).
                                console.error('[labels] writeLabelCost unexpected throw:', err);
                            });
                        }

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

                        // ── Item description (migration 021) ───────────────
                        // Sender-flow flows pass parcel.description from
                        // SenderStepReview. Persisted as a follow-up UPDATE
                        // (rather than RPC-param expansion) to avoid the
                        // brittle RPC-signature pattern that bit the
                        // 2026-05-13 orphan-shipment incident. Skipped when
                        // description is absent / empty.
                        if (shipmentId && parcel?.description && typeof parcel.description === 'string' && parcel.description.trim().length > 0) {
                            const { error: descErr } = await supabase
                                .from('shipments')
                                .update({ item_description: parcel.description.trim().slice(0, 500) })
                                .eq('id', shipmentId);
                            if (descErr) {
                                // Non-fatal — label still shipped, just no description stored.
                                console.error('item_description write error:', descErr);
                            }
                        }

                        // Pattern D (Phase F): flex links stay 'active' indefinitely.
                        // The Phase E active→in_use flip was removed here per the
                        // decided proposal §3.2 — flex is reusable, so 'in_use'
                        // semantics no longer apply. Legacy 'in_use' rows are
                        // backfilled to 'active' by migration 024.
                        // Full-label links are minted at 'in_use' by the RPC
                        // (migration 020); that path is unchanged.

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
                            const template = labelConfirmationEmail({
                                publicCode,
                                carrierTracking: trackingNumber || "Pending",
                                carrier: carrier || "Standard",
                                eta,
                                trackingUrl,
                                senderName: from_address?.name ?? null,
                                itemDescription: typeof parcel?.description === "string" ? parcel.description : null,
                                displayPriceCents: typeof display_price_cents === "number" ? display_price_cents : null,
                            });
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
