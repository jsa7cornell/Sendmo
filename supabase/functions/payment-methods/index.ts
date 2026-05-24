import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import {
    createCustomer,
    createSetupIntent,
    detachPaymentMethod,
    listCustomerCardPaymentMethods,
    retrieveCustomer,
} from "../_shared/stripe.ts";

// /payment-methods — Phase B saved-cards surface.
//
// POST                → creates a SetupIntent for the calling user in the
//                       server-resolved mode. Returns { client_secret,
//                       setup_intent_id }. The actual payment_methods row is
//                       written by stripe-webhook on payment_method.attached
//                       (which carries brand/last4/exp inline — see proposal
//                       2026-05-13 Phase B B1 fix).
// DELETE /:pm_id      → detaches the card in Stripe + soft-deletes the
//                       payment_methods row (idempotent; the webhook also
//                       handles payment_method.detached as a backstop).
//
// Mode resolution: server reads `profiles.admin_active_mode` for the calling
// user. Live mode IFF the user is admin AND admin_active_mode IN ('live_comp',
// 'live_charge'). Non-admins are always test. The client sends NO mode param —
// Rule 14, master proposal §4.4.

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000001";

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

async function resolveCaller(req: Request): Promise<{
    userId: string;
    email: string | null;
    role: string | null;
    adminActiveMode: string;
    liveMode: boolean;
    supabase: ReturnType<typeof createClient>;
} | null> {
    const authHeader = req.headers.get("Authorization") || req.headers.get("authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return null;

    const sbUrl = Deno.env.get("SUPABASE_URL")!;
    const sbServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(sbUrl, sbServiceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: userResp } = await supabase.auth.getUser(token);
    const user = userResp?.user;
    if (!user) return null;

    const { data: profile } = await supabase
        .from("profiles")
        .select("id, email, role, admin_active_mode")
        .eq("id", user.id)
        .maybeSingle();

    const adminActiveMode = (profile?.admin_active_mode as string) || "test";
    const role = (profile?.role as string) || null;
    const liveMode = role === "admin" && (adminActiveMode === "live_comp" || adminActiveMode === "live_charge");

    return {
        userId: user.id,
        email: (profile?.email as string) || user.email || null,
        role,
        adminActiveMode,
        liveMode,
        supabase,
    };
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

    const sessionId = req.headers.get("x-session-id") || "unknown";
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/payment-methods\/?/, "");
    const method = req.method;

    const caller = await resolveCaller(req);
    if (!caller) return jsonResponse({ error: "Unauthorized" }, 401);

    const mode = caller.liveMode ? "live" : "test";

    try {
        // GET /payment-methods → list the caller's saved cards directly from
        // Stripe (source of truth). Source-of-truth fix per 2026-05-24
        // investigation: the local payment_methods table can silently drift
        // from Stripe Customer reality if a `payment_method.attached` webhook
        // event is ever missed (e.g. PM attached during an interaction that
        // didn't deliver the event). For the read-side surface (Dashboard
        // "My Wallet"), bypass the local table entirely. The local table is
        // still maintained by the stripe-webhook handler and remains the
        // off-session-charging reference for the H2 carrier-adjustment flow.
        if (method === "GET" && path === "") {
            // Look up the existing customer for this user+mode. Do NOT call
            // ensureCustomer here — we don't want a side-effect Customer
            // creation on a read endpoint. Users with no Customer get [].
            const col = caller.liveMode ? "stripe_customer_id_live" : "stripe_customer_id_test";
            const { data: profileRow } = await caller.supabase
                .from("profiles")
                .select(col)
                .eq("id", caller.userId)
                .maybeSingle();
            const customerId = (profileRow as Record<string, string | null> | null)?.[col] ?? null;
            if (!customerId) {
                return jsonResponse({ payment_methods: [] }, 200);
            }

            // Two Stripe calls in parallel: list PMs + retrieve customer
            // (to resolve invoice_settings.default_payment_method for the
            // is_default flag).
            const [pmsResult, customer] = await Promise.all([
                listCustomerCardPaymentMethods({ customerId, liveMode: caller.liveMode }),
                retrieveCustomer({ customerId, liveMode: caller.liveMode }),
            ]);
            const defaultPmId = customer.invoice_settings?.default_payment_method ?? null;

            const rows = pmsResult.data.map((pm) => ({
                // `id` matches the local-table contract; use the Stripe PM id
                // since there's no local UUID when reading from Stripe directly.
                id: pm.id,
                stripe_payment_method_id: pm.id,
                mode,
                brand: pm.card?.brand ?? null,
                last4: pm.card?.last4 ?? null,
                exp_month: pm.card?.exp_month ?? null,
                exp_year: pm.card?.exp_year ?? null,
                is_default: defaultPmId != null && pm.id === defaultPmId,
                // Stripe returns `created` as unix seconds.
                created_at: new Date(pm.created * 1000).toISOString(),
            }));

            return jsonResponse({ payment_methods: rows }, 200);
        }

        // POST /payment-methods → create SetupIntent (start "Add card" flow).
        if (method === "POST" && path === "") {
            // Idempotency: per master proposal §4.5, allow legitimate user
            // retries by suffixing :retry-N. The client sends `retry_n`
            // (defaults 0). Stripe sees a fresh SetupIntent only when
            // retry_n increments.
            let retryN = 0;
            try {
                const body = await req.json();
                if (typeof body?.retry_n === "number" && body.retry_n >= 0) {
                    retryN = body.retry_n;
                }
            } catch {
                // empty body is fine
            }

            const customerId = await ensureCustomer(
                caller.supabase, caller.userId, caller.email, caller.liveMode,
            );

            const idempotencyKey = `seti_create:${caller.userId}:${mode}:retry-${retryN}`;

            // ─── B5 PM-add breaker (proposal 2026-05-21, decided 2026-05-22) ──
            // Cap how many SetupIntents (card-adds) one account creates in
            // a rolling 24h. A normal user adds 1–3 cards ever; a card-tester
            // creates dozens — wide gap. Stripe's idempotent SetupIntent
            // retries (same idempotency_key) are pre-deduped by Stripe, so
            // this counts distinct setup-intent rows per (user, mode) per day.
            //
            // Counts all setup-intent rows regardless of status — i.e. counts
            // ATTEMPTS, not completions. Slightly tighter than counting only
            // succeeded ones: a legitimate user who abandons 4 SetupIntents
            // would hit the breaker on a 5th attempt the same day. Defensible
            // (card-testers also burn SetupIntents through failures), and a
            // false positive is recoverable via support. If complaints emerge,
            // tighten by filtering to `status IN ('succeeded','requires_action',
            // 'requires_payment_method')` — review N-5.
            const PM_ADD_LIMIT_PER_DAY = 5;
            const dayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            const { count: recentSetupCount } = await caller.supabase
                .from("stripe_intents")
                .select("id", { count: "exact", head: true })
                .eq("user_id", caller.userId)
                .eq("intent_kind", "setup")
                .eq("mode", mode)
                .gte("created_at", dayAgoIso);
            if ((recentSetupCount ?? 0) >= PM_ADD_LIMIT_PER_DAY) {
                log({
                    event_type: "velocity.limit_hit",
                    session_id: sessionId,
                    severity: "warn",
                    entity_type: "user",
                    entity_id: caller.userId,
                    properties: {
                        layer: "pm_add",
                        window: "daily",
                        limit: PM_ADD_LIMIT_PER_DAY,
                        count: recentSetupCount,
                        mode,
                    },
                });
                return jsonResponse(
                    { error: "You've added several cards recently. Please contact support if you need to add another." },
                    429,
                );
            }

            const seti = await createSetupIntent({
                customer: customerId,
                metadata: {
                    sendmo_user_id: caller.userId,
                    // txn_kind — Radar/Fraud-Teams discriminator (B2).
                    txn_kind: "setup",
                    mode,
                },
                idempotency_key: idempotencyKey,
                liveMode: caller.liveMode,
            });

            // Mirror into stripe_intents. Idempotency-friendly UPSERT on
            // stripe_intent_id; if a prior request already created this
            // SetupIntent (Stripe replay), the existing row updates.
            await caller.supabase.from("stripe_intents").upsert({
                user_id: caller.userId,
                stripe_intent_id: seti.id,
                intent_kind: "setup",
                funding_source: "card",
                status: seti.status,
                mode,
                idempotency_key: `seti.${seti.id}:create`,
                last_event_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            }, { onConflict: "stripe_intent_id" });

            log({
                event_type: "payment_method.setup_intent_created",
                session_id: sessionId,
                severity: "info",
                entity_type: "setup_intent",
                entity_id: seti.id,
                properties: { live_mode: caller.liveMode, user_id: caller.userId },
            });

            return jsonResponse({
                client_secret: seti.client_secret,
                setup_intent_id: seti.id,
            });
        }

        // DELETE /payment-methods/:pm_id → detach + soft-delete.
        if (method === "DELETE" && path) {
            const pmId = path;
            if (!/^pm_[A-Za-z0-9]+$/.test(pmId)) {
                return jsonResponse({ error: "Invalid payment method id" }, 400);
            }

            // Verify ownership in OUR table before calling Stripe — prevents
            // an attacker with someone else's pm_id from detaching it.
            const { data: row } = await caller.supabase
                .from("payment_methods")
                .select("id, user_id, mode, stripe_payment_method_id")
                .eq("stripe_payment_method_id", pmId)
                .eq("user_id", caller.userId)
                .is("deleted_at", null)
                .maybeSingle();
            if (!row) return jsonResponse({ error: "Card not found" }, 404);

            // The mode the card was saved under is what matters for the
            // Stripe API call — not the caller's current admin_active_mode.
            const cardLiveMode = row.mode === "live";

            // Detach in Stripe first. If Stripe errors we surface to the user
            // and don't soft-delete locally (so they can retry).
            try {
                await detachPaymentMethod(pmId, cardLiveMode);
            } catch (err) {
                const msg = err instanceof Error ? err.message : "Stripe detach failed";
                // If Stripe already detached the PM (e.g., webhook lost),
                // 404 from Stripe is benign — still soft-delete locally.
                if (!/no such payment_method|already detached/i.test(msg)) {
                    throw err;
                }
            }

            // Soft-delete locally. The webhook will also handle
            // payment_method.detached → set deleted_at; ON CONFLICT-friendly.
            await caller.supabase
                .from("payment_methods")
                .update({ deleted_at: new Date().toISOString() })
                .eq("id", row.id);

            log({
                event_type: "payment_method.detached_by_user",
                session_id: sessionId,
                severity: "info",
                entity_type: "payment_method",
                entity_id: pmId,
                properties: { user_id: caller.userId, mode: row.mode },
            });

            return jsonResponse({ ok: true });
        }

        return jsonResponse({ error: "Not found" }, 404);
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Internal error";
        console.error("[payment-methods] error:", msg);
        log({
            event_type: "payment_method.error",
            session_id: sessionId,
            severity: "error",
            entity_type: "edge_function",
            properties: { error_message: msg, method, path, user_id: caller.userId },
        });
        return jsonResponse({ error: msg }, 502);
    }
});

// Suppress unused-import warning for tooling — re-export touches all helpers.
export { SYSTEM_USER_ID };
