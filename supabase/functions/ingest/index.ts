/**
 * SendMo — ingest Edge Function
 *
 * Internal-only structured event logging endpoint.
 * Called by other Edge Functions via the shared logger helper.
 *
 * POST /functions/v1/ingest
 * Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
 * Content-Type: application/json
 *
 * Body: LogEvent | LogEvent[]
 *
 * Always returns 200 — logging must never break callers.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

interface LogEvent {
    event_type: string;
    session_id?: string | null;
    actor_id?: string | null;
    entity_type?: string | null;
    entity_id?: string | null;
    severity?: string;
    source?: string;
    duration_ms?: number | null;
    properties?: Record<string, unknown>;
}

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

    // Always return 200 — logging must never disrupt callers
    try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL");
        const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
            Deno.env.get("SB_SERVICE_ROLE_KEY");

        if (!supabaseUrl || !serviceRoleKey) {
            console.error("[ingest] Missing SUPABASE_URL or service role key");
            return new Response(JSON.stringify({ ok: false, error: "config_error" }), {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        const supabase = createClient(supabaseUrl, serviceRoleKey);

        const body = await req.json();

        // Accept single event or array of events
        const events: LogEvent[] = Array.isArray(body) ? body : [body];

        if (events.length === 0) {
            return new Response(JSON.stringify({ ok: true, inserted: 0 }), {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // Sanitize and build rows
        const rows = events.map((e) => ({
            event_type: String(e.event_type || "unknown").slice(0, 100),
            session_id: e.session_id ? String(e.session_id).slice(0, 200) : null,
            actor_id: isValidUuid(e.actor_id) ? e.actor_id : null,
            entity_type: e.entity_type ? String(e.entity_type).slice(0, 50) : null,
            entity_id: e.entity_id ? String(e.entity_id).slice(0, 200) : null,
            severity: ["info", "warn", "error"].includes(e.severity ?? "")
                ? e.severity
                : "info",
            source: ["edge_fn", "webhook", "frontend"].includes(e.source ?? "")
                ? e.source
                : "edge_fn",
            duration_ms: typeof e.duration_ms === "number" ? Math.round(e.duration_ms) : null,
            properties: e.properties && typeof e.properties === "object" ? e.properties : {},
        }));

        const { error } = await supabase.from("event_logs").insert(rows);

        if (error) {
            console.error("[ingest] DB insert failed:", error.message);
            // Still return 200 — caller must not be blocked
            return new Response(
                JSON.stringify({ ok: false, error: error.message }),
                { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        return new Response(
            JSON.stringify({ ok: true, inserted: rows.length }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    } catch (err) {
        // Catch-all: log to console, return 200
        console.error("[ingest] Unexpected error:", err instanceof Error ? err.message : err);
        return new Response(
            JSON.stringify({ ok: false, error: "unexpected_error" }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});

function isValidUuid(value: unknown): value is string {
    if (typeof value !== "string") return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
