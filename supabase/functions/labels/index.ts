import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { sendEmail } from "../_shared/resend.ts";
import { budgetReachedEmail, labelConfirmationEmail } from "../_shared/email-templates.ts";
import { dispatchNotifications, LABEL_CREATED_EVENT } from "../_shared/notifications.ts";
import { checkAccountBudget } from "../_shared/budget.ts";
import { writeLabelCost } from "../_shared/ledger.ts";
import {
    retrievePaymentIntent,
    createRefund,
    createOffSessionShipmentPI,
    cancelPaymentIntent,
} from "../_shared/stripe.ts";
import { checkRateLimit } from "../_shared/ratelimit.ts";
import { sendAdminAlert } from "../_shared/alert.ts";
import { resolveLiveMode } from "../_shared/mode.ts";
import { assertKeysMatchEnv } from "../_shared/env-guard.ts";
import { checkLiveChargeAllowed } from "../_shared/allowlist.ts";

// Pricing markup MUST stay in sync with supabase/functions/rates/index.ts.
// Server-derives display_price_cents from EasyPost rate for the flex-link
// cap check (proposal 2026-05-11_sender-flow-wizard §3.6 / B5: client-supplied
// display_price_cents is not trusted).
const MARKUP_MULTIPLIER = 1.15;
const MARKUP_FLAT_CENTS = 100;

function applyMarkup(rateDollars: number): number {
    return Math.round(rateDollars * 100 * MARKUP_MULTIPLIER) + MARKUP_FLAT_CENTS;
}

// Rate limit for the flex sender path (Pattern D, Phase F) — shared
// _shared/ratelimit.ts. 5 requests / 60s per (IP + link_short_code).
// Mitigates the labels-fn-as-back-gate fraud surface: under Pattern D,
// labels does a Stripe call on every public sender confirm, so an attacker
// who knows a short_code could spam the endpoint to probe the recipient's
// card state. The rate limit kicks in well before the attack rate becomes
// meaningful.
const FLEX_RATE_LIMIT = { max: 5, windowMs: 60_000 };

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

    // T2-4 key-mismatch guard — refuse to serve the money path when a test
    // key is present in production (keyed on SENDMO_ENV, not the kill switch).
    try {
        assertKeysMatchEnv();
    } catch (guardErr) {
        const guardMsg = guardErr instanceof Error ? guardErr.message : "Environment key mismatch";
        console.error("[labels] env-guard:", guardMsg);
        return new Response(
            JSON.stringify({ error: guardMsg }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
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
            if (checkRateLimit(rateKey, FLEX_RATE_LIMIT)) {
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

        // isLive starts from the client hint but is RE-DERIVED server-side
        // before any money or EasyPost-key decision (T1-1):
        //   • flex leg  — from the link's is_test (assigned below, once the
        //     link resolves; the link is the source of truth — review B2).
        //   • full-label leg — from the caller's profile via resolveLiveMode
        //     (assigned after the caller-identity block below).
        //   • comp leg (no link) — keeps the client hint, unchanged: the comp
        //     gate already requires an admin JWT, and admin live_comp buys
        //     REAL EasyPost labels (the historical admin-comp pattern).
        let isLive = live_mode === true;
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

            // Link-derived mode (T1-1, review B2): link.is_test is the
            // server-side source of truth — the anonymous sender has no
            // caller identity to branch on, and their `live_mode` body field
            // is public input. The former `linkIsLive !== isLive`
            // mismatch-reject is retired: it existed to catch client/link
            // disagreement, which can't happen once the client value is
            // simply ignored on this leg.
            isLive = !resolvedLink.is_test;

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
        // callerEmail — the authenticated payer's email. For full-label this is
        // the address the label-created confirmation goes to (the client sends
        // an empty sender_email for authed users; the real email is on the JWT).
        let callerEmail: string | null = null;
        // callerRole / callerAdminMode — feed resolveLiveMode for the
        // full-label leg and the kill switch's admin exemption (T1-1).
        let callerRole: string | null = null;
        let callerAdminMode: string | null = null;
        {
            const ah = req.headers.get("Authorization") || req.headers.get("authorization") || "";
            const tok = ah.replace(/^Bearer\s+/i, "");
            const anon = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("VITE_SUPABASE_ANON_KEY") || "";
            if (tok && tok !== anon && supabase) {
                const { data: userResp } = await supabase.auth.getUser(tok);
                if (userResp?.user?.id) callerUserId = userResp.user.id;
                if (userResp?.user?.email) callerEmail = userResp.user.email;
                if (callerUserId) {
                    const { data: callerProfile } = await supabase
                        .from("profiles")
                        .select("role, admin_active_mode")
                        .eq("id", callerUserId)
                        .maybeSingle();
                    callerRole = (callerProfile?.role as string) ?? null;
                    callerAdminMode = (callerProfile?.admin_active_mode as string) ?? null;
                }
            }
        }

        // Full-label mode derivation (T1-1): no link to consult, so the
        // caller's profile decides. Anonymous callers always resolve test
        // (decided OQ3). The comp-without-link leg keeps the client hint —
        // see the isLive declaration comment above.
        if (!resolvedLink && !isComp) {
            isLive = resolveLiveMode({
                callerRole,
                callerAdminMode,
                isAuthenticated: !!callerUserId,
            }).isLive;
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

            // Kill switch (T1-1, review B4): a live link keeps driving live
            // off-session charges even after SENDMO_LIVE_DEFAULT is flipped
            // off — the link-derived mode never consults the env var. Check
            // it explicitly before any live charge so the one-flip halt
            // covers the flex path too.
            if (isLive && Deno.env.get("SENDMO_LIVE_DEFAULT") !== "true") {
                log({
                    event_type: "payment.live_paused_by_kill_switch",
                    session_id: sessionId,
                    severity: "warn",
                    entity_type: "sendmo_link",
                    entity_id: resolvedLink.short_code,
                    properties: { link_short_code: resolvedLink.short_code, flow: "flex" },
                });
                return new Response(
                    JSON.stringify({ error: "Payments are temporarily paused. Please try again soon." }),
                    { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }

            // Closed-beta allowlist gate (security follow-up 2026-07-05):
            // the flex sender is anonymous, so the vetted party is the LINK
            // OWNER (resolvedLink.user_id) — the recipient who saved the card
            // that moves money. Same lever as the full-label path in payments.
            // Without this, a non-allowlisted customer could run the whole
            // flex product live during the invite-only window.
            if (isLive) {
                const gate = checkLiveChargeAllowed("customer", resolvedLink.user_id);
                if (!gate.allowed) {
                    log({
                        event_type: "payment.live_charge_blocked",
                        session_id: sessionId,
                        severity: "warn",
                        entity_type: "sendmo_link",
                        entity_id: resolvedLink.short_code,
                        properties: {
                            link_short_code: resolvedLink.short_code,
                            link_owner: resolvedLink.user_id,
                            reason: gate.reason,
                            flow: "flex",
                        },
                    });
                    return new Response(
                        JSON.stringify({ error: "This link isn't accepting live payments yet." }),
                        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                    );
                }
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
                    // Link short code as suffix → "SENDMO* YPPY9AK" on bank statements.
                    // Ties the bank statement entry directly to a trackable shipment.
                    // Requires account-level statement descriptor = "SENDMO" in Dashboard.
                    // See proposals/2026-05-27_business-identifier-sweep-handoff.md.
                    statement_descriptor_suffix: resolvedLink.short_code,
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
                // T1-3: off-session charge failure — includes ordinary
                // declines (deliberate at launch scale: a failed flex charge
                // deactivates the customer's link, which is worth knowing
                // about same-day; dial back if volume makes it noise).
                await sendAdminAlert({
                    subject: "Flex off-session charge failed — link deactivated",
                    heading: "Off-Session Charge Failed",
                    intro: "A sender confirmed a flex shipment but the recipient's saved card could not be charged. " +
                        "The link is now inactive and the recipient was emailed to update their card — no action needed unless this repeats.",
                    rows: [
                        { label: "Link", value: String(link_short_code ?? "—") },
                        { label: "EasyPost shipment", value: easypost_shipment_id },
                        { label: "Error", value: msg },
                        { label: "Stripe code", value: errAny.stripeCode ?? "—" },
                        { label: "Decline code", value: errAny.stripeDeclineCode ?? "—" },
                        { label: "Mode", value: isLive ? "LIVE" : "Test" },
                    ],
                    source: "labels flex off-session charge (label.flex_off_session_error)",
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
            // Kill switch (T1-1, review B4) — also covers live full-label
            // buys. Admins in live_charge are exempt so a fix can be
            // verified end-to-end while customer payments are paused.
            if (
                isLive &&
                Deno.env.get("SENDMO_LIVE_DEFAULT") !== "true" &&
                !(callerRole === "admin" && callerAdminMode === "live_charge")
            ) {
                log({
                    event_type: "payment.live_paused_by_kill_switch",
                    session_id: sessionId,
                    severity: "warn",
                    entity_type: "label",
                    entity_id: easypost_shipment_id,
                    properties: { flow: "full_label", user_id: callerUserId },
                });
                return new Response(
                    JSON.stringify({ error: "Payments are temporarily paused. Please try again soon." }),
                    { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
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

        // ─── Buy-time rate gate (proposal 2026-05-23_buy-time-rate-gate) ─
        // Refetch the rate from EasyPost BEFORE calling /buy. If the buy-time
        // rate now exceeds what we charged the customer (minus Stripe fees and
        // minimum margin), refuse the buy, refund the customer, and return a
        // structured 409 the client surfaces as a "rate changed" dialog.
        //
        // Decisions (this session):
        //   • BEFORE check (vs AFTER void): avoids the carrier-side voided
        //     label artifact. Refund path is identical in either option since
        //     payments uses capture_method='automatic'.
        //   • Margin floor: 5% net after Stripe fees. Threshold formula:
        //         ep ≤ display × (1 − STRIPE_FEE_PCT − MIN_NET_MARGIN_PCT)
        //               − STRIPE_FEE_FLAT_CENTS
        //   • Refund-failure handling: middle path — auto-refund; if refund
        //     itself fails, log+admin alert event, return 409 with
        //     refunded:false so the client shows honest copy.
        //   • Comp labels: exempt (SendMo absorbs EP cost by design).
        //
        // Skipped when display_price_cents is missing or zero — can't compare.
        const STRIPE_FEE_PCT = 0.029;
        const STRIPE_FEE_FLAT_CENTS = 30;
        const MIN_NET_MARGIN_PCT = parseFloat(
            Deno.env.get("LABEL_BUY_GATE_MIN_NET_MARGIN_PCT") ?? "0.05"
        );
        const SOFT_DRIFT_PCT = parseFloat(
            Deno.env.get("LABEL_BUY_GATE_SOFT_DRIFT_PCT") ?? "0.05"
        );

        const gateDisplayCents = typeof display_price_cents === "number" ? display_price_cents : 0;

        if (gateDisplayCents > 0 && !isComp) {
            // Refetch rate — same fallback pattern as the flex-cap block above
            // (/rates/<id> endpoint preferred, fall back to GET shipment).
            let buyTimeRateCents: number | null = null;
            try {
                const rateResp = await fetch(
                    `https://api.easypost.com/v2/shipments/${easypost_shipment_id}/rates/${easypost_rate_id}`,
                    { headers: { Authorization: authHeader } },
                );
                if (rateResp.ok) {
                    const rateData = await rateResp.json();
                    buyTimeRateCents = Math.round(parseFloat(rateData.rate ?? "0") * 100);
                } else {
                    const shipResp = await fetch(
                        `https://api.easypost.com/v2/shipments/${easypost_shipment_id}`,
                        { headers: { Authorization: authHeader } },
                    );
                    if (shipResp.ok) {
                        const shipData = await shipResp.json();
                        const matched = (shipData.rates || []).find((r: { id: string }) => r.id === easypost_rate_id);
                        if (matched) {
                            buyTimeRateCents = Math.round(parseFloat(matched.rate ?? "0") * 100);
                        }
                    }
                }
            } catch (rateErr) {
                log({
                    event_type: "label.buy_time_rate_refetch_failed",
                    session_id: sessionId,
                    severity: "warn",
                    entity_type: "label",
                    entity_id: easypost_shipment_id,
                    properties: {
                        error_message: rateErr instanceof Error ? rateErr.message : String(rateErr),
                    },
                });
            }

            if (buyTimeRateCents !== null && buyTimeRateCents > 0) {
                // Threshold: EP cost must leave room for Stripe fees + min net margin.
                const gateThresholdCents = Math.floor(
                    gateDisplayCents * (1 - STRIPE_FEE_PCT - MIN_NET_MARGIN_PCT) - STRIPE_FEE_FLAT_CENTS
                );

                if (buyTimeRateCents > gateThresholdCents) {
                    const marginLossCents = buyTimeRateCents - gateThresholdCents;
                    log({
                        event_type: "label.buy_time_rate_exceeded",
                        session_id: sessionId,
                        severity: "error",
                        entity_type: "label",
                        entity_id: easypost_shipment_id,
                        properties: {
                            quoted_display_price_cents: gateDisplayCents,
                            buy_time_rate_cents: buyTimeRateCents,
                            gate_threshold_cents: gateThresholdCents,
                            margin_loss_cents: marginLossCents,
                            stripe_fee_pct: STRIPE_FEE_PCT,
                            stripe_fee_flat_cents: STRIPE_FEE_FLAT_CENTS,
                            min_net_margin_pct: MIN_NET_MARGIN_PCT,
                            flow: resolvedLink ? "flex" : "full_label",
                            easypost_rate_id,
                        },
                    });

                    // Auto-refund. If this fails, the customer's $$$ is stuck
                    // until we (the admin) manually refund. Middle-path: we
                    // log loud + admin alert event + return refunded:false so
                    // the client can render honest copy.
                    let refundIssued = false;
                    let refundErrorMsg: string | null = null;
                    if (verifiedPaymentIntent) {
                        try {
                            const refund = await createRefund({
                                payment_intent_id: verifiedPaymentIntent.id,
                                reason: "requested_by_customer",
                                metadata: {
                                    easypost_shipment_id,
                                    failure_reason: "buy_time_rate_exceeded",
                                    margin_loss_cents: String(marginLossCents),
                                },
                                idempotency_key: `refund_${easypost_shipment_id}_buy_time_rate_exceeded`,
                                liveMode: isLive,
                            });
                            refundIssued = true;
                            log({
                                event_type: "label.auto_refund_issued",
                                session_id: sessionId,
                                severity: "warn",
                                entity_type: "payment_intent",
                                entity_id: verifiedPaymentIntent.id,
                                properties: {
                                    refund_id: refund.id,
                                    amount_cents: refund.amount,
                                    easypost_shipment_id,
                                    reason: "buy_time_rate_exceeded",
                                },
                            });
                        } catch (refundErr) {
                            refundErrorMsg = refundErr instanceof Error ? refundErr.message : String(refundErr);
                            console.error(`[Session ${sessionId}] [labels] BUY-TIME-GATE REFUND FAILED:`, refundErrorMsg);
                            log({
                                event_type: "label.auto_refund_failed",
                                session_id: sessionId,
                                severity: "error",
                                entity_type: "payment_intent",
                                entity_id: verifiedPaymentIntent.id,
                                properties: {
                                    error_message: refundErrorMsg,
                                    easypost_shipment_id,
                                    reason: "buy_time_rate_exceeded",
                                    payment_intent_id: verifiedPaymentIntent.id,
                                    requires_manual_intervention: true,
                                },
                            });
                            // T1-3: customer is charged with no label and the
                            // automatic refund failed — the manual-intervention
                            // case must reach a human, not just event_logs.
                            await sendAdminAlert({
                                subject: "Auto-refund FAILED after rate-gate trip — customer charged, no label",
                                heading: "Auto-Refund Failed — Manual Refund Required",
                                intro: "The buy-time rate gate refused a label buy, but the automatic Stripe refund failed. " +
                                    "The customer has been charged and has no label. Refund manually in Stripe.",
                                rows: [
                                    { label: "PaymentIntent", value: verifiedPaymentIntent.id },
                                    { label: "EasyPost shipment", value: easypost_shipment_id },
                                    { label: "Refund error", value: refundErrorMsg },
                                    { label: "Reason", value: "buy_time_rate_exceeded" },
                                    { label: "Mode", value: isLive ? "LIVE" : "Test" },
                                ],
                                source: "labels buy-time rate gate (label.auto_refund_failed)",
                            });
                        }
                    }

                    // New display price = what we'd quote at the new EP rate.
                    const newDisplayPriceCents = Math.round(
                        buyTimeRateCents * MARKUP_MULTIPLIER + MARKUP_FLAT_CENTS
                    );

                    return new Response(
                        JSON.stringify({
                            error: "rate_changed",
                            code: "BUY_TIME_RATE_EXCEEDS_DISPLAY_PRICE",
                            message: refundIssued
                                ? "The shipping cost changed and we couldn't complete your purchase at the price you saw. We've refunded your charge — review the new rate to continue."
                                : "The shipping cost changed and we couldn't complete your purchase at the price you saw. We tried to refund your charge automatically but our payment system was slow — our team has been alerted and will complete the refund within 24 hours. Reference: " + (verifiedPaymentIntent?.id ?? "n/a"),
                            quoted_display_price_cents: gateDisplayCents,
                            buy_time_rate_cents: buyTimeRateCents,
                            new_display_price_cents: newDisplayPriceCents,
                            refunded: refundIssued,
                            refund_error: refundErrorMsg,
                            payment_intent_id: verifiedPaymentIntent?.id ?? null,
                            easypost_shipment_id,
                            easypost_rate_id,
                        }),
                        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                    );
                }

                // Soft warning — rate drifted up but still profitable.
                // Quoted rate is back-derived from display_price via the
                // markup formula (display = rate × M + F → rate = (display − F) / M).
                const quotedRateCentsApprox = Math.max(
                    0,
                    Math.round((gateDisplayCents - MARKUP_FLAT_CENTS) / MARKUP_MULTIPLIER)
                );
                if (
                    quotedRateCentsApprox > 0 &&
                    buyTimeRateCents > Math.round(quotedRateCentsApprox * (1 + SOFT_DRIFT_PCT))
                ) {
                    log({
                        event_type: "label.buy_time_rate_drift",
                        session_id: sessionId,
                        severity: "warn",
                        entity_type: "label",
                        entity_id: easypost_shipment_id,
                        properties: {
                            quoted_rate_cents_approx: quotedRateCentsApprox,
                            buy_time_rate_cents: buyTimeRateCents,
                            drift_pct: Math.round(((buyTimeRateCents - quotedRateCentsApprox) / quotedRateCentsApprox) * 100),
                            margin_remaining_cents: gateDisplayCents - buyTimeRateCents,
                            flow: resolvedLink ? "flex" : "full_label",
                            easypost_rate_id,
                        },
                    });
                }
            }
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

            // T1-3: EasyPost refused the buy after (for card flows) the
            // customer was already charged. The auto-refund below usually
            // makes it right; the alert exists so a spike is visible without
            // SQL-querying event_logs.
            await sendAdminAlert({
                subject: "EasyPost label buy failed",
                heading: "Label Buy Failed",
                intro: "EasyPost refused a label purchase. If a payment was captured, the automatic refund path runs next — a follow-up alert fires only if that refund fails.",
                rows: [
                    { label: "EasyPost shipment", value: easypost_shipment_id },
                    { label: "Rate", value: easypost_rate_id },
                    { label: "Error", value: errorMsg },
                    { label: "EasyPost code", value: String(buyData.error?.code ?? "unknown") },
                    { label: "PaymentIntent", value: verifiedPaymentIntent?.id ?? "none (comp/flex pre-charge)" },
                    { label: "Mode", value: isLive ? "LIVE" : "Test" },
                ],
                source: "labels EasyPost /buy handler (label.buy_error)",
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
                    // T1-3: charged, no label, refund failed — the worst
                    // customer state this function can produce.
                    await sendAdminAlert({
                        subject: "Auto-refund FAILED after buy failure — customer charged, no label",
                        heading: "Auto-Refund Failed — Manual Refund Required",
                        intro: "EasyPost refused the label buy AND the automatic Stripe refund failed. " +
                            "The customer has been charged and has nothing to ship. Refund manually in Stripe.",
                        rows: [
                            { label: "PaymentIntent", value: verifiedPaymentIntent.id },
                            { label: "EasyPost shipment", value: easypost_shipment_id },
                            { label: "Buy error", value: errorMsg },
                            { label: "Refund error", value: refundMsg },
                            { label: "Mode", value: isLive ? "LIVE" : "Test" },
                        ],
                        source: "labels EasyPost /buy auto-refund (label.auto_refund_failed)",
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
                    // Read parcel dims from the EasyPost buy response (source of
                    // truth — what carriers were actually quoted and billed on),
                    // not the client request body. The client `buyLabel` wrapper
                    // strips weight/dims before POSTing here, which left every
                    // shipments row at 0 and broke per-shipment margin display.
                    // (Separate issue from GC37EXG's $11.74 Smart Post gap — the
                    // rate.fetched log shows weight=32 oz at quote time for that
                    // shipment, so the EasyPost quote wasn't fed a 0-oz parcel.
                    // The Smart Post gap is most likely a dim-weight re-rate at
                    // the FedEx hub, still under investigation.)
                    // EasyPost uses `weight` (oz) / `length`/`width`/`height` (in).
                    p_weight_oz: Number(buyData.parcel?.weight ?? parcel?.weight_oz ?? 0),
                    p_length_in: Number(buyData.parcel?.length ?? parcel?.length_in ?? 0),
                    p_width_in: Number(buyData.parcel?.width ?? parcel?.width_in ?? 0),
                    p_height_in: Number(buyData.parcel?.height ?? parcel?.height_in ?? 0),
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

                        // ── Forward stitch: shipments.stripe_payment_intent_id ──
                        // The Stripe PI exists before the shipments row, so the
                        // `charge` transaction emitted by stripe-webhook lands
                        // with shipment_id IS NULL. The transactions table is
                        // append-only (no UPDATE grant), so the join must run the
                        // other way: reconciliation-report + cancel/refund + the
                        // /t/ "paid?" display all resolve via t.stripe_intent_id ↔
                        // s.stripe_payment_intent_id. Populating the shipments side
                        // here is what makes that resolvable.
                        //
                        // Stitch from `verifiedPaymentIntent.id`, which is set on
                        // BOTH legs — full-label (the request PI, verified above)
                        // AND flex/off-session (the PI created here by
                        // createOffSessionShipmentPI). The prior code stitched the
                        // request-body `payment_intent_id`, which only the
                        // full-label client sends — so every flex shipment landed
                        // with a NULL PI and was mis-read as a comp label
                        // (cancel skipped the refund, /t/ said "no charge"). Comp
                        // labels leave verifiedPaymentIntent null → no stitch, as
                        // intended. Fixed 2026-07-05 (first live flex cancel).
                        // try/catch — failure logs but never breaks label-buy.
                        const stitchPiId = verifiedPaymentIntent?.id ?? null;
                        if (shipmentId && !isComp && stitchPiId) {
                            try {
                                const { error: shipErr } = await supabase
                                    .from('shipments')
                                    .update({ stripe_payment_intent_id: stitchPiId })
                                    .eq('id', shipmentId);
                                if (shipErr) {
                                    console.error('[labels] forward-stitch shipments update:', shipErr);
                                }
                            } catch (err) {
                                console.error('[labels] forward-stitch unexpected throw:', err);
                            }
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

                        // Label-confirmation email is sent below via dispatchNotifications
                        // (the LABEL_CREATED_EVENT), AFTER notification_contacts is written —
                        // so it reuses the role-keyed fan-out + notifications_log send-once
                        // guard the tracking emails already use. The payer is the only
                        // recipient of the creation email; everyone else first hears about
                        // the package via the in_transit tracking email. Decided 2026-06-27:
                        // proposals/2026-06-27_label-confirmation-email-by-role…

                        // Store notification contacts for this shipment.
                        if (shipmentId) {
                            const contacts: Array<{ shipment_id: string; role: string; channel: string; address: string }> = [];
                            const recipientAddr = (recipient_email && typeof recipient_email === "string") ? recipient_email : null;
                            // Payer email for the `sender` contact: the client-supplied
                            // sender_email if present, else (full-label only) the authed
                            // caller's email — full-label authed users send an empty
                            // sender_email, so without this the payer has no contact and
                            // never gets the label-created email. Flex resolves its payer
                            // (the owner) into the `recipient` role at line ~218, so the
                            // fallback is gated to the non-flex path (resolvedLink === null).
                            const senderAddr = (sender_email && typeof sender_email === "string")
                                ? sender_email
                                : (resolvedLink ? null : callerEmail);
                            // The payer's contact role differs by flow: full-label payer is
                            // the `sender`; flex payer (the link owner) is the `recipient`.
                            // Mirrors the dispatcher's payerRole logic — used by both the
                            // self-send dedupe and the creation-email fallback below.
                            const payerRole = resolvedLink ? "recipient" : "sender";
                            const payerAddr = resolvedLink ? recipientAddr : senderAddr;
                            // OQ4 dedupe: if payer and recipient are the same inbox, store a
                            // single contact on the PAYER's role (not always `sender`) so the
                            // payer still receives the creation email in BOTH flows — a flex
                            // owner shipping to themselves lives on `recipient`, not `sender`.
                            const sameInbox = !!senderAddr && !!recipientAddr
                                && senderAddr.toLowerCase() === recipientAddr.toLowerCase();
                            if (sameInbox) {
                                contacts.push({ shipment_id: shipmentId, role: payerRole, channel: "email", address: (payerAddr ?? senderAddr)! });
                            } else {
                                if (recipientAddr) {
                                    contacts.push({ shipment_id: shipmentId, role: "recipient", channel: "email", address: recipientAddr });
                                }
                                if (senderAddr) {
                                    contacts.push({ shipment_id: shipmentId, role: "sender", channel: "email", address: senderAddr });
                                }
                            }

                            // The label-created confirmation context, shared by the durable
                            // dispatch path and the direct-send fallback below.
                            const labelCreatedCtx = {
                                tracking_number: trackingNumber || "Pending",
                                public_code: publicCode,
                                carrier: carrier || "Standard",
                                estimated_delivery: buyData.selected_rate?.delivery_days
                                    ? `${buyData.selected_rate.delivery_days} business days`
                                    : "Estimated upon pickup",
                                tracking_url: `https://sendmo.co/t/${publicCode}`,
                                is_flex: resolvedLink !== null,
                                sender_name: from_address?.name ?? null,
                                item_description: typeof parcel?.description === "string" ? parcel.description : null,
                                display_price_cents: typeof display_price_cents === "number" ? display_price_cents : null,
                            };

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
                                    // Durable fan-out is unavailable (the insert is atomic, so
                                    // on error there are no contact rows for dispatch to read).
                                    // Best-effort direct send to the one address we know in
                                    // memory — the payer — so a notifications-table hiccup
                                    // doesn't cost them the confirmation for a label they paid
                                    // for. One email to one known address (not a parallel
                                    // fan-out); no notifications_log guard on this degraded path.
                                    if (payerAddr) {
                                        const tpl = labelConfirmationEmail({
                                            publicCode,
                                            carrierTracking: labelCreatedCtx.tracking_number,
                                            carrier: labelCreatedCtx.carrier,
                                            eta: labelCreatedCtx.estimated_delivery,
                                            trackingUrl: labelCreatedCtx.tracking_url,
                                            senderName: labelCreatedCtx.sender_name,
                                            itemDescription: labelCreatedCtx.item_description,
                                            displayPriceCents: labelCreatedCtx.display_price_cents,
                                            variant: resolvedLink ? "flex" : "full_label",
                                        });
                                        sendEmail({ to: payerAddr, subject: tpl.subject, html: tpl.html })
                                            .then(({ id }) => log({
                                                event_type: "email.label_confirmation_fallback_sent",
                                                session_id: sessionId,
                                                severity: "warn",
                                                entity_type: "shipment",
                                                entity_id: shipmentId,
                                                properties: { resend_id: id, public_code: publicCode, reason: "notification_contacts_insert_failed" },
                                            }))
                                            .catch((err) => log({
                                                event_type: "email.label_confirmation_error",
                                                session_id: sessionId,
                                                severity: "error",
                                                entity_type: "shipment",
                                                entity_id: shipmentId,
                                                properties: { error_message: err instanceof Error ? err.message : String(err), public_code: publicCode },
                                            }));
                                    }
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

                                    // Fire the label-created confirmation to the payer.
                                    // dispatchNotifications reads the contacts we just wrote
                                    // and routes LABEL_CREATED_EVENT to the payer-role contact
                                    // only (sender for full-label, recipient/owner for flex).
                                    // Fire-and-forget, matching tracking/webhooks. Its
                                    // notifications_log guard dedupes per (shipment, contact,
                                    // event), so it's robust to a re-dispatch of the SAME
                                    // contact rows; it does NOT dedupe across a labels-function
                                    // retry that re-inserts fresh contact rows (no unique
                                    // constraint on notification_contacts — see OQ3, deferred).
                                    dispatchNotifications(supabase, shipmentId, LABEL_CREATED_EVENT, labelCreatedCtx);
                                }
                            } else {
                                log({
                                    event_type: "label.notification_contacts_none",
                                    session_id: sessionId,
                                    severity: "warn",
                                    entity_type: "shipment",
                                    entity_id: shipmentId,
                                    duration_ms: 0,
                                    properties: { recipient_email_provided: !!recipientAddr, sender_email_provided: !!senderAddr },
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
