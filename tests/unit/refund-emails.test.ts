import { describe, it, expect } from "vitest";
import {
  refundSubmittedEmail,
  refundCompletedEmail,
  refundUnsuccessfulEmail,
} from "../../supabase/functions/_shared/email-templates";

// H5 — refund lifecycle email unit tests
// Decided proposal: 2026-05-21_refund-system-implementation_..._decided-2026-05-22.md
// Decision D5 — approved copy, carrier-aware, canceller-aware, soft hedge.
//
// Tests verify:
//   - Each template renders without throwing
//   - Carrier-aware copy is correct (USPS slow vs UPS/FedEx faster)
//   - Tracking URL is included
//   - Canceller-name logic: generic when payer, named when not payer
//   - SendMo blue branding present
//   - Amount formatted correctly

describe("refundSubmittedEmail (Email A)", () => {
  const base = {
    amount_cents: 1295,
    carrier: "USPS",
    public_code: "H7K2P9",
    tracking_url: "https://sendmo.co/t/H7K2P9",
    canceller_is_payer: true as const,
  };

  it("renders without throwing", () => {
    expect(() => refundSubmittedEmail(base)).not.toThrow();
  });

  it("includes the amount and public code", () => {
    const { html } = refundSubmittedEmail(base);
    expect(html).toContain("$12.95");
    expect(html).toContain("H7K2P9");
  });

  it("includes the tracking URL", () => {
    const { html } = refundSubmittedEmail(base);
    expect(html).toContain("https://sendmo.co/t/H7K2P9");
  });

  it("includes SendMo branding", () => {
    const { html } = refundSubmittedEmail(base);
    expect(html).toContain("SendMo");
  });

  it("USPS — uses the slow-carrier timeline (2–4 weeks)", () => {
    const { html } = refundSubmittedEmail({ ...base, carrier: "USPS" });
    expect(html).toContain("2–4 weeks");
  });

  it("UPS — uses the faster-carrier timeline (1–2 weeks)", () => {
    const { html } = refundSubmittedEmail({ ...base, carrier: "UPS" });
    expect(html).toContain("1–2 weeks");
    expect(html).not.toContain("2–4 weeks");
  });

  it("FedEx — uses the faster-carrier timeline (1–2 weeks)", () => {
    const { html } = refundSubmittedEmail({ ...base, carrier: "FedEx" });
    expect(html).toContain("1–2 weeks");
    expect(html).not.toContain("2–4 weeks");
  });

  it("when canceller is the payer — no canceller-name line shown", () => {
    const { html } = refundSubmittedEmail({ ...base, canceller_is_payer: true });
    expect(html).not.toContain("cancelled by the person using your shared link");
    expect(html).not.toContain("cancelled by our team");
  });

  it("when canceller is a link_user — shows shared-link copy", () => {
    const { html } = refundSubmittedEmail({
      ...base,
      canceller_is_payer: false,
      canceller_type: "link_user",
    });
    expect(html).toContain("cancelled by the person using your shared link");
  });

  it("when canceller is admin — shows 'by our team' copy", () => {
    const { html } = refundSubmittedEmail({
      ...base,
      canceller_is_payer: false,
      canceller_type: "admin",
    });
    expect(html).toContain("cancelled by our team");
  });

  it("subject contains the amount", () => {
    const { subject } = refundSubmittedEmail(base);
    expect(subject).toContain("$12.95");
  });

  it("subject mentions SendMo", () => {
    const { subject } = refundSubmittedEmail(base);
    expect(subject).toContain("SendMo");
  });
});

describe("refundCompletedEmail (Email B)", () => {
  const base = {
    amount_cents: 1295,
    public_code: "H7K2P9",
    tracking_url: "https://sendmo.co/t/H7K2P9",
  };

  it("renders without throwing", () => {
    expect(() => refundCompletedEmail(base)).not.toThrow();
  });

  it("includes the amount and public code", () => {
    const { html } = refundCompletedEmail(base);
    expect(html).toContain("$12.95");
    expect(html).toContain("H7K2P9");
  });

  it("includes the tracking URL", () => {
    const { html } = refundCompletedEmail(base);
    expect(html).toContain("https://sendmo.co/t/H7K2P9");
  });

  it("mentions the 5–10 business day bank posting note", () => {
    const { html } = refundCompletedEmail(base);
    expect(html).toContain("5–10 business days");
  });

  it("when last4 is provided — mentions the card", () => {
    const { html } = refundCompletedEmail({ ...base, last4: "4242" });
    expect(html).toContain("4242");
    expect(html).toContain("ending in");
  });

  it("when last4 is omitted — uses generic 'original payment method' copy", () => {
    const { html } = refundCompletedEmail({ ...base, last4: null });
    expect(html).toContain("original payment method");
    expect(html).not.toContain("ending in");
  });

  it("subject contains amount and SendMo", () => {
    const { subject } = refundCompletedEmail(base);
    expect(subject).toContain("$12.95");
    expect(subject).toContain("SendMo");
  });
});

describe("refundUnsuccessfulEmail (Email C)", () => {
  const base = {
    amount_cents: 1295,
    carrier: "USPS",
    public_code: "H7K2P9",
    tracking_url: "https://sendmo.co/t/H7K2P9",
  };

  it("renders without throwing", () => {
    expect(() => refundUnsuccessfulEmail(base)).not.toThrow();
  });

  it("includes the public code and tracking URL", () => {
    const { html } = refundUnsuccessfulEmail(base);
    expect(html).toContain("H7K2P9");
    expect(html).toContain("https://sendmo.co/t/H7K2P9");
  });

  it("uses the 'Refund unsuccessful' customer-facing word (Decision D4)", () => {
    const { subject } = refundUnsuccessfulEmail(base);
    expect(subject).toContain("Refund unsuccessful");
  });

  it("uses soft framing — carrier didn't return the cost", () => {
    const { html } = refundUnsuccessfulEmail(base);
    expect(html).toContain("did not return the shipping cost");
  });

  it("names the carrier in the body", () => {
    const { html } = refundUnsuccessfulEmail({ ...base, carrier: "FedEx" });
    expect(html).toContain("FedEx");
  });

  it("falls back to 'the carrier' when carrier is empty", () => {
    const { html } = refundUnsuccessfulEmail({ ...base, carrier: "" });
    expect(html).toContain("the carrier");
  });

  it("when reason is provided — shows carrier note", () => {
    const { html } = refundUnsuccessfulEmail({ ...base, reason: "Package scanned" });
    expect(html).toContain("Package scanned");
    expect(html).toContain("Carrier note");
  });

  it("when reason is null — no carrier note shown", () => {
    const { html } = refundUnsuccessfulEmail({ ...base, reason: null });
    expect(html).not.toContain("Carrier note");
  });

  it("includes contact link for disputes", () => {
    const { html } = refundUnsuccessfulEmail(base);
    expect(html).toContain("support@sendmo.co");
  });

  it("subject contains 'SendMo'", () => {
    const { subject } = refundUnsuccessfulEmail(base);
    expect(subject).toContain("SendMo");
  });
});
