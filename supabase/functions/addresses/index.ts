import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

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
        const { street1, street2, city, state, zip, country } = await req.json();

        if (!street1 || !city || !state || !zip) {
            return new Response(
                JSON.stringify({ verified: false, error: "Missing required fields: street1, city, state, zip" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const apiKey = Deno.env.get("EASYPOST_TEST_API_KEY");
        if (!apiKey) {
            return new Response(
                JSON.stringify({ verified: false, error: "EasyPost API key not configured" }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const authHeader = "Basic " + btoa(apiKey + ":");

        const easypostResponse = await fetch(
            "https://api.easypost.com/v2/addresses/create_and_verify",
            {
                method: "POST",
                headers: {
                    Authorization: authHeader,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    address: {
                        street1,
                        street2: street2 || "",
                        city,
                        state,
                        zip,
                        country: country || "US",
                    },
                }),
            }
        );

        const data = await easypostResponse.json();

        if (!easypostResponse.ok || data.error) {
            const errorMsg =
                data.error?.message ||
                data.address?.verifications?.delivery?.errors?.[0]?.message ||
                "Address verification failed";
            return new Response(
                JSON.stringify({ verified: false, error: errorMsg }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const addr = data.address || data;
        const verifications = addr.verifications?.delivery;

        if (verifications && !verifications.success) {
            const errMsg =
                verifications.errors?.[0]?.message || "Address could not be verified";
            return new Response(
                JSON.stringify({ verified: false, error: errMsg }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        return new Response(
            JSON.stringify({
                verified: true,
                normalizedAddress: {
                    street1: addr.street1,
                    street2: addr.street2 || "",
                    city: addr.city,
                    state: addr.state,
                    zip: addr.zip,
                    country: addr.country,
                },
                easypost_id: addr.id,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    } catch (err) {
        console.error("Address verification error:", err);
        return new Response(
            JSON.stringify({ verified: false, error: "Internal server error" }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});
