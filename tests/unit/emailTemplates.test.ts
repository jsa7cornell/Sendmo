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
  const baseParams = {
    publicCode: "ABC1234",
    carrierTracking: "1Z999AA10123456784",
    carrier: "UPS",
    eta: "3 business days",
    trackingUrl: "https://sendmo.co/t/ABC1234",
    variant: "full_label" as const,
  };

  it("full_label variant: payer-facing 'label is ready' copy, no 'link' wording", () => {
    const result = labelConfirmationEmail(baseParams);
    expect(result.subject).toBe("Your SendMo label is ready");
    expect(result.html).toContain("Your label is ready!");
    expect(result.html).toContain("Your prepaid shipping label has been created");
    // Regression: the old link-flow wording must be gone for full-label.
    expect(result.subject).not.toContain("prepaid link");
    expect(result.html).not.toContain("printed using your prepaid link");
    expect(result.html).not.toContain("purchased for your SendMo link");
  });

  it("flex variant: link-owner copy that references the prepaid link", () => {
    const result = labelConfirmationEmail({ ...baseParams, variant: "flex" });
    expect(result.subject).toBe("A label was created with your prepaid link — SendMo");
    expect(result.html).toContain("Label created!");
    expect(result.html).toContain("using your SendMo prepaid link");
    // Even flex no longer says "printed" — this is the creation email.
    expect(result.subject).not.toContain("printed");
  });

  it("details block is identical across variants (only headline/subject/intro differ)", () => {
    const full = labelConfirmationEmail(baseParams).html;
    const flex = labelConfirmationEmail({ ...baseParams, variant: "flex" }).html;
    for (const token of ["ABC1234", "1Z999AA10123456784", "UPS", "3 business days", "Track Package", "https://sendmo.co/t/ABC1234"]) {
      expect(full).toContain(token);
      expect(flex).toContain(token);
    }
  });

  it("embeds public code, carrier tracking number, carrier, and ETA", () => {
    const result = labelConfirmationEmail(baseParams);
    expect(result.html).toContain("ABC1234");
    expect(result.html).toContain("1Z999AA10123456784");
    expect(result.html).toContain("UPS");
    expect(result.html).toContain("3 business days");
  });

  it("includes the Track Package CTA pointing at the tracking URL", () => {
    const result = labelConfirmationEmail(baseParams);
    expect(result.html).toContain("Track Package");
    expect(result.html).toContain("https://sendmo.co/t/ABC1234");
  });

  it("includes SendMo branding", () => {
    const result = labelConfirmationEmail(baseParams);
    expect(result.html).toContain("SendMo");
    expect(result.html).toContain("#2563EB");
  });

  it("renders From / Item / Amount rows when provided", () => {
    const result = labelConfirmationEmail({
      ...baseParams,
      senderName: "Jane Doe",
      itemDescription: "Vintage camera lens",
      displayPriceCents: 1234,
    });
    expect(result.html).toContain("From");
    expect(result.html).toContain("Jane Doe");
    expect(result.html).toContain("Item");
    expect(result.html).toContain("Vintage camera lens");
    expect(result.html).toContain("Amount");
    expect(result.html).toContain("$12.34");
  });

  it("truncates long item descriptions to 40 chars + ellipsis", () => {
    const result = labelConfirmationEmail({
      ...baseParams,
      itemDescription: "A very long item description that exceeds the forty character limit by a lot",
    });
    expect(result.html).toContain("A very long item description that exceed…");
    expect(result.html).not.toContain("by a lot");
  });

  it("omits From / Item / Amount rows when fields are null or blank", () => {
    const result = labelConfirmationEmail({
      ...baseParams,
      senderName: null,
      itemDescription: "   ",
      displayPriceCents: null,
    });
    expect(result.html).not.toContain(">From<");
    expect(result.html).not.toContain(">Item<");
    expect(result.html).not.toContain(">Amount<");
  });

  it("omits Amount row when displayPriceCents is zero or negative", () => {
    const result = labelConfirmationEmail({
      ...baseParams,
      displayPriceCents: 0,
    });
    expect(result.html).not.toContain(">Amount<");
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
