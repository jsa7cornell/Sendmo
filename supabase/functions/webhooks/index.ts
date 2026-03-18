import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { sendEmail } from "../_shared/resend.ts";
import { trackingUpdateEmail } from "../_shared/email-templates.ts";

/**
 * Webhook handler for EasyPost tracker updates.
 * POST /webhooks — EasyPost sends tracker.updated events here.
 *
 * Updates shipment status in DB and sends tracking email notifications.
 */

const STATUS_MAP: Record<string, string> = {
  in_transit: "in_transit",
  out_for_delivery: "in_transit",
  delivered: "delivered",
  return_to_sender: "returned",
};

// Statuses that trigger email notifications
const EMAIL_STATUSES = new Set(["in_transit", "out_for_delivery", "delivered"]);

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

    // EasyPost webhook structure: { description, result: { ... } }
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
      .select("id, status, tracking_number, carrier, user_id, profiles!inner(email)")
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
      // Duplicate event — already processed
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

    // Send tracking email notification (fire-and-forget)
    if (EMAIL_STATUSES.has(easypostStatus)) {
      const recipientEmail = (shipment as any).profiles?.email;
      if (recipientEmail) {
        const template = trackingUpdateEmail(easypostStatus, trackingCode);
        sendEmail({
          to: recipientEmail,
          subject: template.subject,
          html: template.html,
        })
          .then(({ id }) => {
            log({
              event_type: "email.tracking_sent",
              severity: "info",
              source: "webhook",
              entity_type: "shipment",
              entity_id: shipment.id,
              properties: { resend_id: id, status: easypostStatus },
            });
          })
          .catch((err) => {
            console.error("Failed to send tracking email:", err);
            log({
              event_type: "email.tracking_send_error",
              severity: "error",
              source: "webhook",
              entity_type: "shipment",
              entity_id: shipment.id,
              properties: { error_message: err instanceof Error ? err.message : String(err) },
            });
          });
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    // Always 200 for webhooks — log the error but don't trigger retries
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
