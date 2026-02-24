import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

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
        const body = await req.json();

        const apiKey = Deno.env.get("EASYPOST_TEST_API_KEY");
        if (!apiKey) {
            return new Response(
                JSON.stringify({ error: "EasyPost API key not configured" }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const authHeader = "Basic " + btoa(apiKey + ":");

        async function verifyOne(addr: Record<string, string>) {
            const res = await fetch("https://api.easypost.com/v2/addresses/create_and_verify", {
                method: "POST",
                headers: { Authorization: authHeader, "Content-Type": "application/json" },
                body: JSON.stringify({ address: addr }),
            });
            const data = await res.json();

            if (!res.ok || data.error) {
                const msg =
                    data.error?.message ||
                    data.address?.verifications?.delivery?.errors?.[0]?.message ||
                    "Address verification failed";
                throw new Error(msg);
            }

            const a = data.address || data;
            const verifications = a.verifications?.delivery;
            if (verifications && !verifications.success) {
                throw new Error(verifications.errors?.[0]?.message || "Address could not be verified");
            }

            return {
                id: a.id,
                street1: a.street1,
                street2: a.street2 || "",
                city: a.city,
                state: a.state,
                zip: a.zip,
                country: a.country,
            };
        }

        // Dual-address mode: { from: {...}, to: {...} }
        if (body.from && body.to) {
            const [fromResult, toResult] = await Promise.all([
                verifyOne(body.from),
                verifyOne(body.to),
            ]);
            return new Response(
                JSON.stringify({
                    from_id: fromResult.id,
                    to_id: toResult.id,
                    from_address: fromResult,
                    to_address: toResult,
                }),
                { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Single-address mode: { street1, city, state, zip, ... }
        const { street1, street2, city, state, zip, country } = body;
        if (!street1 || !city || !state || !zip) {
            return new Response(
                JSON.stringify({ error: "Missing required fields: street1, city, state, zip" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const result = await verifyOne({ street1, street2: street2 || "", city, state, zip, country: country || "US" });
        return new Response(
            JSON.stringify({ verified: true, normalizedAddress: result, easypost_id: result.id }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );

    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal server error";
        console.error("Address verification error:", msg);
        return new Response(
            JSON.stringify({ error: msg }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});
