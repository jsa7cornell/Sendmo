import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { isUsablePhone } from "../_shared/phone.ts";
import { resolveLiveMode } from "../_shared/mode.ts";
import { checkLiveChargeAllowed } from "../_shared/allowlist.ts";
import { log } from "../_shared/logger.ts";

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
    // Parse path segments to detect path-based routes (vs query-param GET).
    // /functions/v1/links            → no extra segments (existing query-param flow)
    // /functions/v1/links/<id>       → GET single link by id (Pattern D polling)
    // /functions/v1/links/<id>/rotate → POST rotate the short_code
    const pathSegments = url.pathname.split("/").filter(Boolean);
    const linksIdx = pathSegments.indexOf("links");
    const pathLinkId = linksIdx >= 0 && pathSegments.length > linksIdx + 1
        ? pathSegments[linksIdx + 1]
        : null;
    const pathAction = linksIdx >= 0 && pathSegments.length > linksIdx + 2
        ? pathSegments[linksIdx + 2]
        : null;

    // ── GET /links/:id — Authenticated: single link status (Pattern D polling) ──
    if (req.method === "GET" && pathLinkId && !pathAction) {
        const authHeader = req.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) {
            return new Response(
                JSON.stringify({ error: "Unauthorized" }),
                { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }
        const { data: link, error: linkErr } = await supabase
            .from("sendmo_links")
            .select("id, short_code, link_type, status, user_id, is_test, max_price_cents")
            .eq("id", pathLinkId)
            .eq("user_id", user.id)
            .maybeSingle();
        if (linkErr || !link) {
            return new Response(
                JSON.stringify({ error: "Link not found" }),
                { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }
        return new Response(
            JSON.stringify({
                id: link.id,
                short_code: link.short_code,
                link_type: link.link_type,
                status: link.status,
                max_price_cents: link.max_price_cents,
                is_test: link.is_test,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    // ── POST /links/:id/rotate — Authenticated: rotate short_code (Pattern D) ──
    if (req.method === "POST" && pathLinkId && pathAction === "rotate") {
        const authHeader = req.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) {
            return new Response(
                JSON.stringify({ error: "Unauthorized" }),
                { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }
        // Ownership + existence
        const { data: existing, error: existingErr } = await supabase
            .from("sendmo_links")
            .select("id, user_id, short_code, link_type, status")
            .eq("id", pathLinkId)
            .eq("user_id", user.id)
            .maybeSingle();
        if (existingErr || !existing) {
            return new Response(
                JSON.stringify({ error: "Link not found" }),
                { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }
        if (existing.link_type !== "flexible") {
            return new Response(
                JSON.stringify({ error: "Only flexible links can be rotated" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }
        if (existing.status === "cancelled" || existing.status === "expired") {
            return new Response(
                JSON.stringify({ error: "Cannot rotate a cancelled or expired link" }),
                { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }
        // Generate new short_code with collision retry (matches POST /links pattern)
        let newShortCode = "";
        for (let retries = 0; retries < 3; retries++) {
            const candidate = generateShortCode();
            const { error: codeError } = await supabase
                .from("sendmo_links")
                .select("id")
                .eq("short_code", candidate)
                .single();
            if (codeError) {
                newShortCode = candidate;
                break;
            }
        }
        if (!newShortCode) {
            return new Response(
                JSON.stringify({ error: "Failed to generate unique short_code; try again" }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }
        // Rotate order: INSERT NEW FIRST, then cancel old. If insert fails,
        // the old link stays usable — no window where the recipient has
        // neither link active. No grace window on the old code; it returns
        // 410 immediately after the cancel UPDATE. Proposal §6 "URL rotation
        // grace window — none, by design."
        //
        // We enumerate the explicit allow-list of columns to copy instead of
        // SELECT *, so future schema additions don't accidentally get carried
        // forward (e.g., cancelled_at timestamps, EasyPost shipment IDs,
        // unique-constrained generated columns).
        const { data: oldRow, error: oldRowErr } = await supabase
            .from("sendmo_links")
            .select(
                "user_id, link_type, recipient_address_id, max_price_cents, " +
                "preferred_speed, preferred_carrier, size_hint, weight_hint_oz, " +
                "notes, expires_at, is_test"
            )
            .eq("id", existing.id)
            .single();
        if (oldRowErr || !oldRow) {
            return new Response(
                JSON.stringify({ error: "Failed to read old link before rotate" }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }
        const insertRow = {
            user_id: oldRow.user_id,
            link_type: oldRow.link_type,
            recipient_address_id: oldRow.recipient_address_id,
            max_price_cents: oldRow.max_price_cents,
            preferred_speed: oldRow.preferred_speed,
            preferred_carrier: oldRow.preferred_carrier,
            size_hint: oldRow.size_hint,
            weight_hint_oz: oldRow.weight_hint_oz,
            notes: oldRow.notes,
            expires_at: oldRow.expires_at,
            is_test: oldRow.is_test,
            short_code: newShortCode,
            status: existing.status === "draft" ? "draft" : "active",
        };
        const { data: newRow, error: insertErr } = await supabase
            .from("sendmo_links")
            .insert(insertRow)
            .select("id, short_code")
            .single();
        if (insertErr || !newRow) {
            return new Response(
                JSON.stringify({ error: "Failed to create rotated link" }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }
        // New row exists; now cancel the old one. If THIS fails (vanishingly
        // rare for a simple status UPDATE), we have two active links pointing
        // at the same recipient — annoying but not broken. The recipient
        // can rotate again or cancel manually.
        const { error: cancelErr } = await supabase
            .from("sendmo_links")
            .update({ status: "cancelled" })
            .eq("id", existing.id);
        if (cancelErr) {
            console.error("[links] rotate cancel of old link failed:", cancelErr);
            // Don't fail the request — the new link works. Surface as audit only.
        }
        // Audit row
        await supabase.from("link_state_events").insert({
            link_id: newRow.id,
            event: "rotated",
            reason: `replaces ${existing.short_code}`,
            actor_user: user.id,
            metadata: { old_link_id: existing.id, old_short_code: existing.short_code },
        });
        await supabase.from("link_state_events").insert({
            link_id: existing.id,
            event: "cancelled_by_user",
            reason: "rotated_to_new_short_code",
            actor_user: user.id,
            metadata: { new_link_id: newRow.id, new_short_code: newRow.short_code },
        });
        return new Response(
            JSON.stringify({
                id: newRow.id,
                short_code: newRow.short_code,
                url: `https://sendmo.co/s/${newRow.short_code}`,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    // ── POST /links/:id/activate — Authenticated: flip draft → active using
    // the user's existing default PM (no Stripe call needed; the PM is already
    // attached server-side from a prior SetupIntent). Used by FlexPaymentStep
    // when a returning user clicks "Activate link with my saved card". Mirrors
    // the is_funded logic from POST /links auto-resolve so we never activate a
    // link without a usable PM.
    if (req.method === "POST" && pathLinkId && pathAction === "activate") {
        const authHeader = req.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) {
            return new Response(
                JSON.stringify({ error: "Unauthorized" }),
                { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const { data: existing, error: linkErr } = await supabase
            .from("sendmo_links")
            .select("id, user_id, short_code, link_type, status, is_test")
            .eq("id", pathLinkId)
            .maybeSingle();
        if (linkErr || !existing) {
            return new Response(
                JSON.stringify({ error: "Link not found" }),
                { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }
        if (existing.user_id !== user.id) {
            return new Response(
                JSON.stringify({ error: "Not your link" }),
                { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }
        if (existing.link_type !== "flexible") {
            return new Response(
                JSON.stringify({ error: "Only flexible links use this endpoint" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }
        if (existing.status === "active") {
            // Idempotent — already active, just acknowledge.
            return new Response(
                JSON.stringify({ id: existing.id, short_code: existing.short_code, status: "active" }),
                { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }
        if (existing.status !== "draft") {
            return new Response(
                JSON.stringify({ error: `Cannot activate a ${existing.status} link` }),
                { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Verify the user has a usable default PM in the link's mode.
        const mode = existing.is_test ? "test" : "live";
        const now = new Date();
        const { data: defaultPm } = await supabase
            .from("payment_methods")
            .select("id, exp_year, exp_month")
            .eq("user_id", user.id)
            .eq("mode", mode)
            .eq("is_default", true)
            .is("deleted_at", null)
            .maybeSingle();
        let hasUsablePm = false;
        if (defaultPm) {
            const yr = (defaultPm as { exp_year?: number | null }).exp_year ?? null;
            const mo = (defaultPm as { exp_month?: number | null }).exp_month ?? null;
            if (yr == null || mo == null) hasUsablePm = true;
            else if (yr > now.getFullYear()) hasUsablePm = true;
            else if (yr === now.getFullYear() && mo >= now.getMonth() + 1) hasUsablePm = true;
        }
        if (!hasUsablePm) {
            return new Response(
                JSON.stringify({ error: "No usable saved card found for this mode" }),
                { status: 412, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const { error: updateErr } = await supabase
            .from("sendmo_links")
            .update({ status: "active", updated_at: new Date().toISOString() })
            .eq("id", existing.id)
            .eq("user_id", user.id);
        if (updateErr) {
            console.error("Activate update error:", updateErr);
            return new Response(
                JSON.stringify({ error: "Failed to activate link" }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        await supabase.from("link_state_events").insert({
            link_id: existing.id,
            event: "activated",
            reason: "activated_with_existing_pm",
            actor_user: user.id,
            metadata: { payment_method_id: (defaultPm as { id: string }).id, mode },
        });

        return new Response(
            JSON.stringify({ id: existing.id, short_code: existing.short_code, status: "active" }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

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
                id, short_code, link_type, status, user_id, is_test,
                max_price_cents, preferred_speed, preferred_carrier,
                size_hint, weight_hint_oz, notes, expires_at,
                created_at,
                recipient_address:addresses!recipient_address_id (
                    name, street1, city, state, zip
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

        // Full-label links are intentionally created with status='used' because
        // the label was already bought server-side at link creation. The /s/<code>
        // resolver treats these as viewer links — it looks up the shipment's
        // public_code and the client redirects to /t/<public_code>.
        // Pattern D (Phase F): the legacy 'used' check for flex links is
        // removed. Flex links stay 'active' indefinitely — see proposal
        // 2026-05-16_flex-payment-pattern-d-execution. Legacy 'in_use' rows
        // are backfilled to 'active' by migration 024.

        if (link.expires_at && new Date(link.expires_at) < new Date()) {
            // Auto-expire
            await supabase.from("sendmo_links").update({ status: "expired" }).eq("id", link.id);
            return new Response(
                JSON.stringify({ error: "This link has expired", status: "expired" }),
                { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // For full_label viewer links, look up the bound shipment's public_code
        // so the client can redirect to /t/<public_code>.
        let publicCode: string | null = null;
        if (link.link_type === "full_label") {
            const { data: ship } = await supabase
                .from("shipments")
                .select("public_code")
                .eq("link_id", link.id)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();
            publicCode = ship?.public_code ?? null;
        }

        // Pattern D (Phase F): for flex links, compute is_funded from DB
        // state only — no Stripe call. The lightweight front gate. The
        // actual source of truth is the per-shipment off_session charge in
        // labels/index.ts. Computed: link is alive AND recipient has a
        // default PaymentMethod in this mode whose stored expiry hasn't
        // passed.
        let isFunded = false;
        if (link.link_type === "flexible") {
            const linkMode = link.is_test === false ? "live" : "test";
            const now = new Date();
            const { data: defaultPm } = await supabase
                .from("payment_methods")
                .select("exp_year, exp_month")
                .eq("user_id", link.user_id)
                .eq("mode", linkMode)
                .eq("is_default", true)
                .is("deleted_at", null)
                .maybeSingle();
            if (defaultPm) {
                const yr = (defaultPm as { exp_year?: number | null }).exp_year ?? null;
                const mo = (defaultPm as { exp_month?: number | null }).exp_month ?? null;
                if (yr == null || mo == null) {
                    // ACH or other PM with no expiry — treat as funded
                    isFunded = true;
                } else if (yr > now.getFullYear()) {
                    isFunded = true;
                } else if (yr === now.getFullYear() && mo >= now.getMonth() + 1) {
                    isFunded = true;
                }
            }
        } else {
            // Non-flex links (full-label viewer) — always treated as funded
            // for response shape consistency.
            isFunded = true;
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
                // Tells the sender flow whether the full address is on file.
                // False → show an error immediately rather than failing at label creation.
                recipient_address_complete: !!(link.recipient_address as unknown as { street1?: string } | null)?.street1,
                // Pattern D (Phase F): false → sender flow shows the "this
                // link isn't accepting payments right now" message up front
                // instead of letting the user reach Review & Confirm.
                is_funded: isFunded,
                public_code: publicCode,
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
            // Optional: 'draft' for onboarding flex flow (link awaits a saved
            // PM before becoming visible to senders). 'active' creates ready.
            // 'auto' (Pattern D follow-up) inspects the user's default PM in
            // the link's mode and picks draft/active accordingly — used by the
            // dashboard +New Link flow so a returning user with a saved card
            // skips the inline SetupIntent. Webhooks own all other transitions.
            initial_status,
        } = body;

        // ─── Link mode derivation (T1-1 gate D, review B3) ──────
        // is_test is derived from the creator's identity via resolveLiveMode
        // — no longer left to the column default (TRUE). Admin in live_comp
        // keeps is_test=true (isLive is false; comp labels use the live
        // EasyPost key via the labels comp leg, matching the historical
        // admin-comp pattern — PAYMENTS.md §13.1). Only live_charge (admin)
        // or customer-with-SENDMO_LIVE_DEFAULT produce is_test=false.
        const { data: creatorProfile } = await supabase
            .from("profiles")
            .select("role, admin_active_mode")
            .eq("id", user.id)
            .maybeSingle();
        const creatorRole = (creatorProfile?.role as string) ?? null;
        const creatorMode = resolveLiveMode({
            callerRole: creatorRole,
            callerAdminMode: (creatorProfile?.admin_active_mode as string) ?? null,
            isAuthenticated: true,
        });
        // Closed-beta allowlist gate (security follow-up 2026-07-05, defense in
        // depth): don't even MINT a live link for a non-allowlisted customer
        // under the invite-only lever — downgrade to a test link so the flex
        // charge hole never opens upstream. The labels flex leg enforces the
        // same gate at charge time; this just avoids a live link that would
        // only 403 later. Admins are unaffected (their live charges are gated
        // separately at the charge sites).
        let linkIsTest = !creatorMode.isLive;
        if (!linkIsTest && creatorRole !== "admin") {
            const gate = checkLiveChargeAllowed("customer", user.id);
            if (!gate.allowed) {
                linkIsTest = true;
                log({
                    event_type: "link.live_downgraded_not_allowlisted",
                    severity: "info",
                    entity_type: "sendmo_link",
                    entity_id: user.id,
                    properties: { user_id: user.id, reason: gate.reason },
                });
            }
        }

        let startStatus: "draft" | "active";
        if (initial_status === "draft") {
            startStatus = "draft";
        } else if (initial_status === "auto") {
            // Mirror the is_funded logic in GET /links?code= : look up the
            // user's default PM in the LINK's derived mode (was hardcoded
            // "test" when is_test always came from the column default —
            // review B3) with un-expired stored expiry.
            const now = new Date();
            const { data: defaultPm } = await supabase
                .from("payment_methods")
                .select("exp_year, exp_month")
                .eq("user_id", user.id)
                .eq("mode", linkIsTest ? "test" : "live")
                .eq("is_default", true)
                .is("deleted_at", null)
                .maybeSingle();
            let hasUsablePm = false;
            if (defaultPm) {
                const yr = (defaultPm as { exp_year?: number | null }).exp_year ?? null;
                const mo = (defaultPm as { exp_month?: number | null }).exp_month ?? null;
                if (yr == null || mo == null) hasUsablePm = true;
                else if (yr > now.getFullYear()) hasUsablePm = true;
                else if (yr === now.getFullYear() && mo >= now.getMonth() + 1) hasUsablePm = true;
            }
            startStatus = hasUsablePm ? "active" : "draft";
        } else {
            startStatus = "active";
        }

        // Validate required fields. Phone is required as of 2026-05-19 — FedEx
        // and UPS reject label purchases without it (PHONENUMBEREMPTY). Server
        // enforces independently of the client form (Rule 5 — client-side
        // validation is UX only). 10-digit minimum after stripping non-digits.
        if (!recipient_address?.street1 || !recipient_address?.city || !recipient_address?.state || !recipient_address?.zip) {
            return new Response(
                JSON.stringify({ error: "Missing required recipient address fields" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }
        if (!isUsablePhone(recipient_address?.phone)) {
            return new Response(
                JSON.stringify({ error: "We need a phone number for the delivery address — the shipping carriers require one to make the delivery." }),
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
                phone: recipient_address.phone,
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
                status: startStatus,
                // Explicit — the column default (TRUE) no longer decides (T1-1 gate D).
                is_test: linkIsTest,
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
                status: startStatus,
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
                    id, name, street1, street2, city, state, zip, phone
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
            const phone = typeof addr.phone === "string" ? addr.phone : "";

            if (!street1 || !city || !state || !zip) {
                return new Response(
                    JSON.stringify({ error: "Missing required recipient address fields" }),
                    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }
            // Phone required only when recipient_address is in the PATCH payload
            // (editing the address). Edits that don't touch the address — price
            // cap, speed, etc. — skip this block entirely and aren't gated.
            if (!isUsablePhone(phone)) {
                return new Response(
                    JSON.stringify({ error: "We need a phone number for the delivery address — the shipping carriers require one to make the delivery." }),
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
                && norm(cur.zip) === norm(zip)
                && norm((cur as { phone?: string }).phone ?? "") === norm(phone);

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
                        phone,
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
