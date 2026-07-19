import { createClient } from "jsr:@supabase/supabase-js@2.97.0";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { assertKeysMatchEnv } from "../_shared/env-guard.ts";
import { checkLiveChargeAllowed } from "../_shared/allowlist.ts";
import { applyMarkup } from "../_shared/pricing.ts";
import { createPaymentIntent, type ShippingDetails } from "../_shared/stripe.ts";

// POST /seller-checkout
//
// Creates a Stripe PaymentIntent for the SELLER-LINK flow: an anonymous BUYER
// pays on-session (Payment Element, cardholder present) for a shipping label on
// a seller's link. The label is bought later, client-triggered, by labels/
// (which re-verifies this PI's amount + metadata at buy time).
//
// This is a HYBRID of the two existing legs, which is why it is its own
// endpoint and not a branch of payments/ (decided OQ4):
//   • on-session, client-confirmed PI            → like full-label
//   • anonymous party transacting on a LINK      → like the flex sender
//   • mode / price / allowlist / merchant-of-record all derived from the
//     SELLER'S LINK server-side, never the caller or client body → like flex
//
//   Request:  { link_short_code, easypost_shipment_id, easypost_rate_id, buyer_email? }
//   Stripe:   capture_method='automatic'; NO customer, NO setup_future_usage
//             (a stranger — no saved card); statement_descriptor = link short_code;
//             amount = applyMarkup(rate) capped at link.max_price_cents.
//   Response: { client_secret, payment_intent_id, status }
//
// Decided proposal:
//   proposals/2026-07-17_seller-link-buyer-pays_reviewed-2026-07-17_decided-2026-07-17.md

interface SellerCheckoutBody {
    link_short_code?: string;
    easypost_shipment_id?: string;
    easypost_rate_id?: string;
    buyer_email?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

// Pull the EasyPost shipment's to_address for use as Stripe's `shipping` param
// (Radar destination-address signal). Best-effort — failure returns null and
// the PI is created without `shipping`. Mirrors payments/:fetchEasypostToAddress.
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
            { headers: { Authorization: "Basic " + btoa(apiKey + ":") }, signal: ac.signal },
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
        return null;
    }
}

Deno.serve(async (req: Request) => {
    const corsResponse = handleCors(req);
    if (corsResponse) return corsResponse;

    if (req.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405);
    }

    // T2-4 key-mismatch guard — refuse the money path when a test key is
    // present in production (keyed on SENDMO_ENV, not the kill switch).
    try {
        assertKeysMatchEnv();
    } catch (guardErr) {
        const guardMsg = guardErr instanceof Error ? guardErr.message : "Environment key mismatch";
        console.error("[seller-checkout] env-guard:", guardMsg);
        return jsonResponse({ error: guardMsg }, 500);
    }

    const sessionId = req.headers.get("x-session-id") || "unknown";
    const start = Date.now();

    try {
        const body = (await req.json()) as SellerCheckoutBody;

        const { link_short_code, easypost_shipment_id, easypost_rate_id } = body;
        if (!link_short_code || typeof link_short_code !== "string" || !link_short_code.match(/^[a-zA-Z0-9]{1,20}$/)) {
            return jsonResponse({ error: "Missing or invalid link_short_code" }, 400);
        }
        if (!easypost_shipment_id || typeof easypost_shipment_id !== "string") {
            return jsonResponse({ error: "Missing required field: easypost_shipment_id" }, 400);
        }
        if (!easypost_rate_id || typeof easypost_rate_id !== "string") {
            return jsonResponse({ error: "Missing required field: easypost_rate_id" }, 400);
        }
        // buyer_email is REQUIRED (review B2): it is the persisted marker that
        // identifies a seller-link sale downstream (F1) and the address the
        // buyer's receipt / tracking / tokenized cancel link go to. Without it,
        // cancel-label + tracking can't tell the sale apart from a full-label
        // one and would route the buyer's receipt to the seller.
        if (
            !body.buyer_email ||
            typeof body.buyer_email !== "string" ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.buyer_email.trim()) ||
            body.buyer_email.length > 254
        ) {
            return jsonResponse({ error: "Missing or invalid buyer_email" }, 400);
        }

        const sbUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("VITE_SUPABASE_URL");
        const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SB_SERVICE_ROLE_KEY");
        const sbAdmin = sbUrl && sbKey
            ? createClient(sbUrl, sbKey, { auth: { autoRefreshToken: false, persistSession: false } })
            : null;
        if (!sbAdmin) {
            return jsonResponse({ error: "Server configuration error" }, 500);
        }

        // ─── Resolve the SELLER link (service role — bypasses RLS) ────────────
        // Everything trusted (mode, cap, merchant-of-record) comes from this row.
        const { data: link, error: linkErr } = await sbAdmin
            .from("sendmo_links")
            .select("id, short_code, user_id, status, link_type, funder, max_price_cents, is_test")
            .eq("short_code", link_short_code)
            .single();
        if (linkErr || !link) {
            return jsonResponse({ error: "Link not found" }, 404);
        }
        if (link.status !== "active") {
            return jsonResponse({ error: `Link not active (status=${link.status})` }, 410);
        }
        if (link.link_type !== "seller_link") {
            return jsonResponse({ error: "Link is not a seller link" }, 403);
        }
        // v1 is buyer-pays only. A seller-funded link ('seller') charges the
        // seller off_session via Pattern D, NOT this on-session buyer endpoint.
        if (link.funder !== "buyer") {
            return jsonResponse({ error: "This link is seller-funded; buyer checkout does not apply" }, 400);
        }

        // ─── Link-derived mode (mirror flex, labels/index.ts:251) ─────────────
        // The anonymous buyer has no caller identity; the seller set the mode
        // when they created the link. is_test is the server-side source of truth.
        const isLive = link.is_test !== true;

        // ─── Kill switch (review — the "one-flip halt" must cover the 3rd money
        // path). When live money is globally paused (SENDMO_LIVE_DEFAULT != "true"),
        // refuse to create a LIVE seller-checkout PI, just as labels/ refuses the
        // flex + full-label buys. Test mode is never gated. The charge originates
        // HERE, so this is the correct place to halt it.
        if (isLive && Deno.env.get("SENDMO_LIVE_DEFAULT") !== "true") {
            log({
                event_type: "payment.live_paused_by_kill_switch",
                session_id: sessionId,
                severity: "warn",
                entity_type: "payment_intent",
                properties: { source: "sendmo_seller_link", seller_user_id: link.user_id },
            });
            return jsonResponse({ error: "Live payments are temporarily paused. Please try again shortly." }, 503);
        }

        // ─── Live-charge allowlist gate — gate the SELLER (link owner) ────────
        // Mirrors the flex leg, which gates resolvedLink.user_id (not the caller).
        if (isLive) {
            const gate = checkLiveChargeAllowed("customer", link.user_id);
            if (!gate.allowed) {
                log({
                    event_type: "payment.live_charge_blocked",
                    session_id: sessionId,
                    severity: "warn",
                    entity_type: "payment_intent",
                    properties: { seller_user_id: link.user_id, reason: gate.reason, source: "sendmo_seller_link" },
                });
                return jsonResponse({ error: "Live charges are not enabled for this seller." }, 403);
            }
        }

        // ─── Server-derive the amount from the buyer's chosen rate ────────────
        // NEVER trust a client price (B4). Re-fetch the rate by id, apply the
        // markup, cap at the seller's max_price_cents. Mirrors labels/:263-332.
        const rateKey = Deno.env.get(isLive ? "EASYPOST_API_KEY" : "EASYPOST_TEST_API_KEY");
        if (!rateKey) {
            return jsonResponse({ error: `EasyPost ${isLive ? "Live" : "Test"} API key not configured` }, 500);
        }

        // ─── Seller-link binding (review BLOCKER) ─────────────────────────────
        // The anonymous buyer supplies easypost_shipment_id, so we must prove it
        // was minted FROM THIS link's origin+parcel via the seller rate path —
        // otherwise a buyer could mint a cheap 1oz shipment through the no-link
        // rate path and pay its price for a label the seller applies to the real
        // (heavier) item, collapsing "server derives the amount" into "buyer picks
        // the amount". rates/ stamps shipment.reference = link.id on the seller
        // path; an attacker can't forge it (no EasyPost API key). Verify it here,
        // before pricing, and again at buy time in labels/.
        const bindResp = await fetch(
            `https://api.easypost.com/v2/shipments/${easypost_shipment_id}`,
            { headers: { Authorization: "Basic " + btoa(rateKey + ":") } },
        );
        if (!bindResp.ok) {
            return jsonResponse({ error: "Could not verify shipment" }, 502);
        }
        const bindShip = await bindResp.json();
        if (!bindShip || bindShip.reference !== link.id) {
            log({
                event_type: "seller_checkout.shipment_link_mismatch",
                session_id: sessionId,
                severity: "warn",
                entity_type: "payment_intent",
                entity_id: easypost_shipment_id,
                properties: {
                    link_short_code: link.short_code,
                    expected_link_id: link.id,
                    got_reference: bindShip?.reference ?? null,
                },
            });
            return jsonResponse({ error: "This shipment does not belong to this seller link." }, 403);
        }

        let amountCents: number;
        const rateResp = await fetch(
            `https://api.easypost.com/v2/shipments/${easypost_shipment_id}/rates/${easypost_rate_id}`,
            { headers: { Authorization: "Basic " + btoa(rateKey + ":") } },
        );
        if (rateResp.ok) {
            const rateData = await rateResp.json();
            amountCents = applyMarkup(parseFloat(rateData.rate));
        } else {
            // Fallback: pull the rate off the shipment payload.
            const shipResp = await fetch(
                `https://api.easypost.com/v2/shipments/${easypost_shipment_id}`,
                { headers: { Authorization: "Basic " + btoa(rateKey + ":") } },
            );
            if (!shipResp.ok) {
                return jsonResponse({ error: "Could not verify rate" }, 502);
            }
            const shipData = await shipResp.json();
            const matched = (shipData.rates || []).find((r: { id: string }) => r.id === easypost_rate_id);
            if (!matched) {
                return jsonResponse({ error: "Rate not found on shipment" }, 404);
            }
            amountCents = applyMarkup(parseFloat(matched.rate));
        }
        if (amountCents > link.max_price_cents) {
            log({
                event_type: "seller_checkout.cap_exceeded",
                session_id: sessionId,
                severity: "warn",
                entity_type: "payment_intent",
                entity_id: easypost_shipment_id,
                properties: {
                    link_short_code: link.short_code,
                    server_derived_cents: amountCents,
                    max_price_cents: link.max_price_cents,
                },
            });
            return jsonResponse({ error: "Rate exceeds the seller's price cap" }, 403);
        }
        if (amountCents < 50) {
            return jsonResponse({ error: "Amount below Stripe minimum" }, 400);
        }

        // Radar destination-address signal (best-effort, one EasyPost GET).
        const shipping = await fetchEasypostToAddress(easypost_shipment_id, isLive);

        // ─── Create the on-session PI (unconfirmed — the client confirms the
        // Payment Element). No customer / no setup_future_usage: the buyer is a
        // stranger with no saved card (mirrors the anonymous full-label branch).
        const pi = await createPaymentIntent({
            amount_cents: amountCents,
            currency: "usd",
            capture_method: "automatic",
            ...(shipping ? { shipping } : {}),
            // "SENDMO* <shortcode>" — ties the bank statement to this shipment
            // (mirrors the flex leg's use of link.short_code).
            statement_descriptor_suffix: link.short_code,
            metadata: {
                easypost_shipment_id,
                link_short_code: link.short_code,
                session_id: sessionId,
                source: "sendmo_seller_link",
                txn_kind: "cit_seller_link",
                intent_role: "shipment",
                // Merchant-of-record = the SELLER (decided OQ3): the stripe-webhook
                // ledger resolver reads sendmo_user_id → the charge books under the
                // seller. link_id lets the webhook stamp transactions.link_id (F2), so
                // the seller's Account Budget can EXCLUDE these buyer charges (N1) — a
                // buyer's purchase is not the seller's spend. This endpoint itself runs
                // no budget check (the payer is the buyer).
                sendmo_user_id: link.user_id,
                link_id: link.id,
                buyer_email: body.buyer_email,
            },
            receipt_email: body.buyer_email,
            idempotency_key: `pi_seller_${easypost_shipment_id}`,
            liveMode: isLive,
        });

        log({
            event_type: "payment.intent_created",
            session_id: sessionId,
            severity: "info",
            entity_type: "payment_intent",
            entity_id: pi.id,
            duration_ms: Date.now() - start,
            properties: {
                amount_cents: pi.amount, currency: pi.currency, status: pi.status,
                easypost_shipment_id, live_mode: isLive,
                intent_role: "shipment", source: "sendmo_seller_link",
                link_short_code: link.short_code, seller_user_id: link.user_id,
            },
        });

        return jsonResponse({
            client_secret: pi.client_secret,
            payment_intent_id: pi.id,
            status: pi.status,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Internal server error";
        console.error(`[Session ${sessionId}] [seller-checkout] error:`, msg);
        log({
            event_type: "payment.intent_error",
            session_id: sessionId,
            severity: "error",
            entity_type: "payment_intent",
            duration_ms: Date.now() - start,
            properties: { error_message: msg, source: "sendmo_seller_link" },
        });
        return jsonResponse({ error: msg }, 500);
    }
});
