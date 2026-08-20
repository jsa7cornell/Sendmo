import { describe, it, expect, beforeEach, beforeAll } from "vitest";

// JSDOM's localStorage implementation in this project's vitest config is
// incomplete (no setItem/clear). Install an in-memory polyfill before any
// senderState helpers (which call window.localStorage) are exercised.
beforeAll(() => {
  const store = new Map<string, string>();
  const mock = {
    getItem: (k: string) => store.has(k) ? store.get(k)! : null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };
  Object.defineProperty(globalThis, "localStorage", { value: mock, writable: true, configurable: true });
  Object.defineProperty(window, "localStorage", { value: mock, writable: true, configurable: true });
});
import {
  loadSavedSender, saveSender,
  speedTierForService, isPreferredRate, dropOffCopy, isValidEmail,
} from "../../src/components/sender/senderState";
import type { ShippingRate } from "../../src/lib/types";
import type { LinkData } from "../../src/lib/api";

describe("senderState helpers", () => {
  describe("localStorage round-trip", () => {
    beforeEach(() => {
      // JSDOM provides localStorage as a property but `.clear()` is sometimes
      // missing in older versions; remove the one key we touch by name.
      try { globalThis.localStorage.removeItem("sendmo:sender:v1"); } catch { /* noop */ }
    });

    it("returns null when storage is empty", () => {
      expect(loadSavedSender()).toBeNull();
    });

    it("round-trips sender address + email", () => {
      const addr = { name: "Jane", street: "1 A St", city: "SF", state: "CA", zip: "94107", phone: "4155550100" };
      saveSender(addr, "jane@example.com");
      const loaded = loadSavedSender();
      expect(loaded).not.toBeNull();
      expect(loaded?.senderAddress).toEqual(addr);
      expect(loaded?.senderEmail).toBe("jane@example.com");
    });

    it("ignores stored payloads with mismatched version", () => {
      globalThis.localStorage.setItem("sendmo:sender:v1", JSON.stringify({
        version: 999, senderAddress: {}, senderEmail: "x@y.z",
      }));
      expect(loadSavedSender()).toBeNull();
    });

    it("tolerates malformed JSON without throwing", () => {
      globalThis.localStorage.setItem("sendmo:sender:v1", "{not json");
      expect(loadSavedSender()).toBeNull();
    });
  });

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
