import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

/**
 * Public tracking lookup — no auth required.
 * GET /tracking?number=XXXXX
 *
 * Fetches live status from EasyPost tracker, syncs DB, and returns
 * current status + tracking timeline + estimated delivery.
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

  // Look up shipment in our DB
  const { data: shipment, error } = await supabase
    .from("shipments")
    .select("tracking_number, carrier, service, status, easypost_tracker_id, is_test, created_at, updated_at")
    .eq("tracking_number", trackingNumber)
    .limit(1)
    .single();

  if (error || !shipment) {
    return new Response(
      JSON.stringify({ error: "Tracking number not found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // If we have an EasyPost tracker, fetch live status
  let liveStatus = shipment.status;
  let estDelivery: string | null = null;
  let trackingEvents: Array<{ message: string; status: string; datetime: string; location: string | null }> = [];

  if (shipment.easypost_tracker_id) {
    const apiKey = Deno.env.get(shipment.is_test ? "EASYPOST_TEST_API_KEY" : "EASYPOST_API_KEY");
    if (apiKey) {
      try {
        const epResponse = await fetch(
          `https://api.easypost.com/v2/trackers/${shipment.easypost_tracker_id}`,
          { headers: { Authorization: "Basic " + btoa(apiKey + ":") } },
        );
        if (epResponse.ok) {
          const tracker = await epResponse.json();
          liveStatus = tracker.status === "pre_transit" ? "label_created" : tracker.status;
          estDelivery = tracker.est_delivery_date || null;

          // Extract tracking events (newest first)
          trackingEvents = (tracker.tracking_details || [])
            .map((d: any) => ({
              message: d.message || "",
              status: d.status || "",
              datetime: d.datetime || "",
              location: [d.tracking_location?.city, d.tracking_location?.state]
                .filter(Boolean).join(", ") || null,
            }))
            .reverse();

          // Sync our DB if status changed (fire-and-forget)
          if (liveStatus !== shipment.status) {
            const updateFields: Record<string, unknown> = {
              status: liveStatus,
              updated_at: new Date().toISOString(),
            };
            if (liveStatus === "delivered") {
              updateFields.delivered_at = new Date().toISOString();
            }
            supabase
              .from("shipments")
              .update(updateFields)
              .eq("tracking_number", trackingNumber)
              .then(() => {});
          }
        }
      } catch {
        // EasyPost fetch failed — fall back to DB data
      }
    }
  }

  return new Response(
    JSON.stringify({
      tracking_number: shipment.tracking_number,
      carrier: shipment.carrier,
      service: shipment.service,
      status: liveStatus,
      estimated_delivery: estDelivery,
      events: trackingEvents,
      created_at: shipment.created_at,
      updated_at: shipment.updated_at,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
