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
import { trackingUpdateEmail, labelConfirmationEmail } from "./email-templates.ts";
import { log } from "./logger.ts";

// Event type for the one-time label-creation confirmation (payer only).
// Distinct from the tracking-status events (in_transit/out_for_delivery/
// delivered) so dispatch can route it to the payer-role contact alone.
export const LABEL_CREATED_EVENT = "label_created";

export interface NotificationContext {
  tracking_number: string;       // the carrier's number (USPS/UPS/FedEx) — shown as secondary in emails
  public_code: string;           // SendMo's canonical short code — prominent in emails, drives the URL
  carrier: string;
  estimated_delivery?: string;
  tracking_url: string;          // built as `${APP_URL}/t/${public_code}` by callers
  // ── label_created only ───────────────────────────────────────────────
  // Which flow produced the label, so the creation email picks payer-facing
  // copy AND so dispatch routes it to the right role: full-label payer is the
  // `sender` contact; flex payer (the link owner) is the `recipient` contact.
  is_flex?: boolean;
  sender_name?: string | null;       // "From" row on the label-created email
  item_description?: string | null;  // "Item" row
  display_price_cents?: number | null; // "Amount" row
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
    const template = eventType === LABEL_CREATED_EVENT
      ? labelConfirmationEmail({
          publicCode: ctx.public_code,
          carrierTracking: ctx.tracking_number || "Pending",
          carrier: ctx.carrier || "Standard",
          eta: ctx.estimated_delivery || "Estimated upon pickup",
          trackingUrl: ctx.tracking_url,
          senderName: ctx.sender_name ?? null,
          itemDescription: ctx.item_description ?? null,
          displayPriceCents: ctx.display_price_cents ?? null,
          variant: ctx.is_flex ? "flex" : "full_label",
        })
      : trackingUpdateEmail(
          eventType,
          ctx.public_code,
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

    // label_created is payer-only. The recipient (and, in flex, the link user)
    // hear about the package via the tracking events, not at creation. The
    // payer is the `sender` contact for full-label and the `recipient` contact
    // for flex (the link owner who prepaid) — see NotificationContext.is_flex.
    const payerRole = ctx.is_flex ? "recipient" : "sender";

    // Send to each contact in parallel
    const promises = contacts.map(async (contact: Contact) => {
      if (eventType === LABEL_CREATED_EVENT && contact.role !== payerRole) {
        return; // not the payer — no creation email
      }
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
