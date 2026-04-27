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

    // ── PATCH /links/:id — Authenticated: edit a flexible link ──
    if (req.method === "PATCH") {
        const authHeader = req.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");

        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) {
            return new Response(
                JSON.stringify({ error: "Unauthorized" }),
                { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Parse :id from /functions/v1/links/<id>
        const pathParts = url.pathname.split("/").filter(Boolean);
        const linkId = pathParts[pathParts.length - 1];
        if (!linkId || linkId === "links") {
            return new Response(
                JSON.stringify({ error: "Missing link id in URL" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        let payload: Record<string, unknown>;
        try {
            payload = await req.json();
        } catch {
            return new Response(
                JSON.stringify({ error: "Invalid JSON body" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        if (!payload || typeof payload !== "object" || Object.keys(payload).length === 0) {
            return new Response(
                JSON.stringify({ error: "Empty payload — nothing to update" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Ownership check (service role bypasses RLS — explicit user_id filter required)
        const { data: existing, error: loadError } = await supabase
            .from("sendmo_links")
            .select(`
                id, user_id, status, recipient_address_id,
                recipient_address:addresses!recipient_address_id (
                    id, name, street1, street2, city, state, zip
                )
            `)
            .eq("id", linkId)
            .eq("user_id", user.id)
            .maybeSingle();

        if (loadError) {
            console.error("Link load error:", loadError);
            return new Response(
                JSON.stringify({ error: "Failed to load link" }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        if (!existing) {
            // Don't leak existence — same response for not-found and not-owned
            return new Response(
                JSON.stringify({ error: "Link not found" }),
                { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Status guard — only active/draft are editable
        if (existing.status !== "active" && existing.status !== "draft") {
            return new Response(
                JSON.stringify({ error: "This link is no longer editable", status: existing.status }),
                { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Build the update — whitelist of mutable fields
        const updates: Record<string, unknown> = {};
        const changedFields: string[] = [];

        if ("speed_preference" in payload) {
            updates.preferred_speed = payload.speed_preference || null;
            changedFields.push("speed_preference");
        }
        if ("preferred_carrier" in payload) {
            updates.preferred_carrier = payload.preferred_carrier === "any" ? null : (payload.preferred_carrier || null);
            changedFields.push("preferred_carrier");
        }
        if ("price_cap_dollars" in payload) {
            const cap = payload.price_cap_dollars;
            if (typeof cap !== "number" || cap <= 0) {
                return new Response(
                    JSON.stringify({ error: "price_cap_dollars must be a positive number" }),
                    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }
            updates.max_price_cents = Math.round(cap * 100);
            changedFields.push("price_cap_dollars");
        }
        if ("size_hint" in payload) {
            updates.size_hint = payload.size_hint || null;
            changedFields.push("size_hint");
        }
        if ("notes" in payload) {
            updates.notes = payload.notes ?? null;
            changedFields.push("notes");
        }

        // Address handling — insert-new-row + repoint-FK pattern (preserves shipment history)
        let previousAddressId: string | null = null;
        let newAddressId: string | null = null;

        if ("recipient_address" in payload && payload.recipient_address) {
            const addr = payload.recipient_address as Record<string, unknown>;
            const street1 = typeof addr.street1 === "string" ? addr.street1 : "";
            const city = typeof addr.city === "string" ? addr.city : "";
            const state = typeof addr.state === "string" ? addr.state : "";
            const zip = typeof addr.zip === "string" ? addr.zip : "";

            if (!street1 || !city || !state || !zip) {
                return new Response(
                    JSON.stringify({ error: "Missing required recipient address fields" }),
                    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }

            // Equality check — case-insensitive, trimmed
            const norm = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");
            const cur = Array.isArray(existing.recipient_address)
                ? existing.recipient_address[0]
                : existing.recipient_address;
            const unchanged = cur
                && norm(cur.street1) === norm(street1)
                && norm(cur.street2 ?? "") === norm(addr.street2 ?? "")
                && norm(cur.city) === norm(city)
                && norm(cur.state) === norm(state)
                && norm(cur.zip) === norm(zip);

            if (!unchanged) {
                const { data: newAddr, error: addrError } = await supabase
                    .from("addresses")
                    .insert({
                        user_id: user.id,
                        name: (addr.name as string) || "Recipient",
                        street1,
                        street2: (addr.street2 as string) || null,
                        city,
                        state,
                        zip,
                        country: "US",
                        is_verified: addr.verified === true,
                    })
                    .select("id")
                    .single();

                if (addrError || !newAddr) {
                    console.error("Address insert error:", addrError);
                    return new Response(
                        JSON.stringify({ error: "Failed to save updated address" }),
                        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                    );
                }

                previousAddressId = existing.recipient_address_id;
                newAddressId = newAddr.id;
                updates.recipient_address_id = newAddr.id;
                changedFields.push("recipient_address");
            }
        }

        if (Object.keys(updates).length === 0) {
            return new Response(
                JSON.stringify({ error: "No mutable fields supplied" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        updates.updated_at = new Date().toISOString();

        const { data: updated, error: updateError } = await supabase
            .from("sendmo_links")
            .update(updates)
            .eq("id", linkId)
            .eq("user_id", user.id)
            .select(`
                id, short_code, updated_at,
                max_price_cents, preferred_speed, preferred_carrier, size_hint,
                recipient_address:addresses!recipient_address_id (
                    name, city, state, zip
                )
            `)
            .single();

        if (updateError || !updated) {
            console.error("Link update error:", updateError);
            return new Response(
                JSON.stringify({ error: "Failed to update link" }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Audit log — best-effort, don't fail the request if logging fails
        try {
            await supabase.from("event_logs").insert({
                event_type: "link.updated",
                entity_type: "sendmo_link",
                entity_id: linkId,
                user_id: user.id,
                properties: {
                    changed_fields: changedFields,
                    previous_address_id: previousAddressId,
                    new_address_id: newAddressId,
                },
            });
        } catch (logErr) {
            console.warn("Audit log failed:", logErr);
        }

        const respAddr = Array.isArray(updated.recipient_address)
            ? updated.recipient_address[0]
            : updated.recipient_address;

        return new Response(
            JSON.stringify({
                id: updated.id,
                short_code: updated.short_code,
                updated_at: updated.updated_at,
                recipient_address: respAddr ? {
                    name: respAddr.name,
                    city: respAddr.city,
                    state: respAddr.state,
                    zip: respAddr.zip,
                } : null,
                speed_preference: updated.preferred_speed,
                preferred_carrier: updated.preferred_carrier,
                max_price_cents: updated.max_price_cents,
                size_hint: updated.size_hint,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
});
