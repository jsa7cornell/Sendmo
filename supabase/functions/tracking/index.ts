import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

/**
 * Public tracking lookup — no auth required.
 * GET /tracking?number=XXXXX
 *
 * Returns shipment status for the tracking page.
 * Only exposes safe, non-PII fields.
 */

serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const url = new URL(req.url);
  const trackingNumber = url.searchParams.get("number");

  if (!trackingNumber) {
    return new Response(
      JSON.stringify({ error: "Tracking number is required" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const sbUrl = Deno.env.get("SUPABASE_URL");
  const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SB_SERVICE_ROLE_KEY");
  if (!sbUrl || !sbKey) {
    return new Response(
      JSON.stringify({ error: "Server configuration error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(sbUrl, sbKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: shipment, error } = await supabase
    .from("shipments")
    .select("tracking_number, carrier, service, status, created_at, updated_at")
    .eq("tracking_number", trackingNumber)
    .limit(1)
    .single();

  if (error || !shipment) {
    return new Response(
      JSON.stringify({ error: "Tracking number not found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Return only safe, non-PII fields
  return new Response(
    JSON.stringify({
      tracking_number: shipment.tracking_number,
      carrier: shipment.carrier,
      service: shipment.service,
      status: shipment.status,
      created_at: shipment.created_at,
      updated_at: shipment.updated_at,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
