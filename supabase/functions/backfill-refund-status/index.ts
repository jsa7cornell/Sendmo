import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { requireAdmin } from "../_shared/auth.ts";

// ─────────────────────────────────────────────────────────────────────────────
// backfill-refund-status — admin-only one-shot EasyPost reconciliation pull.
//
// Cancelled shipments voided BEFORE the easypost_refund_status writers shipped
// (migration 030 + the 2026-05-21 cancel-label/tracking/webhooks deploy) have
// shipments.easypost_refund_status = NULL — SendMo has no record of whether
// EasyPost actually credited the voided label cost back to its wallet.
//
// This endpoint finds every cancelled shipment with a NULL
// easypost_refund_status, GETs the shipment from EasyPost (the carrier-side
// ground truth), and copies EasyPost's `refund_status` verbatim into the
// column. Idempotent — a re-run only touches still-NULL rows. Safe to leave
// deployed as a manual "reconcile cancelled shipments" trigger.
//
// Admin-only: requireAdmin validates the caller's JWT + profiles.role='admin'.
// ─────────────────────────────────────────────────────────────────────────────

const EP_REFUND_STATUSES = ["submitted", "refunded", "rejected", "not_applicable"];

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Auth: admin only ─────────────────────────────────────────
  let supabase;
  try {
    ({ supabase } = await requireAdmin(req, corsHeaders));
  } catch (r) {
    if (r instanceof Response) return r;
    throw r;
  }

  // ── Cancelled shipments missing the EasyPost-side refund ground truth ──
  const { data: rows, error } = await supabase
    .from("shipments")
    .select("id, public_code, easypost_shipment_id, is_test")
    .eq("status", "cancelled")
    .is("easypost_refund_status", null)
    .not("easypost_shipment_id", "is", null);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const results: Record<string, unknown>[] = [];
  let updated = 0;

  for (const s of rows ?? []) {
    // is_test drives which EasyPost key — but a cancelled shipment is always
    // live (test labels can't be voided); the branch is kept for safety.
    const apiKey = Deno.env.get(s.is_test ? "EASYPOST_TEST_API_KEY" : "EASYPOST_API_KEY");
    if (!apiKey) {
      results.push({ public_code: s.public_code, error: "EasyPost API key not configured" });
      continue;
    }
    try {
      const resp = await fetch(
        `https://api.easypost.com/v2/shipments/${s.easypost_shipment_id}`,
        { headers: { Authorization: "Basic " + btoa(apiKey + ":") } },
      );
      const ep = await resp.json();
      const eprs: string | null = ep?.refund_status ?? null;

      if (eprs && EP_REFUND_STATUSES.includes(eprs)) {
        const { error: upErr } = await supabase
          .from("shipments")
          .update({ easypost_refund_status: eprs })
          .eq("id", s.id);
        if (upErr) {
          results.push({ public_code: s.public_code, error: upErr.message });
        } else {
          updated++;
          results.push({ public_code: s.public_code, easypost_refund_status: eprs });
        }
      } else {
        results.push({
          public_code: s.public_code,
          easypost_refund_status: eprs,
          note: "EasyPost returned no recognized refund_status — left NULL",
        });
      }
    } catch (e) {
      results.push({
        public_code: s.public_code,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return new Response(
    JSON.stringify({ checked: rows?.length ?? 0, updated, results }, null, 2),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
