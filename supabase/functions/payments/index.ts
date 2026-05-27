import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { sendEmail } from "../_shared/resend.ts";
import { budgetReachedEmail } from "../_shared/email-templates.ts";
import { checkAccountBudget } from "../_shared/budget.ts";
import {
    createPaymentIntent,
    createCustomerSession,
    createCustomer,
    retrievePaymentIntent,
    type ShippingDetails,
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

// ─── getOrCreateCustomerForUser (H2 D1 — save-card for full-label) ───────────
//
// Returns a Stripe Customer id for (user, mode). If one is already stamped on
// profiles.stripe_customer_id_{test,live}, returns it; otherwise creates a
// new Stripe Customer and persists the id.
//
// Mirrors the pattern in `payment-methods/index.ts:ensureCustomer` (the
// SetupIntent / Add-Card flow). Centralizing here so the full-label PI flow
// (D1) and any future authenticated payment path share the same primitive.
//
// Decided proposal:
//   2026-05-22_reconciliation-and-carrier-adjustments §3 + ## Decision D1
//   (full-label save-card extension).
async function getOrCreateCustomerForUser(
    // deno-lint-ignore no-explicit-any
    supabase: any,
    userId: string,
    email: string | null,
    liveMode: boolean,
    fullName?: string | null,
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
        // Set the customer name so Stripe receipts and the Dashboard show the
        // recipient's real name instead of just their email address.
        name: fullName || undefined,
        metadata: { sendmo_user_id: userId, mode: liveMode ? "live" : "test" },
        liveMode,
    });

    await supabase.from("profiles").update({ [col]: customer.id }).eq("id", userId);
    return customer.id;
}

// ─── fetchEasypostToAddress (H2 — bundles risk-intel Job 3 destination addr) ──
//
// Looks up the EasyPost shipment to pull its `to_address` for use as Stripe's
// `shipping` param (Radar destination-address signal — risk-intel B2).
//
// Risk-intel deferred this for the full-label PI because `payments/` only got
// `easypost_shipment_id` (no destination address in the request). H2 bundles
// it here as a single mid-flow GET — one EasyPost call, low latency, closes
// the deferred work. Failure is non-fatal — returns null and the PI is
// created without `shipping` (current behavior — Radar is already strong on
// 2b with on-session device fingerprint).
async function fetchEasypostToAddress(
    easypostShipmentId: string,
    liveMode: boolean,
): Promise<ShippingDetails | null> {
    const apiKey = Deno.env.get(liveMode ? "EASYPOST_API_KEY" : "EASYPOST_TEST_API_KEY");
    if (!apiKey) return null;

    try {
        const ac = new AbortController();
        const tid = setTimeout(() => ac.abort(), 4000);
        const resp = await fetch(
            `https://api.easypost.com/v2/shipments/${easypostShipmentId}`,
            {
                headers: { Authorization: "Basic " + btoa(apiKey + ":") },
                signal: ac.signal,
            },
        );
        clearTimeout(tid);
        if (!resp.ok) return null;
        const data = await resp.json();
        const toAddr = data?.to_address;
        if (!toAddr?.street1 || !toAddr?.name) return null;
        return {
            name: String(toAddr.name),
            ...(toAddr.phone ? { phone: String(toAddr.phone) } : {}),
            address: {
                line1: String(toAddr.street1),
                ...(toAddr.street2 ? { line2: String(toAddr.street2) } : {}),
                city: toAddr.city ? String(toAddr.city) : undefined,
                state: toAddr.state ? String(toAddr.state) : undefined,
                postal_code: toAddr.zip ? String(toAddr.zip) : undefined,
                country: toAddr.country ? String(toAddr.country) : undefined,
            },
        };
    } catch {
        // Network error / timeout / abort — safe to proceed without shipping.
        return null;
    }
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
        // full-label — anonymous PIs are permitted but get no saved-PM display
        // and no carrier-adjustment auto-recharge (anonymous payers fall
        // straight to "flag" if a post-pickup adjustment arrives).
        let resolvedUserId: string | null = null;
        let callerRole: string | null = null;
        let callerAdminMode: string = "test";
        let customerIdTest: string | null = null;
        let customerIdLive: string | null = null;
        let userEmail: string | null = null;
        let userFullName: string | null = null;
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
                    .select("role, admin_active_mode, stripe_customer_id_test, stripe_customer_id_live, email, full_name")
                    .eq("id", resolvedUserId)
                    .maybeSingle();
                callerRole = (profile?.role as string) ?? null;
                callerAdminMode = (profile?.admin_active_mode as string) ?? "test";
                customerIdTest = (profile?.stripe_customer_id_test as string) ?? null;
                customerIdLive = (profile?.stripe_customer_id_live as string) ?? null;
                userEmail = (profile?.email as string) ?? null;
                userFullName = (profile?.full_name as string) ?? null;
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

        // ─── B5 Account Budget check (proposal 2026-05-21, decided 2026-05-22) ──
        // ORDERING (preserved from risk-intel B5): the budget check runs
        // BEFORE PI creation so a refusal never leaves a charged-but-no-label
        // race. Only enforced when there's an account to budget. Anonymous
        // full-label payers fall through (Radar still applies on-session).
        //
        // After this gate passes, H2 D1 work runs:
        //   1. getOrCreateCustomerForUser (so customerForPi is non-null for
        //      authenticated buyers — required by setup_future_usage).
        //   2. fetchEasypostToAddress (Risk-Intel Job 3 bundling — destination
        //      address as Stripe `shipping` for Radar).
        //   3. createPaymentIntent with customer + setup_future_usage=off_session.
        if (resolvedUserId && sbAdmin) {
            const bcMode: "live" | "test" = isLive ? "live" : "test";
            const budgetCheck = await checkAccountBudget(
                sbAdmin, resolvedUserId, bcMode, amount_cents,
            );
            if (!budgetCheck.ok) {
                log({
                    event_type: "velocity.limit_hit",
                    session_id: sessionId,
                    severity: "warn",
                    entity_type: "payment_intent",
                    properties: {
                        layer: "account_budget",
                        window: budgetCheck.window,
                        limit_cents: budgetCheck.limit_cents,
                        spent_cents: budgetCheck.spent_cents,
                        attempted_cents: budgetCheck.attempted_cents,
                        user_id: resolvedUserId,
                        mode: bcMode,
                        source: "sendmo_full_label",
                    },
                });
                // Notify the account holder (fire-and-forget, 5s timeout).
                if (body.receipt_email) {
                    const acBud = new AbortController();
                    const tidBud = setTimeout(() => acBud.abort(), 5000);
                    try {
                        const tpl = budgetReachedEmail({
                            window: budgetCheck.window!,
                            limitCents: budgetCheck.limit_cents!,
                        });
                        await sendEmail({
                            to: body.receipt_email, subject: tpl.subject, html: tpl.html,
                            signal: acBud.signal,
                        });
                        clearTimeout(tidBud);
                    } catch {
                        clearTimeout(tidBud);
                        // Swallow — email is best-effort.
                    }
                }
                return jsonResponse(
                    { error: "This account has reached its spending limit. Contact SendMo to raise it." },
                    402,
                );
            }
        }

        // ─── D1: Ensure Stripe Customer for authenticated buyers ──────────────
        //
        // Save-card on the full-label PI requires a Customer + setup_future_usage.
        // For authenticated buyers we get-or-create a Stripe Customer here
        // (mirrors payment-methods/:ensureCustomer). Anonymous buyers continue
        // to pay without a saved card — their post-pickup adjustments will
        // route to "flag" in the recovery engine.
        let customerForPi: string | undefined = (isLive ? customerIdLive : customerIdTest) ?? undefined;
        if (resolvedUserId && sbAdmin && !customerForPi) {
            try {
                customerForPi = await getOrCreateCustomerForUser(
                    sbAdmin, resolvedUserId, userEmail, isLive, userFullName,
                );
            } catch (custErr) {
                // Fall back to anonymous PI (no save-card) on Customer create
                // failure. Logged so the gap is visible but never blocks the
                // checkout.
                log({
                    event_type: "payment.get_or_create_customer_failed",
                    session_id: sessionId,
                    severity: "warn",
                    entity_type: "payment_intent",
                    properties: {
                        error_message: custErr instanceof Error ? custErr.message : String(custErr),
                        user_id: resolvedUserId,
                        live_mode: isLive,
                    },
                });
                customerForPi = undefined;
            }
        }

        const idempotencyKey = customerForPi
            ? `pi_create_${body.easypost_shipment_id}_${customerForPi}`
            : `pi_create_${body.easypost_shipment_id}`;

        // ─── Risk-Intel Job 3 bundling — destination address as Stripe `shipping` ──
        // Fetch the EasyPost shipment to read its to_address. Optional —
        // failure returns null and PI is created without `shipping` (current
        // behavior, on-session Radar already strong). One EasyPost GET.
        const shipping = await fetchEasypostToAddress(body.easypost_shipment_id, isLive);

        const pi = await createPaymentIntent({
            amount_cents,
            currency: "usd",
            capture_method: "automatic",
            customer: customerForPi,
            // H2 D1: save the card so carrier-adjustment recharges (≤$10 tier)
            // can fire off_session via createAdjustmentRecharge. Only meaningful
            // when `customer` is set — Stripe rejects setup_future_usage
            // without one. Anonymous buyers naturally fall through.
            ...(customerForPi ? { setup_future_usage: "off_session" as const } : {}),
            // Risk-Intel B2 destination-address signal (now wired — Job 3).
            ...(shipping ? { shipping } : {}),
            // "SENDMO* LABEL" on bank statements (requires account-level
            // statement descriptor = "SENDMO" set in Stripe Dashboard).
            // See proposals/2026-05-27_business-identifier-sweep-handoff.md.
            statement_descriptor_suffix: "LABEL",
            metadata: {
                easypost_shipment_id: body.easypost_shipment_id,
                session_id: sessionId,
                source: "sendmo_full_label",
                // txn_kind — Radar/Fraud-Teams discriminator (B2).
                txn_kind: "cit_full_label",
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
