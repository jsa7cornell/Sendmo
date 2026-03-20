import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

// ─── Short code generator ───────────────────────────────────
const SAFE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
function generateShortCode(): string {
    const arr = new Uint8Array(10);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => SAFE_CHARS[b % SAFE_CHARS.length]).join("");
}

serve(async (req: Request) => {
    const corsResponse = handleCors(req);
    if (corsResponse) return corsResponse;

    const url = new URL(req.url);
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // ── GET /links?code=XXXXXXXXXX — Public: fetch link by short code ──
    if (req.method === "GET") {
        const code = url.searchParams.get("code");
        if (!code) {
            return new Response(
                JSON.stringify({ error: "Missing ?code= parameter" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const { data: link, error } = await supabase
            .from("sendmo_links")
            .select(`
                id, short_code, link_type, status,
                max_price_cents, preferred_speed, preferred_carrier,
                size_hint, weight_hint_oz, notes, expires_at,
                created_at,
                recipient_address:addresses!recipient_address_id (
                    name, city, state, zip
                )
            `)
            .eq("short_code", code)
            .single();

        if (error || !link) {
            return new Response(
                JSON.stringify({ error: "Link not found" }),
                { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Check link is usable
        if (link.status === "cancelled" || link.status === "expired") {
            return new Response(
                JSON.stringify({ error: "This link is no longer active", status: link.status }),
                { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        if (link.status === "used") {
            return new Response(
                JSON.stringify({ error: "This link has already been used", status: link.status }),
                { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        if (link.expires_at && new Date(link.expires_at) < new Date()) {
            // Auto-expire
            await supabase.from("sendmo_links").update({ status: "expired" }).eq("id", link.id);
            return new Response(
                JSON.stringify({ error: "This link has expired", status: "expired" }),
                { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Return link data — never expose full recipient address to sender
        return new Response(
            JSON.stringify({
                id: link.id,
                short_code: link.short_code,
                link_type: link.link_type,
                status: link.status,
                max_price_cents: link.max_price_cents,
                preferred_speed: link.preferred_speed,
                preferred_carrier: link.preferred_carrier,
                size_hint: link.size_hint,
                notes: link.notes,
                recipient_city: link.recipient_address?.city ?? null,
                recipient_state: link.recipient_address?.state ?? null,
                recipient_zip: link.recipient_address?.zip ?? null,
                recipient_name: link.recipient_address?.name ?? null,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    // ── POST /links — Authenticated: create a flexible link ──
    if (req.method === "POST") {
        // Verify JWT
        const authHeader = req.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");

        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) {
            return new Response(
                JSON.stringify({ error: "Unauthorized" }),
                { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const body = await req.json();
        const {
            recipient_address,
            speed_preference,
            preferred_carrier,
            price_cap_dollars,
            size_hint,
            distance_hint,
            notes,
        } = body;

        // Validate required fields
        if (!recipient_address?.street1 || !recipient_address?.city || !recipient_address?.state || !recipient_address?.zip) {
            return new Response(
                JSON.stringify({ error: "Missing required recipient address fields" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // 1. Upsert recipient address
        const { data: address, error: addrError } = await supabase
            .from("addresses")
            .insert({
                user_id: user.id,
                name: recipient_address.name || "Recipient",
                street1: recipient_address.street1,
                street2: recipient_address.street2 || null,
                city: recipient_address.city,
                state: recipient_address.state,
                zip: recipient_address.zip,
                country: "US",
                is_verified: recipient_address.verified || false,
            })
            .select("id")
            .single();

        if (addrError || !address) {
            console.error("Address insert error:", addrError);
            return new Response(
                JSON.stringify({ error: "Failed to save recipient address" }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // 2. Generate short code with retry on collision
        let shortCode = "";
        let retries = 0;
        while (retries < 3) {
            const candidate = generateShortCode();
            const { error: codeError } = await supabase
                .from("sendmo_links")
                .select("id")
                .eq("short_code", candidate)
                .single();

            // If .single() returns an error, the code doesn't exist → it's unique
            if (codeError) {
                shortCode = candidate;
                break;
            }
            retries++;
        }

        if (!shortCode) {
            return new Response(
                JSON.stringify({ error: "Failed to generate unique link code" }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // 3. Create the link
        const priceCap = typeof price_cap_dollars === "number" ? price_cap_dollars : 100;
        const { data: link, error: linkError } = await supabase
            .from("sendmo_links")
            .insert({
                user_id: user.id,
                short_code: shortCode,
                link_type: "flexible",
                status: "active",
                recipient_address_id: address.id,
                max_price_cents: Math.round(priceCap * 100),
                preferred_speed: speed_preference || null,
                preferred_carrier: preferred_carrier === "any" ? null : (preferred_carrier || null),
                size_hint: size_hint || null,
                notes: notes || null,
            })
            .select("id, short_code")
            .single();

        if (linkError || !link) {
            console.error("Link insert error:", linkError);
            return new Response(
                JSON.stringify({ error: "Failed to create link" }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        return new Response(
            JSON.stringify({
                id: link.id,
                short_code: link.short_code,
                url: `https://sendmo.co/s/${link.short_code}`,
            }),
            { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
});
