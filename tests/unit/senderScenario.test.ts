import { describe, it, expect } from "vitest";
import { senderScenario, collectionStepLabel, senderIntroSubhead } from "@/lib/senderScenario";
import type { LinkData } from "@/lib/api";

// The creator's skips are IMPLIED by what the link carries, not stored as
// flags — see the module comment. These pin that derivation, because getting
// it wrong means the sender flow either asks for something it already has or,
// far worse, fails to ask for something the label needs.

const link = (over: Partial<LinkData> = {}): LinkData => ({
  id: "l1", short_code: "ABC123", link_type: "flexible", status: "active",
  max_price_cents: 10000, preferred_speed: "standard", preferred_carrier: "any",
  size_hint: null, notes: null, recipient_city: "Portola Valley", recipient_state: "CA",
  recipient_zip: "94028", recipient_name: "Jordan Chen", recipient_address_complete: true,
  ...over,
} as LinkData);

describe("senderScenario", () => {
  it("a fully-specced link asks the sender for nothing", () => {
    const s = senderScenario(link({
      origin_prefill: { name: "A", street1: "1 Main", city: "SF", state: "CA", zip: "94107", phone: "4155550100", verified: true },
      package_prefill: { length_in: 10, width_in: 7, height_in: 4, weight_oz: 35 },
    }));
    expect(s).toEqual({ needsDestination: false, needsOrigin: false, needsPackage: false });
  });

  it("no origin_prefill means the sender supplies the origin", () => {
    expect(senderScenario(link({
      package_prefill: { length_in: 10, width_in: 7, height_in: 4, weight_oz: 35 },
    })).needsOrigin).toBe(true);
  });

  it("no package_prefill means the sender describes the package", () => {
    expect(senderScenario(link({
      origin_prefill: { name: "A", street1: "1 Main", city: "SF", state: "CA", zip: "94107", phone: "4155550100", verified: true },
    })).needsPackage).toBe(true);
  });

  it("needs_destination is explicit — absent or false both mean 'already known'", () => {
    expect(senderScenario(link()).needsDestination).toBe(false);
    expect(senderScenario(link({ needs_destination: false })).needsDestination).toBe(false);
    expect(senderScenario(link({ needs_destination: true })).needsDestination).toBe(true);
  });

  it("a bare link — creator skipped everything — asks for all three", () => {
    expect(senderScenario(link({ needs_destination: true }))).toEqual({
      needsDestination: true, needsOrigin: true, needsPackage: true,
    });
  });
});

describe("collectionStepLabel", () => {
  it("names what this sender is being asked for", () => {
    expect(collectionStepLabel({ needsDestination: false, needsOrigin: false, needsPackage: true })).toBe("Package");
    expect(collectionStepLabel({ needsDestination: false, needsOrigin: true, needsPackage: true })).toBe("Your info");
    expect(collectionStepLabel({ needsDestination: true, needsOrigin: true, needsPackage: true })).toBe("Destination & info");
  });
});

describe("senderIntroSubhead", () => {
  it("covers all eight skip combinations without falling through to a wrong promise", () => {
    const seen = new Set<string>();
    for (const d of [true, false]) for (const o of [true, false]) for (const p of [true, false]) {
      const out = senderIntroSubhead({ needsDestination: d, needsOrigin: o, needsPackage: p });
      expect(out.length).toBeGreaterThan(0);
      seen.add(out);
      // Never promise "everything else is set" while the destination is
      // still missing — that is the one combination where it would be a lie.
      if (d) expect(out).not.toMatch(/everything else is set/i);
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  it("tells a nothing-left sender to just print", () => {
    expect(senderIntroSubhead({ needsDestination: false, needsOrigin: false, needsPackage: false }))
      .toMatch(/print the label/i);
  });
});
