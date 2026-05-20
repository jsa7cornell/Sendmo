import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { requireAdmin } from "../_shared/auth.ts";

// ─────────────────────────────────────────────────────────────────────────────
// tracking-admin — admin debug surface for /t/<public_code>
// "Ask 4" of the 2026-05-13 tracking-page-ia-polish proposal.
//
// Scoped to a dedicated endpoint (not folded into the public /tracking
// response) so:
//   - Privileged fields (UUIDs, payment intent IDs, IPs, user agents, full
//     ledger rows) are isolated behind their own auth check.
//   - The public tracking response stays slim and field-omission bugs can't
//     accidentally leak privileged data.
//
// GET /functions/v1/tracking-admin?code=<public_code>
//   → requires admin JWT
//   → returns rich debug payload: identifiers, mode flags, state, timeline,
//     parent link, transactions ledger rows for this shipment, last N
//     event_logs rows for this entity.
//
// GET /functions/v1/tracking-admin?code=<public_code>&refetch=easypost
//   → same payload, additionally fetches the EasyPost shipment object live
//     and surfaces its raw JSON in `easypost.shipment`. Useful for confirming
//     "did the carrier refund land yet" without leaving the page.
//
// is_live derivation: shipments stores `is_test` (bool) — the canonical
// "what API key was this generated against" flag. is_live is just !is_test;
// surfaced as a separate field so admins reading the JSON don't have to
// invert it mentally.
//
// cancel_token: NEVER returned in cleartext. Defanged to a short label
// indicating presence + last 4 chars. Anyone with full DB access can
// retrieve it through Supabase Studio if needed.
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_LOG_LIMIT = 10;
const TXN_LIMIT = 50;

function defangToken(token: string | null | undefined): string | null {
    if (!token) return null;
    if (token.length < 8) return "present";
    return `••••• ${token.slice(-4)}`;
}

serve(async (req: Request) => {
    const corsResponse = handleCors(req);
    if (corsResponse) return corsResponse;

    if (req.method !== "GET" && req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    // Auth gate first — every code path below relies on the admin context.
    let ctx;
    try {
        ctx = await requireAdmin(req, corsHeaders);
    } catch (r) {
        if (r instanceof Response) return r;
        throw r;
    }
    const { supabase, user: callerUser } = ctx;

    const url = new URL(req.url);
    const publicCode = url.searchParams.get("code");
    const refetch = url.searchParams.get("refetch");

    if (!publicCode) {
        return new Response(
            JSON.stringify({ error: "Missing required query param: code" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    try {
        // Pull the shipment row + parent link + addresses. Mirrors the public
        // tracking SELECT but adds the privileged fields (cancel_token, IDs,
        // is_test, payment_method, etc.).
        const shipmentSelect = [
            "id", "tracking_number", "public_code", "carrier", "service",
            "status", "refund_status", "is_test", "payment_method",
            "easypost_shipment_id", "easypost_tracker_id",
            "stripe_payment_intent_id",
            "cancel_token", "carrier_refund_id",
            "rate_cents", "display_price_cents",
            "weight_oz", "length_in", "width_in", "height_in",
            "item_description",
            "created_at", "updated_at", "cancelled_at", "delivered_at",
            "refund_submitted_at", "promised_delivery_date",
            "label_url", "link_id",
            "sender_address:addresses!sender_address_id(name,street1,city,state,zip)",
            "recipient_address:addresses!recipient_address_id(name,street1,city,state,zip)",
            "sendmo_links!inner(id,short_code,link_type,status,user_id,created_at,updated_at)",
        ].join(", ");

        const { data: shipment, error: shipErr } = await supabase
            .from("shipments")
            .select(shipmentSelect)
            .eq("public_code", publicCode)
            .maybeSingle();

        if (shipErr || !shipment) {
            return new Response(
                JSON.stringify({ error: "Shipment not found", details: shipErr?.message }),
                { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Parallel fetches — ledger rows for this shipment + last N event_logs.
        // The ledger query keys on the shipment_id column added in Stripe Phase A
        // migration 017 (transactions.shipment_id FK).
        const txnPromise = supabase
            .from("transactions")
            .select("id, type, amount_cents, mode, idempotency_key, stripe_payment_intent_id, stripe_charge_id, stripe_refund_id, created_at")
            .eq("shipment_id", shipment.id)
            .order("created_at", { ascending: false })
            .limit(TXN_LIMIT);

        const eventPromise = supabase
            .from("event_logs")
            .select("id, event_type, severity, source, duration_ms, properties, created_at")
            .eq("entity_type", "shipment")
            .eq("entity_id", shipment.id)
            .order("created_at", { ascending: false })
            .limit(EVENT_LOG_LIMIT);

        // Optional EasyPost refetch — only fires when ?refetch=easypost is set.
        // Uses the live or test key based on the shipment's is_test flag.
        let easypostFetchPromise: Promise<unknown | null> = Promise.resolve(null);
        if (refetch === "easypost" && shipment.easypost_shipment_id) {
            const apiKey = Deno.env.get(shipment.is_test ? "EASYPOST_TEST_API_KEY" : "EASYPOST_API_KEY");
            if (apiKey) {
                easypostFetchPromise = fetch(
                    `https://api.easypost.com/v2/shipments/${shipment.easypost_shipment_id}`,
                    { headers: { Authorization: "Basic " + btoa(apiKey + ":") } },
                ).then(async (r) => r.ok ? r.json() : { error: `EasyPost ${r.status}`, body: await r.text() })
                 .catch((e) => ({ error: String(e) }));
            }
        }

        const [txnRes, eventRes, epShipment] = await Promise.all([
            txnPromise, eventPromise, easypostFetchPromise,
        ]);

        const link = shipment.sendmo_links as unknown as {
            id: string;
            short_code: string;
            link_type: string;
            status: string;
            user_id: string;
            created_at: string;
            updated_at: string;
        } | null;

        const senderAddr = shipment.sender_address as unknown as Record<string, string | null> | null;
        const recipientAddr = shipment.recipient_address as unknown as Record<string, string | null> | null;

        return new Response(
            JSON.stringify({
                identifiers: {
                    shipment_id: shipment.id,
                    public_code: shipment.public_code,
                    tracking_number: shipment.tracking_number,
                    easypost_shipment_id: shipment.easypost_shipment_id,
                    easypost_tracker_id: shipment.easypost_tracker_id,
                    stripe_payment_intent_id: shipment.stripe_payment_intent_id,
                    cancel_token: defangToken(shipment.cancel_token),
                    carrier_refund_id: shipment.carrier_refund_id,
                },
                mode: {
                    is_test: shipment.is_test === true,
                    is_live: shipment.is_test !== true,
                    payment_method: shipment.payment_method,
                    carrier: shipment.carrier,
                    service: shipment.service,
                },
                state: {
                    status: shipment.status,
                    refund_status: shipment.refund_status,
                },
                timeline: {
                    created_at: shipment.created_at,
                    updated_at: shipment.updated_at,
                    cancelled_at: shipment.cancelled_at,
                    refund_submitted_at: shipment.refund_submitted_at,
                    delivered_at: shipment.delivered_at,
                    promised_delivery_date: shipment.promised_delivery_date,
                },
                parcel: {
                    weight_oz: shipment.weight_oz,
                    length_in: shipment.length_in,
                    width_in: shipment.width_in,
                    height_in: shipment.height_in,
                    item_description: shipment.item_description,
                },
                money: {
                    rate_cents: shipment.rate_cents,
                    display_price_cents: shipment.display_price_cents,
                },
                addresses: {
                    sender: senderAddr ? {
                        name: senderAddr.name, street1: senderAddr.street1,
                        city: senderAddr.city, state: senderAddr.state, zip: senderAddr.zip,
                    } : null,
                    recipient: recipientAddr ? {
                        name: recipientAddr.name, street1: recipientAddr.street1,
                        city: recipientAddr.city, state: recipientAddr.state, zip: recipientAddr.zip,
                    } : null,
                },
                link: link ? {
                    id: link.id,
                    short_code: link.short_code,
                    link_type: link.link_type,
                    status: link.status,
                    user_id: link.user_id,
                    created_at: link.created_at,
                    updated_at: link.updated_at,
                } : null,
                label_url: shipment.label_url,
                transactions: (txnRes.data ?? []) as unknown[],
                event_logs: (eventRes.data ?? []) as unknown[],
                easypost: refetch === "easypost" ? { shipment: epShipment } : null,
                _meta: {
                    queried_by: callerUser.id,
                    queried_at: new Date().toISOString(),
                    refetch: refetch ?? null,
                },
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Internal server error";
        console.error("tracking-admin error:", msg);
        return new Response(
            JSON.stringify({ error: msg }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});
