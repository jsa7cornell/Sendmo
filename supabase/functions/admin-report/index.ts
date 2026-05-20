import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAdmin } from "../_shared/auth.ts";

// GET /admin-report
//
// Stripe Phase A (migration 017) rewrite — the legacy payments table is gone.
// Margin math now derives from the transactions ledger:
//
//   collected_cents     = SUM(amount_cents) WHERE type='charge'      AND shipment_id = ?
//   refunded_cents      = SUM(amount_cents) WHERE type='refund'      AND shipment_id = ?   (negative)
//   comp_cost_cents     = SUM(amount_cents) WHERE type='comp_grant'  AND shipment_id = ?   (negative)
//
// Margin per shipment = collected_cents − rate_cents + refunded_cents + comp_cost_cents
//   - For a normal paid shipment: collected − cost.
//   - For a refunded shipment:    collected − cost + refunded  (refunded is negative, so margin shrinks).
//   - For a comp shipment:        comp_cost (negative — SendMo absorbed EasyPost cost).
//
// Default filter: mode='live'. Test charges never pollute the live view.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // Admin auth. requireAdmin throws a Response on failure (401/403/500).
    let supabase;
    try {
      ({ supabase } = await requireAdmin(req, corsHeaders));
    } catch (r) {
      if (r instanceof Response) return r;
      throw r;
    }

    // Query string toggle for mode. Default 'live'; '?mode=test' or '?mode=all'.
    const url = new URL(req.url);
    const modeParam = url.searchParams.get("mode") ?? "live";

    const { data, error } = await supabase
      .from("sendmo_links")
      .select(`
                id,
                short_code,
                link_type,
                status,
                created_at,
                is_test,
                profiles ( email ),
                shipments (
                    id,
                    easypost_shipment_id,
                    carrier,
                    service,
                    tracking_number,
                    label_url,
                    rate_cents,
                    status,
                    is_test,
                    is_live,
                    payment_method,
                    refund_status,
                    refund_submitted_at,
                    cancelled_at,
                    created_at,
                    transactions ( amount_cents, type, funding_source, mode, stripe_intent_id ),
                    sender_address:sender_address_id ( name, street1, city, state, zip ),
                    recipient_address:recipient_address_id ( name, street1, city, state, zip )
                )
            `)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Admin report query error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Filter transactions by mode (live/test/all). PostgREST returns the full
    // join; we filter client-side here so 'all' is just no filter.
    type Tx = { amount_cents: number; type: string; funding_source: string | null; mode: string; stripe_intent_id: string | null };
    type Shipment = { transactions?: Tx[] | null };
    type Link = { shipments?: Shipment[] | null };
    if (modeParam === "live" || modeParam === "test") {
      for (const link of (data as Link[] | null) ?? []) {
        for (const sh of link.shipments ?? []) {
          sh.transactions = (sh.transactions ?? []).filter((t) => t.mode === modeParam);
        }
      }
    }

    return new Response(JSON.stringify({ data, mode: modeParam }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    console.error("Admin report error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
