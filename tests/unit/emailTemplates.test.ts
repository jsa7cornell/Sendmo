import { describe, it, expect } from "vitest";
import {
  otpEmail,
  labelConfirmationEmail,
  trackingUpdateEmail,
} from "../../supabase/functions/_shared/email-templates";

describe("otpEmail", () => {
  it("returns subject and html with the code", () => {
    const result = otpEmail("123456");
    expect(result.subject).toBe("Your SendMo verification code");
    expect(result.html).toContain("123456");
    expect(result.html).toContain("SendMo");
    expect(result.html).toContain("10 minutes");
  });

  it("contains branded header with SendMo blue", () => {
    const result = otpEmail("999999");
    expect(result.html).toContain("#2563EB");
    expect(result.html).toContain("Verify your email");
  });
});

describe("labelConfirmationEmail", () => {
  it("returns subject and html with tracking info", () => {
    const result = labelConfirmationEmail("1Z999AA10123456784", "UPS", "3 business days");
    expect(result.subject).toContain("shipping label");
    expect(result.html).toContain("1Z999AA10123456784");
    expect(result.html).toContain("UPS");
    expect(result.html).toContain("3 business days");
  });

  it("includes SendMo branding", () => {
    const result = labelConfirmationEmail("TRACK123", "USPS", "5 days");
    expect(result.html).toContain("SendMo");
    expect(result.html).toContain("#2563EB");
  });
});

describe("trackingUpdateEmail", () => {
  // ─── Recipient (default) ──────────────────────────────────
  it("recipient: in_transit with tracking details", () => {
    const result = trackingUpdateEmail(
      "in_transit", "TRACK123", "USPS", "Friday, March 21", "https://sendmo.co/track/TRACK123",
    );
    expect(result.subject).toContain("Your package");
    expect(result.subject).toContain("in transit");
    expect(result.html).toContain("TRACK123");
    expect(result.html).toContain("USPS");
    expect(result.html).toContain("Friday, March 21");
    expect(result.html).toContain("Your package is on its way");
    expect(result.html).toContain("https://sendmo.co/track/TRACK123");
    expect(result.html).toContain("Track Package");
  });

  it("recipient: delivered confirmation", () => {
    const result = trackingUpdateEmail("delivered", "TRACK789");
    expect(result.subject).toContain("delivered");
    expect(result.html).toContain("Your package has been delivered");
  });

  it("recipient: out_for_delivery", () => {
    const result = trackingUpdateEmail("out_for_delivery", "TRACK456");
    expect(result.subject).toContain("out for delivery");
    expect(result.html).toContain("Your package is out for delivery");
  });

  // ─── Sender role ──────────────────────────────────────────
  it("sender: in_transit uses sender-specific language", () => {
    const result = trackingUpdateEmail(
      "in_transit", "TRACK123", "UPS", "Monday, March 24",
      "https://sendmo.co/track/TRACK123", "sender",
    );
    expect(result.subject).toContain("Package you sent");
    expect(result.html).toContain("The package you sent is on its way");
    expect(result.html).toContain("UPS");
    expect(result.html).toContain("Monday, March 24");
  });

  it("sender: delivered uses sender-specific language", () => {
    const result = trackingUpdateEmail(
      "delivered", "TRACK789", undefined, undefined, undefined, "sender",
    );
    expect(result.subject).toContain("Package you sent");
    expect(result.html).toContain("The package you sent has been delivered");
  });

  it("sender: out_for_delivery uses sender-specific language", () => {
    const result = trackingUpdateEmail(
      "out_for_delivery", "TRACK456", undefined, undefined, undefined, "sender",
    );
    expect(result.html).toContain("The package you sent is out for delivery");
  });

  // ─── Optional fields ─────────────────────────────────────
  it("works without optional fields (carrier, eta, trackingUrl)", () => {
    const result = trackingUpdateEmail("in_transit", "TRACK000");
    expect(result.html).toContain("TRACK000");
    expect(result.html).not.toContain("Track Package");
    expect(result.subject).toBeDefined();
  });

  it("includes Track Package button when trackingUrl is provided", () => {
    const result = trackingUpdateEmail(
      "in_transit", "TRACK123", undefined, undefined, "https://sendmo.co/track/TRACK123",
    );
    expect(result.html).toContain("Track Package");
    expect(result.html).toContain("https://sendmo.co/track/TRACK123");
  });

  it("handles unknown status gracefully", () => {
    const result = trackingUpdateEmail("unknown_status", "TRACK000");
    expect(result.html).toContain("TRACK000");
    expect(result.subject).toBeDefined();
  });
});
