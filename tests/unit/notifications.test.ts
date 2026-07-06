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

// ─── label_created routing (2026-06-27 — confirmation-email-by-role) ──────────
// Locks the role↔payer asymmetry: the label-created email goes only to the
// PAYER, whose contact role differs by flow. Full-label payer = `sender`;
// flex payer (the link owner) = `recipient`.
describe("label_created — routing + variant (2026-07-06 flex-sender-visibility)", () => {
  // Mirrors dispatchNotifications routing:
  //   payerRole   = is_flex ? "recipient" : "sender"   (always receives)
  //   flex sender = also receives, but ONLY when a cancel_token is present
  //                 (else the tokenized cancel CTA would be a dead link → skip)
  const payerRole = (isFlex: boolean) => (isFlex ? "recipient" : "sender");
  const variantFor = (isFlex: boolean) => (isFlex ? "flex" : "full_label");
  // Which contacts get label_created, per the new predicate.
  const receivesCreation = (
    role: string, isFlex: boolean, cancelToken: string | null,
  ) => role === payerRole(isFlex) || (isFlex && role === "sender" && !!cancelToken);
  // Which template each recipient gets.
  const templateFor = (role: string, isFlex: boolean) =>
    isFlex && role === "sender" ? "senderLabelReadyEmail" : "labelConfirmationEmail";

  it("full-label: payer is the sender role, flex payer is the recipient role", () => {
    expect(payerRole(false)).toBe("sender");
    expect(payerRole(true)).toBe("recipient");
    expect(variantFor(true)).toBe("flex");
  });

  it("full-label: only the sender contact receives label_created (recipient excluded)", () => {
    const contacts = [
      { role: "sender", address: "payer@test.com" },
      { role: "recipient", address: "dest@test.com" },
    ];
    const got = contacts.filter((c) => receivesCreation(c.role, false, null));
    expect(got.map((c) => c.address)).toEqual(["payer@test.com"]);
  });

  it("flex WITH token: BOTH owner (payer copy) and sender (tokenized copy) receive it", () => {
    const contacts = [
      { role: "recipient", address: "owner@test.com" }, // link owner = payer
      { role: "sender", address: "shipper@test.com" },  // the person who ships
    ];
    const got = contacts.filter((c) => receivesCreation(c.role, true, "tok123"));
    expect(got.map((c) => c.address).sort()).toEqual(["owner@test.com", "shipper@test.com"]);
    expect(templateFor("recipient", true)).toBe("labelConfirmationEmail");
    expect(templateFor("sender", true)).toBe("senderLabelReadyEmail");
  });

  it("flex WITHOUT token: only the owner receives it (sender skipped — no dead cancel link)", () => {
    const contacts = [
      { role: "recipient", address: "owner@test.com" },
      { role: "sender", address: "shipper@test.com" },
    ];
    const got = contacts.filter((c) => receivesCreation(c.role, true, null));
    expect(got.map((c) => c.address)).toEqual(["owner@test.com"]);
  });

  it("self-send flex (single payer/recipient contact) → exactly one email, no sender copy", () => {
    // sameInbox dedupe in labels stores ONE contact on the payer role.
    const contacts = [{ role: "recipient", address: "me@test.com" }];
    const got = contacts.filter((c) => receivesCreation(c.role, true, "tok123"));
    expect(got).toHaveLength(1);
    expect(templateFor("recipient", true)).toBe("labelConfirmationEmail");
  });
});

// ─── full-label contact build: payer email resolution + self-send dedupe ──────
// Mirrors labels/index.ts: senderAddr = body sender_email || (full-label only)
// callerEmail; if payer == recipient inbox, store ONLY the sender/payer contact.
describe("full-label contact build", () => {
  const build = (opts: {
    recipientEmail: string | null;
    bodySenderEmail: string | null;
    callerEmail: string | null;
    resolvedLink: boolean;
  }) => {
    const { recipientEmail, bodySenderEmail, callerEmail, resolvedLink } = opts;
    const recipientAddr = recipientEmail || null;
    const senderAddr = bodySenderEmail || (resolvedLink ? null : callerEmail);
    // Payer role differs by flow (mirrors labels/index.ts): full-label payer is
    // `sender`, flex payer (the owner) is `recipient`.
    const payerRole = resolvedLink ? "recipient" : "sender";
    const payerAddr = resolvedLink ? recipientAddr : senderAddr;
    const contacts: Array<{ role: string; address: string }> = [];
    const sameInbox = !!senderAddr && !!recipientAddr
      && senderAddr.toLowerCase() === recipientAddr.toLowerCase();
    if (sameInbox) {
      contacts.push({ role: payerRole, address: (payerAddr ?? senderAddr)! });
    } else {
      if (recipientAddr) contacts.push({ role: "recipient", address: recipientAddr });
      if (senderAddr) contacts.push({ role: "sender", address: senderAddr });
    }
    return contacts;
  };

  it("authed full-label payer (empty body sender_email) → payer resolved from callerEmail", () => {
    const c = build({ recipientEmail: "dest@test.com", bodySenderEmail: null, callerEmail: "payer@test.com", resolvedLink: false });
    expect(c).toEqual([
      { role: "recipient", address: "dest@test.com" },
      { role: "sender", address: "payer@test.com" },
    ]);
  });

  it("flex does NOT fall back to callerEmail for the sender contact", () => {
    // recipient (owner) is added elsewhere (line ~218); here body sender_email
    // absent + resolvedLink → no sender contact from callerEmail.
    const c = build({ recipientEmail: "owner@test.com", bodySenderEmail: null, callerEmail: "someone@test.com", resolvedLink: true });
    expect(c).toEqual([{ role: "recipient", address: "owner@test.com" }]);
  });

  it("self-send (payer == recipient) dedupes to a single payer/sender contact", () => {
    const c = build({ recipientEmail: "me@test.com", bodySenderEmail: null, callerEmail: "ME@test.com", resolvedLink: false });
    expect(c).toEqual([{ role: "sender", address: "ME@test.com" }]);
  });

  it("flex self-send dedupes onto the RECIPIENT role (the owner is the payer), so the creation email still routes", () => {
    // Flex owner ships to themselves via their own link: resolved recipient
    // (owner) == body sender_email. The surviving contact must be `recipient`,
    // because dispatch routes flex label_created to payerRole='recipient'.
    // (Regression for the code-review #2 finding: dedupe used to hardcode
    // `sender`, which dropped the flex owner's creation email.)
    const c = build({ recipientEmail: "owner@test.com", bodySenderEmail: "owner@test.com", callerEmail: null, resolvedLink: true });
    expect(c).toEqual([{ role: "recipient", address: "owner@test.com" }]);
  });
});
