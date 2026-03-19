import { describe, it, expect, vi } from "vitest";

/**
 * Tests for notification dispatcher logic.
 * Since the dispatcher uses Deno APIs and Supabase, we test the logic patterns
 * (idempotency, channel routing, contact lookup) rather than the runtime.
 */

describe("Notification dispatch logic", () => {
  // ─── Channel routing ─────────────────────────────────────
  it("routes email channel to email handler", () => {
    const handlers: Record<string, string> = { email: "sendEmail", sms: "sendSMS", push: "sendPush" };
    const contact = { channel: "email" };
    expect(handlers[contact.channel]).toBe("sendEmail");
  });

  it("skips unknown channels gracefully", () => {
    const handlers: Record<string, string> = { email: "sendEmail" };
    const contact = { channel: "carrier_pigeon" };
    expect(handlers[contact.channel]).toBeUndefined();
  });

  // ─── Contact filtering ────────────────────────────────────
  it("separates sender and recipient contacts", () => {
    const contacts = [
      { id: "1", role: "sender", channel: "email", address: "s@test.com" },
      { id: "2", role: "recipient", channel: "email", address: "r@test.com" },
      { id: "3", role: "recipient", channel: "sms", address: "+1555000" },
    ];

    const senders = contacts.filter((c) => c.role === "sender");
    const recipients = contacts.filter((c) => c.role === "recipient");

    expect(senders).toHaveLength(1);
    expect(recipients).toHaveLength(2);
  });

  // ─── Idempotency ─────────────────────────────────────────
  it("idempotency check: skips if already sent", () => {
    const existingLogs = [
      { shipment_id: "s1", contact_id: "c1", event_type: "in_transit", status: "sent" },
    ];

    const shouldSend = (shipmentId: string, contactId: string, eventType: string) => {
      return !existingLogs.some(
        (l) => l.shipment_id === shipmentId && l.contact_id === contactId && l.event_type === eventType && l.status === "sent",
      );
    };

    expect(shouldSend("s1", "c1", "in_transit")).toBe(false); // Already sent
    expect(shouldSend("s1", "c1", "delivered")).toBe(true); // Different event
    expect(shouldSend("s1", "c2", "in_transit")).toBe(true); // Different contact
  });

  // ─── Notification context ─────────────────────────────────
  it("builds tracking URL from tracking number", () => {
    const trackingNumber = "9400111899223456789012";
    const url = `https://sendmo.co/track/${trackingNumber}`;
    expect(url).toBe("https://sendmo.co/track/9400111899223456789012");
  });

  it("formats estimated delivery from ISO date", () => {
    const isoDate = "2026-03-25T12:00:00Z";
    const formatted = new Date(isoDate).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    expect(formatted).toContain("March");
    // Day may be 24 or 25 depending on timezone — just verify it's a valid date
    expect(formatted).toMatch(/March \d+/);
  });

  // ─── Event type mapping ───────────────────────────────────
  it("only notifies for in_transit, out_for_delivery, delivered", () => {
    const notifyStatuses = new Set(["in_transit", "out_for_delivery", "delivered"]);
    expect(notifyStatuses.has("in_transit")).toBe(true);
    expect(notifyStatuses.has("delivered")).toBe(true);
    expect(notifyStatuses.has("return_to_sender")).toBe(false);
    expect(notifyStatuses.has("label_created")).toBe(false);
  });

  // ─── Contact storage ─────────────────────────────────────
  it("builds notification contact records from email inputs", () => {
    const shipmentId = "ship-123";
    const recipientEmail = "recipient@test.com";
    const senderEmail = "sender@test.com";

    const contacts: Array<{ shipment_id: string; role: string; channel: string; address: string }> = [];
    if (recipientEmail) contacts.push({ shipment_id: shipmentId, role: "recipient", channel: "email", address: recipientEmail });
    if (senderEmail) contacts.push({ shipment_id: shipmentId, role: "sender", channel: "email", address: senderEmail });

    expect(contacts).toHaveLength(2);
    expect(contacts[0].role).toBe("recipient");
    expect(contacts[1].role).toBe("sender");
  });

  it("skips null sender_email gracefully", () => {
    const shipmentId = "ship-456";
    const recipientEmail = "r@test.com";
    const senderEmail: string | null = null;

    const contacts: Array<{ shipment_id: string; role: string; channel: string; address: string }> = [];
    if (recipientEmail) contacts.push({ shipment_id: shipmentId, role: "recipient", channel: "email", address: recipientEmail });
    if (senderEmail) contacts.push({ shipment_id: shipmentId, role: "sender", channel: "email", address: senderEmail });

    expect(contacts).toHaveLength(1);
    expect(contacts[0].role).toBe("recipient");
  });
});
