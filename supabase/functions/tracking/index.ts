import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { dispatchNotifications } from "../_shared/notifications.ts";

const APP_URL = "https://sendmo.co";
const NOTIFY_STATUSES = new Set(["in_transit", "out_for_delivery", "delivered"]);

/**
 * Public tracking lookup — no auth required.
 *
 *   GET /tracking?code=H7K2P9        ← canonical (SendMo public_code, UNIQUE)
 *   GET /tracking?number=<carrier>   ← legacy alias for old `/track/<carrier_number>`
 *                                       URLs already out in users' inboxes. Ordered
 *                                       created_at DESC limit 1 to handle test-mode
 *                                       fixture collisions deterministically (most
 *                                       recent shipment wins — defensible default
 *                                       since users clicking old links care about
 *                                       the most recent shipment with that number).
 *
 * Always fetches live from EasyPost when a tracker exists and the
 * shipment isn't in a terminal state. Syncs DB and dispatches
 * notifications when status advances.
 */

// Statuses that will never change — serve from DB, skip EasyPost
const TERMINAL_STATUSES = new Set(["delivered", "return_to_sender", "cancelled"]);

serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const url = new URL(req.url);
  const publicCode = url.searchParams.get("code");
  const trackingNumber = url.searchParams.get("number");

  if (!publicCode && !trackingNumber) {
    return new Response(
      JSON.stringify({ error: "Either 'code' or 'number' query parameter is required" }),
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

  // Look up shipment in our DB.
  // `public_code` is UNIQUE post-migration 015 → .single() is correct.
  // `tracking_number` legacy path may match multiple rows (EasyPost test-mode
  // fixture collisions); order by created_at DESC and take the first.
  const selectFields = "id, tracking_number, public_code, carrier, service, status, easypost_tracker_id, is_test, created_at, updated_at, promised_delivery_date, delivered_at";
  const baseQuery = supabase.from("shipments").select(selectFields);
  const lookup = publicCode
    ? baseQuery.eq("public_code", publicCode).single()
    : baseQuery.eq("tracking_number", trackingNumber!).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const { data: shipment, error } = await lookup;

  if (error || !shipment) {
    return new Response(
      JSON.stringify({ error: publicCode ? "Tracking code not found" : "Tracking number not found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let liveStatus = shipment.status;
  let estDelivery: string | null = null;
  let trackingEvents: Array<{ message: string; status: string; datetime: string; location: string | null }> = [];

  // Always fetch from EasyPost unless shipment is in a terminal status
  const isTerminal = TERMINAL_STATUSES.has(shipment.status);
  const shouldFetchLive = shipment.easypost_tracker_id && !isTerminal;

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

          // Sync DB: update status + updated_at
          const statusChanged = liveStatus !== shipment.status;
          const updateFields: Record<string, unknown> = {
            updated_at: new Date().toISOString(),
          };
          if (statusChanged) {
            updateFields.status = liveStatus;
          }
          if (liveStatus === "delivered") {
            updateFields.delivered_at = new Date().toISOString();
          }
          // Update by the unambiguous shipment id — never tracking_number,
          // which may collide (EasyPost test-mode fixtures).
          await supabase
            .from("shipments")
            .update(updateFields)
            .eq("id", shipment.id);

          // Dispatch notifications if status advanced (idempotent — safe if webhook also fires)
          if (statusChanged && NOTIFY_STATUSES.has(liveStatus)) {
            const estDeliveryFmt = estDelivery
              ? new Date(estDelivery).toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })
              : undefined;
            dispatchNotifications(supabase, shipment.id, liveStatus, {
              tracking_number: shipment.tracking_number,
              public_code: shipment.public_code,
              carrier: shipment.carrier || "",
              estimated_delivery: estDeliveryFmt,
              tracking_url: `${APP_URL}/t/${shipment.public_code}`,
            });
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
      public_code: shipment.public_code,
      carrier: shipment.carrier,
      service: shipment.service,
      status: liveStatus,
      estimated_delivery: estDelivery,
      events: trackingEvents,
      created_at: shipment.created_at,
      updated_at: shipment.updated_at,
      promised_delivery_date: shipment.promised_delivery_date,
      delivered_at: shipment.delivered_at,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
