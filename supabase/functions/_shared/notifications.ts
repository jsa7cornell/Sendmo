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
import { trackingUpdateEmail, labelConfirmationEmail, senderLabelReadyEmail } from "./email-templates.ts";
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
  // Seller-link sale: the label_created + tracking copy is reframed so the BUYER
  // (who PAID, mapped to the `sender` contact) gets "purchase confirmed — the
  // seller ships your item — track/cancel" instead of the flex "you shipped this,
  // no charge" copy, and the SELLER (the `recipient`/payer-role contact) gets
  // "you made a sale — print your label". Seller links set is_flex=true for the
  // routing (payer = recipient contact); is_seller_link only changes the COPY.
  is_seller_link?: boolean;
  sender_name?: string | null;       // "From" row on the label-created email
  item_description?: string | null;  // "Item" row
  display_price_cents?: number | null; // "Amount" row
  // Per-shipment cancel token (hex). Rides the flex SENDER "label ready" email
  // ONLY (senderLabelReadyEmail builds `/t/<code>?cancel=<token>` so a
  // returning sender can cancel/change). NEVER threaded into the payer/owner
  // copy — the owner cancels via their JWT and must not get a live cancel
  // credential in their inbox. Restores 2026-05-12 label-cancel-and-change §3.2.
  cancel_token?: string | null;
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
    // label_created has TWO renders on flex: the payer/owner gets the
    // "your label is ready" payer copy; the SENDER (who ships) gets the
    // tokenized "you shipped this" copy with the cancel link. Full-label has
    // only the payer render (there is no separate sender). The dispatch filter
    // below decides WHICH contacts receive label_created; here we pick the copy.
    const isSenderCreation = eventType === LABEL_CREATED_EVENT
      && ctx.is_flex === true && contact.role === "sender";
    const template = isSenderCreation
      ? senderLabelReadyEmail({
          publicCode: ctx.public_code,
          carrierTracking: ctx.tracking_number || "Pending",
          carrier: ctx.carrier || "Standard",
          eta: ctx.estimated_delivery || "Estimated upon pickup",
          trackingUrl: ctx.tracking_url,
          cancelToken: ctx.cancel_token || "",
          itemDescription: ctx.item_description ?? null,
          // Seller-link buyer render: "purchase confirmed" copy + the amount they
          // paid, instead of the flex "no charge to you" copy.
          sellerLink: ctx.is_seller_link === true,
          amountCents: ctx.display_price_cents ?? null,
        })
      : eventType === LABEL_CREATED_EVENT
      ? labelConfirmationEmail({
          publicCode: ctx.public_code,
          carrierTracking: ctx.tracking_number || "Pending",
          carrier: ctx.carrier || "Standard",
          eta: ctx.estimated_delivery || "Estimated upon pickup",
          trackingUrl: ctx.tracking_url,
          senderName: ctx.sender_name ?? null,
          itemDescription: ctx.item_description ?? null,
          displayPriceCents: ctx.display_price_cents ?? null,
          // Seller-link SELLER render: "you made a sale — print your label".
          variant: ctx.is_seller_link ? "seller_link" : ctx.is_flex ? "flex" : "full_label",
        })
      : trackingUpdateEmail(
          eventType,
          ctx.public_code,
          ctx.tracking_number,
          ctx.carrier,
          ctx.estimated_delivery,
          ctx.tracking_url,
          contact.role,
          ctx.is_seller_link === true,
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

    // label_created routing (decided 2026-07-06 flex-sender-visibility,
    // restoring 2026-05-12 label-cancel-and-change §3.2):
    //   • payer — always. Full-label payer is the `sender` contact; flex payer
    //     (the link owner who prepaid) is the `recipient` contact.
    //   • flex SENDER — also gets a creation email (the tokenized
    //     senderLabelReadyEmail; template picked in the channel handler), but
    //     ONLY when the cancel token is present: without it the email's
    //     manage/cancel CTA would be a broken `?cancel=` link, so we skip and
    //     log rather than send a dead credential (degraded path).
    //   • everyone else (full-label recipient) — no creation email; their
    //     first touchpoint stays the in_transit tracking email.
    const payerRole = ctx.is_flex ? "recipient" : "sender";
    const senderCreationEligible = ctx.is_flex === true && !!ctx.cancel_token;

    // Send to each contact in parallel
    const promises = contacts.map(async (contact: Contact) => {
      if (eventType === LABEL_CREATED_EVENT && contact.role !== payerRole) {
        const isFlexSender = ctx.is_flex === true && contact.role === "sender";
        if (!isFlexSender) {
          return; // not the payer and not a flex sender — no creation email
        }
        if (!senderCreationEligible) {
          log({
            event_type: "notification.sender_creation_skipped_no_token",
            severity: "warn",
            entity_type: "shipment",
            entity_id: shipmentId,
            properties: { contact_role: contact.role },
          });
          return;
        }
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
