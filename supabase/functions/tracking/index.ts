import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

/**
 * Public tracking lookup — no auth required.
 * GET /tracking?number=XXXXX
 *
 * Uses a TTL cache strategy to minimize EasyPost API calls:
 * - Terminal statuses (delivered, cancelled, returned) → always serve from DB
 * - Active shipments → fetch from EasyPost only if updated_at is older than CACHE_TTL_MS
 * - Syncs DB when EasyPost reports a status change
 */

// How long to cache active shipment data before re-fetching from EasyPost
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Statuses that will never change — no need to re-fetch
const TERMINAL_STATUSES = new Set(["delivered", "return_to_sender", "cancelled"]);

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

  let liveStatus = shipment.status;
  let estDelivery: string | null = null;
  let trackingEvents: Array<{ message: string; status: string; datetime: string; location: string | null }> = [];

  // Decide whether to fetch from EasyPost
  const isTerminal = TERMINAL_STATUSES.has(shipment.status);
  const age = Date.now() - new Date(shipment.updated_at).getTime();
  const isFresh = age < CACHE_TTL_MS;
  const shouldFetchLive = shipment.easypost_tracker_id && !isTerminal && !isFresh;

  if (shouldFetchLive) {
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

          trackingEvents = (tracker.tracking_details || [])
            .map((d: any) => ({
              message: d.message || "",
              status: d.status || "",
              datetime: d.datetime || "",
              location: [d.tracking_location?.city, d.tracking_location?.state]
                .filter(Boolean).join(", ") || null,
            }))
            .reverse();

          // Sync DB: update status + updated_at (resets the TTL clock)
          const updateFields: Record<string, unknown> = {
            updated_at: new Date().toISOString(),
          };
          if (liveStatus !== shipment.status) {
            updateFields.status = liveStatus;
          }
          if (liveStatus === "delivered") {
            updateFields.delivered_at = new Date().toISOString();
          }
          supabase
            .from("shipments")
            .update(updateFields)
            .eq("tracking_number", trackingNumber)
            .then(() => {});
        }
      } catch {
        // EasyPost fetch failed — fall back to DB data
      }
    }
  } else if (shipment.easypost_tracker_id && isFresh && !isTerminal) {
    // Data is fresh — still fetch from EasyPost for events display only?
    // No: serve from DB to save API calls. Events won't show until next refresh
    // after TTL expires. This is the trade-off for efficiency.
    // TODO: Store cached events in DB when EasyPost webhooks are configured.
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
