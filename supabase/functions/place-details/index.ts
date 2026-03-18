import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

// Returns structured address components (including postal_code) for a given
// Google place_id. This is called when the user selects from the autocomplete
// dropdown so we always get a reliable ZIP code.

serve(async (req: Request) => {
    const corsResponse = handleCors(req);
    if (corsResponse) return corsResponse;

    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    const apiKey = Deno.env.get("GOOGLE_ADDRESS_VALIDATION_KEY") || Deno.env.get("VITE_GOOGLE_MAPS_API_KEY");
    if (!apiKey) {
        return new Response(JSON.stringify({ error: "Google API key not configured" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    const { place_id } = await req.json();
    if (!place_id) {
        return new Response(JSON.stringify({ error: "place_id is required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    const fields = "address_components,formatted_address";
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(place_id)}&fields=${fields}&key=${apiKey}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== "OK" || !data.result) {
        console.error("[place-details] Google error:", data.status, data.error_message);
        return new Response(
            JSON.stringify({ error: data.error_message || `Google Places error: ${data.status}` }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    // Parse address_components into usable fields
    const components: Record<string, string> = {};
    for (const comp of data.result.address_components || []) {
        for (const type of comp.types as string[]) {
            components[type] = comp.short_name;
        }
    }

    const street_number = components["street_number"] || "";
    const route = components["route"] || "";
    const street1 = [street_number, route].filter(Boolean).join(" ").trim();

    return new Response(
        JSON.stringify({
            street: street1,
            city: components["locality"] || components["sublocality"] || components["postal_town"] || "",
            state: components["administrative_area_level_1"] || "",
            zip: components["postal_code"] || "",
            formatted_address: data.result.formatted_address || "",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
});
