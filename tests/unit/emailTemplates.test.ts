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
  it("handles in_transit status", () => {
    const result = trackingUpdateEmail("in_transit", "TRACK123");
    expect(result.subject).toContain("in transit");
    expect(result.html).toContain("TRACK123");
    expect(result.html).toContain("on its way");
  });

  it("handles out_for_delivery status", () => {
    const result = trackingUpdateEmail("out_for_delivery", "TRACK456");
    expect(result.subject).toContain("out for delivery");
    expect(result.html).toContain("arrive today");
  });

  it("handles delivered status", () => {
    const result = trackingUpdateEmail("delivered", "TRACK789");
    expect(result.subject).toContain("delivered");
    expect(result.html).toContain("has been delivered");
  });

  it("handles unknown status gracefully", () => {
    const result = trackingUpdateEmail("unknown_status", "TRACK000");
    expect(result.html).toContain("TRACK000");
    expect(result.subject).toBeDefined();
  });
});
