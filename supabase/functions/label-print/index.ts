import { createClient } from "jsr:@supabase/supabase-js@2.97.0";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { deriveActor } from "../_shared/actor.ts";
import { checkRateLimit } from "../_shared/ratelimit.ts";

// ─────────────────────────────────────────────────────────────────────────────
// label-print — Phase 2 print logging
// Decided proposal:
//   proposals/2026-05-13_tracking-page-ia-polish_reviewed-2026-05-13_decided-2026-05-13.md
//
// POST /functions/v1/label-print  body: { public_code }
//
// Why this exists:
//   Two viewers can both land on /t/<code>. One prints; the other reloads and
//   asks "did you print it or did I". The user-facing chip shows a count;
//   the audit row carries the full who/where/what so admin/support can
//   resolve disputes when they happen.
//
// Auth: 3-path scheme (JWT → admin/link_owner; X-Cancel-Token → session/email_token;
// else anonymous). Anonymous is allowed — every URL-holder can log a print.
//
// Per N1 (test-mode hygiene): is_test=true shipments do NOT write to
// event_logs. The chip reads print_count from tracking and returns 0 for
// test rows; nothing else changes UX-wise.
//
// Rate limit: 10 req/min per (ip + public_code). Higher than cancel-label's
// 5/min because prints are a more frequent legitimate action (user clicks
// Print, then re-clicks Print to verify, etc.).
// ─────────────────────────────────────────────────────────────────────────────

const RATE_LIMIT = { max: 10, windowMs: 60_000 };

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const sessionId = req.headers.get("x-session-id") || crypto.randomUUID();
  const userAgent = (req.headers.get("user-agent") || "unknown").slice(0, 200);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  try {
    const body = await req.json().catch(() => ({}));
    const { public_code, cancel_token: bodyCancelToken } = body as {
      public_code?: string;
      cancel_token?: string;
    };

    if (!public_code || typeof public_code !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid public_code" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const sbUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("VITE_SUPABASE_URL");
    const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SB_SERVICE_ROLE_KEY");
    if (!sbUrl || !sbKey) {
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const supabase = createClient(sbUrl, sbKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Rate limit before any DB work — protects against a forwarded URL
    // being weaponized to spam the event_logs table.
    if (checkRateLimit(`${ip}:${public_code}`, RATE_LIMIT)) {
      return new Response(
        JSON.stringify({ error: "Too many requests. Try again in a moment." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Look up shipment. No auth required — anonymous viewers can log prints.
    const { data: shipment, error: fetchError } = await supabase
      .from("shipments")
      .select("id, is_test, cancel_token, public_code, sendmo_links!inner(user_id)")
      .eq("public_code", public_code)
      .maybeSingle();

    if (fetchError || !shipment) {
      return new Response(
        JSON.stringify({ error: "Shipment not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // N1 — test-mode shipments skip logging entirely. Returns a successful
    // 0-count so the client's optimistic increment harmlessly resets on
    // first refresh.
    if (shipment.is_test === true) {
      return new Response(
        JSON.stringify({ actor: "anonymous", print_count: 0, skipped: "is_test" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Derive actor via shared helper (decided proposal N6 — single source of
    // truth for the 3-path auth shape across user-facing /t/ endpoints).
    const jwtToken = (req.headers.get("Authorization") || req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || null;
    const headerCancelToken = req.headers.get("X-Cancel-Token") || req.headers.get("x-cancel-token") || null;
    const linkOwnerId = (shipment as { sendmo_links?: { user_id?: string } }).sendmo_links?.user_id ?? null;
    const { actor, callerId } = await deriveActor({
      supabase,
      jwtToken,
      headerCancelToken,
      bodyCancelToken: bodyCancelToken ?? null,
      shipmentCancelToken: shipment.cancel_token ?? null,
      linkOwnerId,
    });

    // Write the audit row directly to event_logs. The shared `log()` helper
    // routes through the `ingest` edge function with fire-and-forget semantics,
    // which would race the COUNT below. We need authoritative state for the
    // chip, so insert here via service role (bypasses RLS).
    const { error: logErr } = await supabase
      .from("event_logs")
      .insert({
        event_type: "label.printed",
        session_id: sessionId,
        actor_id: callerId,
        severity: "info",
        source: "edge_fn",
        entity_type: "shipment",
        entity_id: shipment.id,
        properties: {
          actor,
          user_id: callerId,
          ip,
          user_agent: userAgent,
          public_code: shipment.public_code,
        },
      });
    if (logErr) {
      console.error("label.printed insert error:", logErr);
      // Non-fatal — the print itself succeeded (the user already opened the PDF).
      // Return the pre-insert count so the client doesn't double-count.
    }

    // Count after insert. Counts include the row we just inserted; cheap
    // because of idx_event_logs_entity (migration 003).
    const { count: printCount } = await supabase
      .from("event_logs")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "label.printed")
      .eq("entity_type", "shipment")
      .eq("entity_id", shipment.id);

    return new Response(
      JSON.stringify({
        actor,
        print_count: printCount ?? 0,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    console.error("label-print error:", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
