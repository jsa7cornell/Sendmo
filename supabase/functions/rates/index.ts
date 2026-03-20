import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";

const MARKUP_MULTIPLIER = 1.15;
const MARKUP_FLAT_CENTS = 100; // $1.00 flat fee on top of the percentage markup
const MAX_DISPLAY_PRICE = 200;

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
        const { from_address, to_address, parcel, live_mode, preferred_carrier, preferred_speed, max_price_cents } = await req.json();

        if (!from_address || !to_address || !parcel) {
            return new Response(
                JSON.stringify({ error: "Missing required fields: from_address, to_address, parcel" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const isLive = live_mode === true;
        const apiKey = Deno.env.get(isLive ? "EASYPOST_API_KEY" : "EASYPOST_TEST_API_KEY");
        if (!apiKey) {
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
            .filter((r: { display_price: number; carrier: string; speed_tier: string }) => {
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
                    parcel_weight_oz: parcel?.weight_oz ?? null,
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
        return new Response(
            JSON.stringify({ error: "Internal server error" }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});
