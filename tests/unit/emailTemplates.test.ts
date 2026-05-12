import { describe, it, expect } from "vitest";
import {
  otpEmail,
  labelConfirmationEmail,
  trackingUpdateEmail,
} from "../../supabase/functions/_shared/email-templates";

// Current signature for trackingUpdateEmail is:
//   trackingUpdateEmail(
//     status, publicCode, carrierTracking,
//     carrier?, estimatedDelivery?, trackingUrl?, role?
//   )
// The original test file pre-dated the carrierTracking parameter being
// required at position 3, so its assertions misaligned. Rewritten to match
// the current source.

describe("otpEmail", () => {
  it("subject is the SendMo verification copy", () => {
    const result = otpEmail("123456");
    expect(result.subject).toBe("Your SendMo verification code");
  });

  it("embeds the code, the brand, and the 10-minute expiry", () => {
    const result = otpEmail("123456");
    expect(result.html).toContain("123456");
    expect(result.html).toContain("SendMo");
    expect(result.html).toContain("10 minutes");
  });

  it("uses the SendMo blue and the Verify-your-email heading", () => {
    const result = otpEmail("999999");
    expect(result.html).toContain("#2563EB");
    expect(result.html).toContain("Verify your email");
  });
});

describe("labelConfirmationEmail", () => {
  it("subject references the shipping label", () => {
    const result = labelConfirmationEmail(
      "ABC1234",
      "1Z999AA10123456784",
      "UPS",
      "3 business days",
      "https://sendmo.co/t/ABC1234",
    );
    expect(result.subject).toContain("shipping label");
  });

  it("embeds public code, carrier tracking number, carrier, and ETA", () => {
    const result = labelConfirmationEmail(
      "ABC1234",
      "1Z999AA10123456784",
      "UPS",
      "3 business days",
      "https://sendmo.co/t/ABC1234",
    );
    expect(result.html).toContain("ABC1234");
    expect(result.html).toContain("1Z999AA10123456784");
    expect(result.html).toContain("UPS");
    expect(result.html).toContain("3 business days");
  });

  it("includes the Track Package CTA pointing at the tracking URL", () => {
    const result = labelConfirmationEmail(
      "ABC1234",
      "TRACK123",
      "USPS",
      "5 days",
      "https://sendmo.co/t/ABC1234",
    );
    expect(result.html).toContain("Track Package");
    expect(result.html).toContain("https://sendmo.co/t/ABC1234");
  });

  it("includes SendMo branding", () => {
    const result = labelConfirmationEmail(
      "ABC1234",
      "TRACK123",
      "USPS",
      "5 days",
      "https://sendmo.co/t/ABC1234",
    );
    expect(result.html).toContain("SendMo");
    expect(result.html).toContain("#2563EB");
  });
});

describe("trackingUpdateEmail — recipient", () => {
  it("in_transit shows carrier, ETA, and tracking CTA", () => {
    const result = trackingUpdateEmail(
      "in_transit",
      "PUB001",
      "TRACK123",
      "USPS",
      "Friday, March 21",
      "https://sendmo.co/t/PUB001",
    );
    expect(result.subject).toContain("Your package");
    expect(result.subject).toContain("In Transit");
    expect(result.html).toContain("PUB001");
    expect(result.html).toContain("TRACK123");
    expect(result.html).toContain("USPS");
    expect(result.html).toContain("Friday, March 21");
    expect(result.html).toContain("Your package is on its way");
    expect(result.html).toContain("https://sendmo.co/t/PUB001");
    expect(result.html).toContain("Track Package");
  });

  it("delivered confirmation", () => {
    const result = trackingUpdateEmail("delivered", "PUB789", "TRACK789");
    expect(result.subject).toContain("Delivered");
    expect(result.html).toContain("Your package has been delivered");
  });

  it("out_for_delivery", () => {
    const result = trackingUpdateEmail("out_for_delivery", "PUB456", "TRACK456");
    expect(result.subject).toContain("Out for Delivery");
    expect(result.html).toContain("Your package is out for delivery");
  });
});

describe("trackingUpdateEmail — sender", () => {
  it("in_transit uses sender-specific language", () => {
    const result = trackingUpdateEmail(
      "in_transit",
      "PUB001",
      "TRACK123",
      "UPS",
      "Monday, March 24",
      "https://sendmo.co/t/PUB001",
      "sender",
    );
    expect(result.subject).toContain("Package you sent");
    expect(result.html).toContain("The package you sent is on its way");
    expect(result.html).toContain("UPS");
    expect(result.html).toContain("Monday, March 24");
  });

  it("delivered uses sender-specific language", () => {
    const result = trackingUpdateEmail(
      "delivered",
      "PUB789",
      "TRACK789",
      undefined,
      undefined,
      undefined,
      "sender",
    );
    expect(result.subject).toContain("Package you sent");
    expect(result.html).toContain("The package you sent has been delivered");
  });

  it("out_for_delivery uses sender-specific language", () => {
    const result = trackingUpdateEmail(
      "out_for_delivery",
      "PUB456",
      "TRACK456",
      undefined,
      undefined,
      undefined,
      "sender",
    );
    expect(result.html).toContain("The package you sent is out for delivery");
  });
});

describe("trackingUpdateEmail — optional fields", () => {
  it("works without carrier, eta, trackingUrl", () => {
    const result = trackingUpdateEmail("in_transit", "PUB000", "TRACK000");
    expect(result.html).toContain("PUB000");
    expect(result.html).toContain("TRACK000");
    expect(result.html).not.toContain("Track Package");
    expect(result.subject).toBeDefined();
  });

  it("includes Track Package button when trackingUrl is provided", () => {
    const result = trackingUpdateEmail(
      "in_transit",
      "PUB123",
      "TRACK123",
      undefined,
      undefined,
      "https://sendmo.co/t/PUB123",
    );
    expect(result.html).toContain("Track Package");
    expect(result.html).toContain("https://sendmo.co/t/PUB123");
  });

  it("handles unknown status gracefully", () => {
    const result = trackingUpdateEmail("unknown_status", "PUB000", "TRACK000");
    expect(result.html).toContain("PUB000");
    expect(result.html).toContain("TRACK000");
    expect(result.subject).toBeDefined();
  });
});
