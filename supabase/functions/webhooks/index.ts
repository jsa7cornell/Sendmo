import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { dispatchNotifications } from "../_shared/notifications.ts";

/**
 * Webhook handler for EasyPost tracker updates.
 * POST /webhooks — EasyPost sends tracker.updated events here.
 *
 * Updates shipment status in DB and dispatches notifications to all
 * registered contacts (sender + recipient) via the notification system.
 */

const STATUS_MAP: Record<string, string> = {
  in_transit: "in_transit",
  out_for_delivery: "in_transit",
  delivered: "delivered",
  return_to_sender: "returned",
};

// EasyPost statuses that trigger notifications
const NOTIFY_STATUSES = new Set(["in_transit", "out_for_delivery", "delivered"]);

const APP_URL = "https://sendmo.co";

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SB_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Missing Supabase config");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Always respond 200 to webhooks to prevent retries
  try {
    const body = await req.json();
    const description = body.description || "";
    const result = body.result || {};

    // Only handle tracker.updated events
    if (description !== "tracker.updated") {
      return new Response(JSON.stringify({ ok: true, skipped: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const trackingCode = result.tracking_code;
    const easypostStatus = result.status;
    const shipmentStatus = STATUS_MAP[easypostStatus];

    if (!trackingCode || !shipmentStatus) {
      log({
        event_type: "webhook.easypost_unknown_status",
        severity: "warn",
        source: "webhook",
        properties: { tracking_code: trackingCode, status: easypostStatus },
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = getSupabase();

    // Find shipment by tracking number
    const { data: shipment, error: fetchErr } = await supabase
      .from("shipments")
      .select("id, status, tracking_number, carrier")
      .eq("tracking_number", trackingCode)
      .limit(1)
      .single();

    if (fetchErr || !shipment) {
      log({
        event_type: "webhook.easypost_shipment_not_found",
        severity: "warn",
        source: "webhook",
        properties: { tracking_code: trackingCode },
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Idempotency: store webhook event
    const eventId = body.id || `ep_${trackingCode}_${easypostStatus}_${Date.now()}`;
    const { error: dupeErr } = await supabase.from("webhook_events").insert({
      provider: "easypost",
      event_id: eventId,
      event_type: `tracker.${easypostStatus}`,
      payload: body,
    });

    if (dupeErr?.code === "23505") {
      return new Response(JSON.stringify({ ok: true, duplicate: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Update shipment status
    const updateFields: Record<string, unknown> = { status: shipmentStatus };
    if (shipmentStatus === "delivered") {
      updateFields.delivered_at = new Date().toISOString();
    }

    await supabase.from("shipments").update(updateFields).eq("id", shipment.id);

    log({
      event_type: "webhook.easypost_status_updated",
      severity: "info",
      source: "webhook",
      entity_type: "shipment",
      entity_id: shipment.id,
      properties: {
        tracking_code: trackingCode,
        old_status: shipment.status,
        new_status: shipmentStatus,
        easypost_status: easypostStatus,
      },
    });

    // Dispatch notifications to all contacts (fire-and-forget)
    if (NOTIFY_STATUSES.has(easypostStatus)) {
      // Extract estimated delivery from EasyPost tracker data
      const estDelivery = result.est_delivery_date
        ? new Date(result.est_delivery_date).toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
          })
        : undefined;

      // Don't await — fire and forget
      dispatchNotifications(supabase, shipment.id, easypostStatus, {
        tracking_number: trackingCode,
        carrier: shipment.carrier || "",
        estimated_delivery: estDelivery,
        tracking_url: `${APP_URL}/track/${trackingCode}`,
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Webhook processing error:", err);
    log({
      event_type: "webhook.processing_error",
      severity: "error",
      source: "webhook",
      properties: { error_message: err instanceof Error ? err.message : String(err) },
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
