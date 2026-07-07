import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { checkRateLimit, clientIpKey } from "../_shared/ratelimit.ts";

// PRE-LAUNCH T2-3: public endpoint, proxies a paid Google API.
// Selection-driven (fires once per dropdown pick), so 20/min is generous.
const RATE_LIMIT = { max: 20, windowMs: 60_000 };

// Returns structured address components (including postal_code) for a given
// Google place_id. Called when the user selects from the autocomplete
// dropdown so we always get a reliable ZIP code.
//
// Uses Places API (New) — the legacy /maps/api/place/details endpoint is
// deprecated and disabled for keys provisioned after early 2025.

Deno.serve(async (req: Request) => {
    const corsResponse = handleCors(req);
    if (corsResponse) return corsResponse;

    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    if (checkRateLimit(clientIpKey(req), RATE_LIMIT)) {
        return new Response(JSON.stringify({ error: "Too many requests. Try again in a moment." }), {
            status: 429,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    const apiKey = Deno.env.get("GOOGLE_PLACES_KEY");
    if (!apiKey) {
        return new Response(JSON.stringify({ error: "Google Places API key not configured" }), {
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

    const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(place_id)}`;
    const res = await fetch(url, {
        method: "GET",
        headers: {
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": "addressComponents,formattedAddress",
        },
    });

    const data = await res.json();

    if (!res.ok) {
        console.error("[place-details] Places API (New) error:", res.status, JSON.stringify(data));
        return new Response(
            JSON.stringify({ error: data?.error?.message || `Places API error: ${res.status}` }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    // addressComponents: [{ longText, shortText, types: [...], languageCode }]
    const components: Record<string, { longText: string; shortText: string }> = {};
    for (const comp of data.addressComponents || []) {
        for (const type of (comp.types || []) as string[]) {
            components[type] = { longText: comp.longText || "", shortText: comp.shortText || "" };
        }
    }

    const street_number = components["street_number"]?.longText || "";
    const route = components["route"]?.longText || "";
    const street1 = [street_number, route].filter(Boolean).join(" ").trim();

    // Google's Places API (New) only tags `postal_code` as a discrete component
    // for `street_address`-type places. Some legitimate residential addresses
    // come back as `geocode` or `route` types where postal_code is absent —
    // but the canonical `formattedAddress` ("231 Carlester Dr, Los Gatos, CA
    // 95032, USA") reliably includes the ZIP. Fall back to extracting it.
    let zip = components["postal_code"]?.longText || "";
    if (!zip && data.formattedAddress) {
        const match = String(data.formattedAddress).match(/\b(\d{5})(?:-\d{4})?\b/);
        if (match) zip = match[1];
    }

    return new Response(
        JSON.stringify({
            street: street1,
            city: components["locality"]?.longText
                || components["sublocality"]?.longText
                || components["postal_town"]?.longText
                || "",
            state: components["administrative_area_level_1"]?.shortText || "",
            zip,
            formatted_address: data.formattedAddress || "",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
});
