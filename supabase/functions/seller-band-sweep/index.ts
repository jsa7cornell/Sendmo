// seller-band-sweep — refresh stale seller-link price bands.
//
// PR10 of the seller-link launch (Round-2 amendment): the band is refreshed
// on CRON, never on the anonymous GET — the OG middleware calls that GET on
// every /s/ page view, so a lazy recompute would hand social crawlers a
// three-EasyPost-call trigger. Registered by migration 049 (daily 05:30 UTC,
// vault-sourced service-role auth, migration-036 idiom).
//
// Scope per run: ACTIVE seller links whose band is missing or older than
// BAND_TTL_DAYS, oldest first, capped at SWEEP_LIMIT (3 EasyPost quote calls
// each — the cap bounds a worst-case backlog; the sweep catches up across
// days). A closed/sold listing needs no fresh band.

import { createClient } from "jsr:@supabase/supabase-js@2.97.0";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { computeSellerPriceBand } from "../_shared/price-band.ts";

const BAND_TTL_DAYS = 14;
const SWEEP_LIMIT = 50;

Deno.serve(async (req: Request) => {
    const corsResponse = handleCors(req);
    if (corsResponse) return corsResponse;
    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    const sbUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("VITE_SUPABASE_URL");
    const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SB_SERVICE_ROLE_KEY");
    // Cron-only: the job posts with the vault-held service-role key. Anything
    // else — anon key included — is refused.
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!sbUrl || !sbKey || bearer !== sbKey) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
    const supabase = createClient(sbUrl, sbKey, { auth: { autoRefreshToken: false, persistSession: false } });

    const cutoff = new Date(Date.now() - BAND_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data: stale, error: staleErr } = await supabase
        .from("sendmo_links")
        .select(`
            id, short_code, is_test, length_in, width_in, height_in, weight_hint_oz, est_computed_at,
            origin_address:addresses!origin_address_id ( street1, city, state, zip )
        `)
        .eq("link_type", "seller_link")
        .eq("status", "active")
        .or(`est_computed_at.is.null,est_computed_at.lt.${cutoff}`)
        .order("est_computed_at", { ascending: true, nullsFirst: true })
        .limit(SWEEP_LIMIT);
    if (staleErr) {
        return new Response(JSON.stringify({ error: staleErr.message }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    let refreshed = 0;
    let failed = 0;
    for (const link of stale ?? []) {
        const origin = (Array.isArray(link.origin_address) ? link.origin_address[0] : link.origin_address) as
            { street1?: string | null; city?: string; state?: string; zip?: string } | null;
        const apiKey = Deno.env.get(link.is_test === false ? "EASYPOST_API_KEY" : "EASYPOST_TEST_API_KEY");
        if (!apiKey || !origin?.city || !origin.state || !origin.zip ||
            !link.length_in || !link.width_in || !link.height_in || !link.weight_hint_oz) {
            failed++;
            continue;
        }
        const band = await computeSellerPriceBand({
            apiKey,
            origin: { city: origin.city, state: origin.state, zip: origin.zip, street1: origin.street1 ?? null },
            parcel: {
                length: Number(link.length_in),
                width: Number(link.width_in),
                height: Number(link.height_in),
                weight_oz: Number(link.weight_hint_oz),
            },
            reference: link.id,
        });
        if (!band) {
            failed++;
            continue;
        }
        const { error: upErr } = await supabase
            .from("sendmo_links")
            .update({
                est_min_cents: band.minCents,
                est_max_cents: band.maxCents,
                est_computed_at: new Date().toISOString(),
            })
            .eq("id", link.id);
        if (upErr) failed++;
        else refreshed++;
    }

    log({
        event_type: "band_sweep.completed",
        session_id: "cron",
        severity: failed > 0 ? "warn" : "info",
        entity_type: "sendmo_link",
        properties: { scanned: stale?.length ?? 0, refreshed, failed },
    });
    return new Response(JSON.stringify({ scanned: stale?.length ?? 0, refreshed, failed }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
});
