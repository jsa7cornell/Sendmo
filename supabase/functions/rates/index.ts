import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

const MARKUP_MULTIPLIER = 1.15;
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

    try {
        const { from_address, to_address, parcel } = await req.json();

        if (!from_address || !to_address || !parcel) {
            return new Response(
                JSON.stringify({ error: "Missing required fields: from_address, to_address, parcel" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const apiKey = Deno.env.get("EASYPOST_TEST_API_KEY");
        if (!apiKey) {
            return new Response(
                JSON.stringify({ error: "EasyPost API key not configured" }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const authHeader = "Basic " + btoa(apiKey + ":");

        // Build address objects — include name/company/phone when provided
        // (required by EasyPost for label purchase on some carriers like USPS)
        const buildAddress = (addr: Record<string, string>) => ({
            name: addr.name || undefined,
            company: addr.company || undefined,
            phone: addr.phone || undefined,
            street1: addr.street1,
            street2: addr.street2 || undefined,
            city: addr.city,
            state: addr.state,
            zip: addr.zip,
            country: addr.country || "US",
        });

        // Create shipment to get rates
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
                        from_address: buildAddress(from_address),
                        to_address: buildAddress(to_address),
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

        if (!shipmentResponse.ok || shipmentData.error) {
            const errorMsg = shipmentData.error?.message || "Failed to get shipping rates";
            return new Response(
                JSON.stringify({ error: errorMsg }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Apply markup, filter, and sort
        const rates = (shipmentData.rates || [])
            .map((rate: Record<string, unknown>) => {
                const basePrice = parseFloat(rate.rate as string);
                const displayPrice = Math.round(basePrice * MARKUP_MULTIPLIER * 100) / 100;
                return {
                    carrier: rate.carrier,
                    service: rate.service,
                    display_price: displayPrice,
                    delivery_days: rate.est_delivery_days || rate.delivery_days || null,
                    easypost_shipment_id: shipmentData.id,
                    easypost_rate_id: rate.id,
                };
            })
            .filter((r: { display_price: number }) => r.display_price <= MAX_DISPLAY_PRICE)
            .sort((a: { display_price: number }, b: { display_price: number }) => a.display_price - b.display_price);

        return new Response(
            JSON.stringify({ rates }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    } catch (err) {
        console.error("Rates error:", err);
        return new Response(
            JSON.stringify({ error: "Internal server error" }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});
