/**
 * Notification dispatcher for SendMo.
 *
 * Looks up contacts for a shipment, routes to channel handlers (email, SMS, push),
 * and logs every attempt to notifications_log for idempotency and audit.
 *
 * Usage (fire-and-forget):
 *   dispatchNotifications(supabase, shipmentId, "in_transit", { tracking, carrier, eta, trackingUrl });
 */

import { sendEmail } from "./resend.ts";
import { trackingUpdateEmail } from "./email-templates.ts";
import { log } from "./logger.ts";

export interface NotificationContext {
  tracking_number: string;
  carrier: string;
  estimated_delivery?: string;
  tracking_url: string;
}

interface Contact {
  id: string;
  role: "sender" | "recipient";
  channel: string;
  address: string;
}

// Channel handlers — add SMS, push here later
type ChannelHandler = (
  contact: Contact,
  eventType: string,
  ctx: NotificationContext,
) => Promise<{ provider_id: string }>;

const channelHandlers: Record<string, ChannelHandler> = {
  email: async (contact, eventType, ctx) => {
    const template = trackingUpdateEmail(
      eventType,
      ctx.tracking_number,
      ctx.carrier,
      ctx.estimated_delivery,
      ctx.tracking_url,
      contact.role,
    );
    const { id } = await sendEmail({
      to: contact.address,
      subject: template.subject,
      html: template.html,
    });
    return { provider_id: id };
  },
  // sms: async (contact, eventType, ctx) => { /* Twilio integration */ },
  // push: async (contact, eventType, ctx) => { /* Web push / FCM */ },
};

/**
 * Dispatch notifications for a shipment event to all registered contacts.
 * Fire-and-forget: never throws, logs all outcomes.
 */
export async function dispatchNotifications(
  supabase: any,
  shipmentId: string,
  eventType: string,
  ctx: NotificationContext,
): Promise<void> {
  try {
    // Look up all contacts for this shipment
    const { data: contacts, error: fetchErr } = await supabase
      .from("notification_contacts")
      .select("id, role, channel, address")
      .eq("shipment_id", shipmentId);

    if (fetchErr || !contacts || contacts.length === 0) {
      log({
        event_type: "notification.no_contacts",
        severity: "warn",
        entity_type: "shipment",
        entity_id: shipmentId,
        properties: { event: eventType },
      });
      return;
    }

    // Send to each contact in parallel
    const promises = contacts.map(async (contact: Contact) => {
      const handler = channelHandlers[contact.channel];
      if (!handler) {
        // Unknown channel — log and skip
        await supabase.from("notifications_log").insert({
          shipment_id: shipmentId,
          contact_id: contact.id,
          channel: contact.channel,
          event_type: eventType,
          status: "skipped",
          error_message: `No handler for channel: ${contact.channel}`,
        });
        return;
      }

      // Idempotency check: skip if already sent
      const { data: existing } = await supabase
        .from("notifications_log")
        .select("id")
        .eq("shipment_id", shipmentId)
        .eq("contact_id", contact.id)
        .eq("event_type", eventType)
        .eq("status", "sent")
        .limit(1);

      if (existing && existing.length > 0) {
        return; // Already sent — skip silently
      }

      try {
        const { provider_id } = await handler(contact, eventType, ctx);

        await supabase.from("notifications_log").insert({
          shipment_id: shipmentId,
          contact_id: contact.id,
          channel: contact.channel,
          event_type: eventType,
          status: "sent",
          provider_id,
        });

        log({
          event_type: `notification.${contact.channel}_sent`,
          severity: "info",
          entity_type: "shipment",
          entity_id: shipmentId,
          properties: { role: contact.role, event: eventType, provider_id },
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`Notification failed (${contact.channel}/${contact.role}):`, errorMsg);

        await supabase.from("notifications_log").insert({
          shipment_id: shipmentId,
          contact_id: contact.id,
          channel: contact.channel,
          event_type: eventType,
          status: "failed",
          error_message: errorMsg,
        }).catch(() => {}); // Don't fail on log insert failure

        log({
          event_type: `notification.${contact.channel}_failed`,
          severity: "error",
          entity_type: "shipment",
          entity_id: shipmentId,
          properties: { role: contact.role, event: eventType, error_message: errorMsg },
        });
      }
    });

    await Promise.allSettled(promises);
  } catch (err) {
    console.error("Notification dispatch error:", err);
    log({
      event_type: "notification.dispatch_error",
      severity: "error",
      entity_type: "shipment",
      entity_id: shipmentId,
      properties: { error_message: err instanceof Error ? err.message : String(err) },
    });
  }
}
