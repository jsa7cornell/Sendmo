import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

/**
 * Autocomplete edge function — proxies Google Places API (New).
 * Uses GOOGLE_PLACES_KEY (the unrestricted key) for Places API access.
 *
 * POST { input: string }
 * Returns { predictions: [{ description, place_id, main_text, secondary_text }] }
 */
serve(async (req: Request) => {
    const corsResponse = handleCors(req);
    if (corsResponse) return corsResponse;

    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    try {
        const { input } = await req.json();

        if (!input || input.trim().length < 2) {
            return new Response(JSON.stringify({ predictions: [] }), {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        const apiKey = Deno.env.get("GOOGLE_PLACES_KEY");
        if (!apiKey) {
            return new Response(JSON.stringify({ error: "Google Places API key not configured", predictions: [] }), {
                status: 500,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // ── Places API (New) — Autocomplete ──────────────────────
        const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Goog-Api-Key": apiKey,
            },
            body: JSON.stringify({
                input: input.trim(),
                includedRegionCodes: ["us"],
                includedPrimaryTypes: ["street_address", "premise"],
            }),
        });

        const data = await res.json();

        if (!res.ok) {
            console.error("Places API error:", JSON.stringify(data));
            return new Response(JSON.stringify({ predictions: [], error: data?.error?.message }), {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        const suggestions = data.suggestions || [];
        const predictions = suggestions
            .filter((s: { placePrediction?: unknown }) => s.placePrediction)
            .map((s: {
                placePrediction: {
                    text?: { text: string };
                    placeId?: string;
                    structuredFormat?: {
                        mainText?: { text: string };
                        secondaryText?: { text: string };
                    };
                };
            }) => {
                const p = s.placePrediction;
                return {
                    description: p.text?.text || "",
                    place_id: p.placeId || "",
                    main_text: p.structuredFormat?.mainText?.text || "",
                    secondary_text: p.structuredFormat?.secondaryText?.text || "",
                };
            });

        return new Response(JSON.stringify({ predictions }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

    } catch (err) {
        console.error("Autocomplete error:", err);
        return new Response(JSON.stringify({ error: "Internal server error", predictions: [] }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
});
