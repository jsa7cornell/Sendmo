import { describe, it, expect } from "vitest";

// The localStorage polyfill and its round-trip block went with the saved-sender
// store itself (2026-08-24) — nothing in senderState touches storage now.
import {
  speedTierForService, isPreferredRate, dropOffCopy, isValidEmail,
} from "../../src/components/sender/senderState";
import type { ShippingRate } from "../../src/lib/types";
import type { LinkData } from "../../src/lib/api";

describe("senderState helpers", () => {
  describe("speedTierForService (delegates to canonical classifySpeedTier)", () => {
    it("classifies express services", () => {
      expect(speedTierForService("UPS", "NextDayAir")).toBe("express");
      expect(speedTierForService("UPS", "2ndDayAir")).toBe("express");
      expect(speedTierForService("FedEx", "FEDEX_2_DAY")).toBe("express");
    });
    it("classifies standard services", () => {
      expect(speedTierForService("USPS", "Priority")).toBe("standard");
      expect(speedTierForService("UPS", "3DaySelect")).toBe("standard");
    });
    it("classifies economy services", () => {
      expect(speedTierForService("USPS", "GroundAdvantage")).toBe("economy");
      expect(speedTierForService("FedEx", "GROUND_HOME_DELIVERY")).toBe("economy");
    });
    it("defaults to standard for unknown services (canonical classifier's contract)", () => {
      expect(speedTierForService("CARRIER", "Mystery")).toBe("standard");
    });
  });

  describe("isPreferredRate", () => {
    const link = (speed: string | null): LinkData => ({
      id: "x", short_code: "abc", link_type: "flexible", status: "active",
      max_price_cents: 10000, preferred_speed: speed, preferred_carrier: null,
      size_hint: null, notes: null,
      recipient_city: null, recipient_state: null, recipient_zip: null, recipient_name: null,
    });
    const rate = (service: string): ShippingRate => ({
      id: "r", carrier: "USPS", service, rate_cents: 500, display_price_cents: 700,
      estimated_days: 3, currency: "USD",
    });

    it("matches when service tier equals preferred_speed", () => {
      expect(isPreferredRate(rate("Priority"), link("standard"))).toBe(true);
      expect(isPreferredRate(rate("GroundAdvantage"), link("economy"))).toBe(true);
    });
    it("does not match when preferred_speed is null", () => {
      expect(isPreferredRate(rate("Priority"), link(null))).toBe(false);
    });
    it("does not match on tier mismatch", () => {
      expect(isPreferredRate(rate("GroundAdvantage"), link("express"))).toBe(false);
    });
  });

  describe("dropOffCopy", () => {
    it("returns USPS-specific copy for usps rates", () => {
      const c = dropOffCopy("USPS");
      expect(c.body).toMatch(/USPS/);
      expect(c.locationUrl).toContain("usps.com");
    });
    it("returns UPS-specific copy", () => {
      const c = dropOffCopy("UPS");
      expect(c.body).toMatch(/UPS/);
      expect(c.locationUrl).toContain("ups.com");
    });
    it("returns FedEx-specific copy", () => {
      const c = dropOffCopy("FedEx");
      expect(c.body).toMatch(/FedEx/);
      expect(c.locationUrl).toContain("fedex.com");
    });
    it("falls back gracefully for unknown carriers", () => {
      const c = dropOffCopy("UnknownCo");
      expect(c.body).toMatch(/UnknownCo/);
      expect(c.locationUrl).toBeNull();
    });
    it("is keyed off the selected rate's carrier, case-insensitively", () => {
      // Reviewer's non-blocking concern: drop-off must follow the SELECTED
      // rate, not the link's preferred carrier. Verified by passing the
      // carrier string from a hypothetical selectedRate.
      expect(dropOffCopy("ups").body).toMatch(/UPS/);
      expect(dropOffCopy("FEDEX").body).toMatch(/FedEx/);
    });
  });

  describe("isValidEmail", () => {
    it("accepts well-formed emails", () => {
      expect(isValidEmail("a@b.co")).toBe(true);
      expect(isValidEmail("jane.doe+sendmo@example.com")).toBe(true);
    });
    it("rejects malformed emails", () => {
      expect(isValidEmail("")).toBe(false);
      expect(isValidEmail("no-at-sign")).toBe(false);
      expect(isValidEmail("two@@signs.com")).toBe(false);
      expect(isValidEmail("no-tld@example")).toBe(false);
    });
  });
});
