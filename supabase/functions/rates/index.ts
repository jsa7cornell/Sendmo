import { createClient } from "jsr:@supabase/supabase-js@2.97.0";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { isUsablePhone } from "../_shared/phone.ts";
import { checkRateLimit, clientIpKey } from "../_shared/ratelimit.ts";

const MARKUP_MULTIPLIER = 1.15;
const MARKUP_FLAT_CENTS = 100; // $1.00 flat fee on top of the percentage markup
const MAX_DISPLAY_PRICE = 200;

// Service denylist — carrier+service pairs whose buy-time rate is not
// guaranteed to equal the rate-shop quote. We do not surface these to
// customers until the buy-time-rate-gate proposal lands and we have empirical
// confidence in the gap being small (or zero) in live mode.
// Format: { carrier: <lowercased>, service: <UPPERCASED> }
//
// 2026-05-23 — added FedEx Smart Post after shipment GC37EXG quoted at $9.61
//   was billed at $19.23 in test mode. Per the smart-post-denylist handoff
//   forensics (proposals/2026-05-23_smart-post-denylist-handoff.md):
//     • GC37EXG was test-mode — no physical label or carrier billing; the
//       gap is an EasyPost-API artifact, not a USPS / FedEx hub re-rate.
//     • The rate.fetched log recorded weight=32 oz at quote time. The
//       write-side weight=0 bug in labels/index.ts is unrelated to this
//       quote→buy gap (separate spinoff task).
//     • EasyPost rejects degenerate parcels (weight=0 or any dim=0) at the
//       API layer, so the rates fn cannot have silently sent zeros.
//     • Smart Post was the only carrier+service in the 32-shipment dataset
//       with any meaningful quote→buy gap. USPS GroundAdvantage (27 ships)
//       and UPS Ground/Groundsaver (4) all show $0.00 gap.
//   Diagnosis: EasyPost's test-mode integration contract for Smart Post does
//   not guarantee that the quoted rate equals the buy-time rate. We have
//   ZERO live Smart Post shipments, so live behavior is unknown — the
//   denylist is a precaution proportional to that lack of evidence.
//
// Re-enable path (subject to the buy-time-rate-gate proposal's final shape):
//   Phase 1 — shadow mode: the rates fn issues a real rate-shop including
//     Smart Post but does NOT surface Smart Post to customers; a separate
//     /shipments/{id}/buy call in test mode compares selected_rate.rate to
//     the quoted rate. Once buy-time delta < 5% holds for 30 consecutive
//     shadow probes, lift to Phase 2.
//   Phase 2 — gated live: lift the denylist, but the buy-time-rate-gate
//     intercepts any live Smart Post buy where the delta exceeds 5%. If
//     30 consecutive live Smart Post shipments pass the gate, consider the
//     denylist permanently retired for this service.
const SERVICE_DENYLIST: Array<{ carrier: string; service: string }> = [
    { carrier: "fedexdefault", service: "SMART_POST" },
    { carrier: "fedex", service: "SMART_POST" },          // defensive — covers either FedEx EP carrier-account label
];

// PRE-LAUNCH T2-3: public endpoint, burns EasyPost rate-shop quota (and can
// be pointed at the LIVE key via live_mode). 10 req/min/IP per SPEC §14.
const RATE_LIMIT = { max: 10, windowMs: 60_000 };

Deno.serve(async (req: Request) => {
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

    // Emit a rate.error event_logs row for any non-success exit. The early
    // guard returns + the outer catch were previously silent — a sender
    // failure left no telemetry at all, so Rule-20 telemetry-first debugging
    // came up blank. See LOG 2026-05-20 sender-flow rates-error entry.
    const logRateError = (
        reason: string,
        severity: "warn" | "error",
        extra: Record<string, unknown> = {},
    ) => {
        log({
            event_type: "rate.error",
            session_id: sessionId,
            severity,
            entity_type: "rate",
            properties: { reason, ...extra },
        });
    };

    if (checkRateLimit(clientIpKey(req), RATE_LIMIT)) {
        return new Response(
            JSON.stringify({ error: "Too many requests. Try again in a moment." }),
            { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    try {
        const body = await req.json();
        const { live_mode, link_short_code } = body;
        // Working address/parcel/pref vars. A FLEX link resolves to_address from
        // the link (the sender supplies from + parcel); a SELLER link resolves
        // from_address + parcel + the seller's carrier constraints from the link
        // (the buyer supplies only to_address). So these are mutable and the
        // required-fields check runs AFTER link resolution below.
        let from_address = body.from_address;
        let to_address = body.to_address;
        let parcel = body.parcel;
        let preferred_carrier = body.preferred_carrier;
        let preferred_speed = body.preferred_speed;
        let max_price_cents = body.max_price_cents;
        // T1-1 gate F (review B2/N2): when a link resolves below, its is_test
        // drives the EasyPost key choice and the client live_mode is ignored on
        // that path. Non-link callers keep the client hint — quote-only
        // exposure; the buy-side gates protect the money.
        let linkIsTest: boolean | null = null;
        let linkType: string | null = null;
        if (link_short_code && typeof link_short_code === "string") {
            const sbUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("VITE_SUPABASE_URL");
            const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SB_SERVICE_ROLE_KEY");
            if (sbUrl && sbKey) {
                const supabase = createClient(sbUrl, sbKey, {
                    auth: { autoRefreshToken: false, persistSession: false },
                });
                const { data: link } = await supabase
                    .from("sendmo_links")
                    .select(`
                        status, link_type, is_test, max_price_cents, preferred_carrier, preferred_speed,
                        length_in, width_in, height_in, weight_hint_oz,
                        recipient_address:addresses!recipient_address_id (
                            name, street1, street2, city, state, zip, country, phone
                        ),
                        origin_address:addresses!origin_address_id (
                            name, street1, street2, city, state, zip, country, phone
                        )
                    `)
                    .eq("short_code", link_short_code)
                    .single();

                if (link && link.status === "active" && link.link_type === "flexible") {
                    // Flex — resolve the recipient's delivery address. The
                    // sender's client only sent city/state (Rule 7). Mirrors labels/.
                    linkType = "flexible";
                    const addr = link.recipient_address as unknown as {
                        name: string; street1: string; street2: string | null;
                        city: string; state: string; zip: string; country: string | null;
                        phone: string | null;
                    } | null;
                    if (!addr?.street1) {
                        // The link was created with an incomplete address (no street).
                        // Return a clear error so the sender sees it immediately rather
                        // than getting a cryptic EasyPost/FedEx rejection.
                        logRateError("link_address_incomplete", "warn", {
                            link_short_code: link_short_code ?? null,
                        });
                        return new Response(
                            JSON.stringify({ error: "This link's delivery address is incomplete — it's missing a street. The person who set up this link needs to update their delivery address before you can ship." }),
                            { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                        );
                    }
                    to_address = {
                        name: addr.name,
                        street1: addr.street1,
                        street2: addr.street2 ?? undefined,
                        city: addr.city,
                        state: addr.state,
                        zip: addr.zip,
                        country: addr.country ?? "US",
                        // Phone required for FedEx/UPS (2026-05-19). Pulled from the
                        // recipient address row so the rate call carries it.
                        phone: addr.phone ?? undefined,
                    };
                    linkIsTest = link.is_test === true;
                } else if (link && link.status === "active" && link.link_type === "seller_link") {
                    // Seller link — the INVERSE of flex: the SELLER's ship-from
                    // origin + package + carrier constraints come from the link;
                    // the buyer supplies only their destination (to_address, from
                    // the body). Carrier / speed / cap are read from the link and
                    // enforced SERVER-SIDE (B5); any client-supplied prefs on this
                    // leg are ignored.
                    linkType = "seller_link";
                    const o = link.origin_address as unknown as {
                        name: string; street1: string; street2: string | null;
                        city: string; state: string; zip: string; country: string | null;
                        phone: string | null;
                    } | null;
                    if (!o?.street1) {
                        logRateError("seller_origin_incomplete", "warn", {
                            link_short_code: link_short_code ?? null,
                        });
                        return new Response(
                            JSON.stringify({ error: "This seller link's ship-from address is incomplete. The seller needs to finish setting up the link before you can get a rate." }),
                            { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                        );
                    }
                    from_address = {
                        name: o.name,
                        street1: o.street1,
                        street2: o.street2 ?? undefined,
                        city: o.city,
                        state: o.state,
                        zip: o.zip,
                        country: o.country ?? "US",
                        phone: o.phone ?? undefined,
                    };
                    parcel = {
                        length: Number(link.length_in),
                        width: Number(link.width_in),
                        height: Number(link.height_in),
                        weight_oz: Number(link.weight_hint_oz),
                    };
                    preferred_carrier = link.preferred_carrier ?? undefined;
                    preferred_speed = link.preferred_speed ?? undefined;
                    max_price_cents = typeof link.max_price_cents === "number" ? link.max_price_cents : max_price_cents;
                    linkIsTest = link.is_test === true;
                }
            }
        }

        // Required fields — checked AFTER link resolution (a seller link resolves
        // from_address + parcel from the link above; a flex link resolves to_address).
        if (!from_address || !to_address || !parcel) {
            logRateError("missing_required_fields", "warn", {
                has_from: !!from_address, has_to: !!to_address, has_parcel: !!parcel,
                link_type: linkType,
            });
            return new Response(
                JSON.stringify({ error: "Missing required fields: from_address, to_address, parcel" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Phone is required on BOTH addresses (2026-05-19). The phone is baked
        // into the EasyPost shipment created right here — and the labels /buy
        // call reuses this exact shipment — so this is the one server-side gate
        // before a carrier ever sees the address. FedEx/UPS reject /buy with
        // PHONENUMBEREMPTY otherwise. Validated independently of the client
        // (Rule 5); the links Edge Function POST/PATCH apply the same check via
        // the shared isUsablePhone. See 2026-05-20_phone-required-flow-audit.md
        // finding 1 — `links` had this gate, `rates` did not.
        if (!isUsablePhone(from_address?.phone)) {
            logRateError("from_address_missing_phone", "warn", {
                from_zip: from_address?.zip ?? null,
                link_short_code: link_short_code ?? null,
            });
            return new Response(
                JSON.stringify({ error: "The sender address is missing a phone number — shipping carriers require one to generate a label." }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }
        if (!isUsablePhone(to_address?.phone)) {
            // On a FLEX link the to_address was resolved from the link's stored
            // delivery address — so a missing phone is the link owner's to fix.
            // On a SELLER link the to_address is the BUYER's own address, and for
            // non-link callers it's the caller's — both get the generic wording.
            const linkCase = linkType === "flexible";
            const msg = linkCase
                ? "This shipping link's delivery address doesn't have a phone number, which the carriers require. The person who created this link needs to add one (from their SendMo dashboard) before you can ship."
                : "The delivery address is missing a phone number — shipping carriers require one to generate a label.";
            logRateError("to_address_missing_phone", "warn", {
                from_zip: from_address?.zip ?? null,
                to_zip: to_address?.zip ?? null,
                link_short_code: link_short_code ?? null,
            });
            return new Response(
                JSON.stringify({ error: msg }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const isLive = linkIsTest !== null ? !linkIsTest : live_mode === true;
        const apiKey = Deno.env.get(isLive ? "EASYPOST_API_KEY" : "EASYPOST_TEST_API_KEY");
        if (!apiKey) {
            logRateError("easypost_key_missing", "error", { live_mode: isLive });
            return new Response(
                JSON.stringify({ error: `EasyPost ${isLive ? 'Live' : 'Test'} API key not configured` }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const authHeader = "Basic " + btoa(apiKey + ":");

        // Build address objects — include name/company/phone when provided
        // (required by EasyPost for label purchase on some carriers like USPS)
        const buildAddress = (addr: Record<string, string>) => ({
            name: addr.name || "Recipient",
            company: addr.company || addr.name || "Recipient",  // carriers require company
            phone: addr.phone || undefined,
            street1: addr.street1,
            street2: addr.street2 || undefined,
            city: addr.city,
            state: addr.state,
            zip: addr.zip,
            country: addr.country || "US",
        });

        const builtFrom = buildAddress(from_address);
        const builtTo = buildAddress(to_address);
        console.log(`[Session ${sessionId}] [rates] from:`, JSON.stringify(builtFrom));
        console.log(`[Session ${sessionId}] [rates] to:`, JSON.stringify(builtTo));
        console.log(`[Session ${sessionId}] [rates] parcel:`, JSON.stringify(parcel));

        // Create shipment to get rates
        const start = Date.now();
        const shipmentResponse = await fetch(
            "https://api.easypost.com/v2/shipments",
            {
                method: "POST",
                headers: {
                    Authorization: authHeader,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    shipment: {
                        from_address: builtFrom,
                        to_address: builtTo,
                        parcel: {
                            length: parcel.length,
                            width: parcel.width,
                            height: parcel.height,
                            weight: parcel.weight_oz,
                        },
                    },
                }),
            }
        );

        const shipmentData = await shipmentResponse.json();
        const elapsed = Date.now() - start;

        if (!shipmentResponse.ok || shipmentData.error) {
            const errorMsg = shipmentData.error?.message || "Failed to get shipping rates";
            console.error(`[Session ${sessionId}] [rates] EasyPost shipment error:`, JSON.stringify(shipmentData.error));

            log({
                event_type: "rate.error",
                session_id: sessionId,
                severity: "error",
                entity_type: "rate",
                duration_ms: elapsed,
                properties: {
                    error_message: errorMsg,
                    easypost_code: shipmentData.error?.code ?? null,
                    from_zip: from_address?.zip ?? null,
                    to_zip: to_address?.zip ?? null,
                    parcel_weight_oz: parcel?.weight_oz ?? null,
                    parcel_length: parcel?.length ?? null,
                    parcel_width: parcel?.width ?? null,
                    parcel_height: parcel?.height ?? null,
                },
            });

            return new Response(
                JSON.stringify({ error: errorMsg }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // EasyPost populates shipment.messages[] with carrier-level rejection reasons
        // when it can't generate rates (e.g. unrecognized address, weight limits, etc.)
        const epMessages: string[] = (shipmentData.messages || []).map(
            (m: Record<string, string>) => `[${m.carrier}] ${m.message}`
        );
        if (epMessages.length > 0) {
            console.warn(`[Session ${sessionId}] [rates] carrier messages:`, JSON.stringify(epMessages));
        }

        // ── Speed tier classification ──
        function classifySpeed(days: number | null): string {
            if (days === null) return "standard";
            if (days <= 3) return "express";
            if (days <= 5) return "standard";
            return "economy";
        }

        // ── Recipient preference price cap (converts cents → dollars) ──
        const effectivePriceCap = typeof max_price_cents === "number"
            ? max_price_cents / 100
            : MAX_DISPLAY_PRICE;

        // Apply markup, filter, and sort
        const rates = (shipmentData.rates || [])
            .map((rate: Record<string, unknown>) => {
                const basePrice = parseFloat(rate.rate as string);
                const displayPrice = Math.round(basePrice * MARKUP_MULTIPLIER * 100 + MARKUP_FLAT_CENTS) / 100;
                const days = (rate.est_delivery_days || rate.delivery_days || null) as number | null;
                return {
                    carrier: rate.carrier as string,
                    service: rate.service as string,
                    display_price: displayPrice,
                    delivery_days: days,
                    speed_tier: classifySpeed(days),
                    easypost_shipment_id: shipmentData.id,
                    easypost_rate_id: rate.id,
                };
            })
            .filter((r: { display_price: number; carrier: string; service: string; speed_tier: string }) => {
                // Service denylist (top of file) — exclude services with
                // known systematic buy-time rate drift. Telemetry: emit a
                // rate.service_denylisted event for each filtered rate so we
                // can count how many quotes the denylist suppressed (and at
                // what would-have-been price) — this is the data the
                // denylist re-enable path is keyed on.
                const carrierLower = r.carrier.toLowerCase();
                const serviceUpper = r.service.toUpperCase();
                if (SERVICE_DENYLIST.some(d => d.carrier === carrierLower && d.service === serviceUpper)) {
                    log({
                        event_type: "rate.service_denylisted",
                        session_id: sessionId,
                        severity: "info",
                        entity_type: "rate",
                        properties: {
                            carrier: r.carrier,
                            service: r.service,
                            would_have_been_display_price: r.display_price,
                            speed_tier: r.speed_tier,
                        },
                    });
                    return false;
                }

                // Hard cap — never show rates above the absolute max
                if (r.display_price > MAX_DISPLAY_PRICE) return false;

                // Recipient preference: price cap
                if (r.display_price > effectivePriceCap) return false;

                // Recipient preference: carrier filter
                if (preferred_carrier && preferred_carrier !== "any") {
                    if (r.carrier.toLowerCase() !== preferred_carrier.toLowerCase()) return false;
                }

                // Recipient preference: speed tier filter
                if (preferred_speed) {
                    const speedRank: Record<string, number> = { economy: 0, standard: 1, express: 2 };
                    const rateRank = speedRank[r.speed_tier] ?? 1;
                    const prefRank = speedRank[preferred_speed] ?? 1;
                    // Show rates at the preferred speed or faster
                    if (rateRank < prefRank) return false;
                }

                return true;
            })
            .sort((a: { display_price: number }, b: { display_price: number }) => a.display_price - b.display_price);

        console.log(`[Session ${sessionId}] [rates] returning ${rates.length} rates, ${epMessages.length} carrier messages`);

        // Log: rate fetch result
        if (rates.length === 0) {
            log({
                event_type: "rate.no_results",
                session_id: sessionId,
                severity: "warn",
                entity_type: "rate",
                entity_id: shipmentData.id ?? null,
                duration_ms: elapsed,
                properties: {
                    easypost_shipment_id: shipmentData.id ?? null,
                    carrier_messages: epMessages,
                    from_zip: from_address?.zip ?? null,
                    to_zip: to_address?.zip ?? null,
                    parcel_weight_oz: parcel?.weight_oz ?? null,
                },
            });
        } else {
            log({
                event_type: "rate.fetched",
                session_id: sessionId,
                severity: "info",
                entity_type: "rate",
                entity_id: shipmentData.id ?? null,
                duration_ms: elapsed,
                properties: {
                    easypost_shipment_id: shipmentData.id ?? null,
                    rate_count: rates.length,
                    carrier_messages: epMessages.length > 0 ? epMessages : undefined,
                    from_zip: from_address?.zip ?? null,
                    to_zip: to_address?.zip ?? null,
                    // Log parcel dims alongside weight — FedEx Smart Post is
                    // dim-weight-sensitive and silent dim-mismatch is the most
                    // likely cause of quote-vs-billed gaps (see GC37EXG case).
                    parcel_weight_oz: parcel?.weight_oz ?? null,
                    parcel_length: parcel?.length ?? null,
                    parcel_width: parcel?.width ?? null,
                    parcel_height: parcel?.height ?? null,
                    cheapest_rate: rates[0]?.display_price ?? null,
                    carriers_returned: [...new Set(rates.map((r: { carrier: unknown }) => r.carrier))],
                },
            });
        }

        return new Response(
            JSON.stringify({
                rates,
                // Surface carrier messages so the UI can explain "no rates available"
                messages: epMessages.length > 0 ? epMessages : undefined,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    } catch (err) {
        console.error(`[Session ${sessionId}] Rates error:`, err);
        logRateError("unhandled_exception", "error", {
            error_message: err instanceof Error ? err.message : String(err),
        });
        return new Response(
            JSON.stringify({ error: "Internal server error" }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});
