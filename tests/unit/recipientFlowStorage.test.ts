import { describe, it, expect, beforeEach } from "vitest";
import {
  INITIAL_DATA,
  loadPersisted,
  persist,
  prefillSlotFor,
  startFlowAs,
} from "@/lib/recipientFlowStorage";
import { canAccessStep, slugToStep, stepUrl } from "@/lib/stepRouting";

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("prefillSlotFor — which party owns the saved address", () => {
  // The whole point of step 0: 'self' and 'other' put the account holder on
  // opposite ends of the shipment, so a saved address means opposite things.
  it("routes the saved address to the ORIGIN when the user is the one sending", () => {
    expect(prefillSlotFor("self")).toBe("origin");
  });

  it("routes the saved address to the DESTINATION when someone else is sending", () => {
    expect(prefillSlotFor("other")).toBe("destination");
  });

  it("falls back to DESTINATION when step 0 hasn't been answered (deep link)", () => {
    // Preserves the pre-existing behaviour for every /onboarding/... deep link
    // minted before this flow existed.
    expect(prefillSlotFor(null)).toBe("destination");
  });
});

describe("startFlowAs", () => {
  it("records the sender so the provider can hydrate it on the next route", () => {
    startFlowAs("self");
    expect(loadPersisted()?.sender).toBe("self");
  });

  it("clears a previous run's addresses when a new door is picked", () => {
    // Regression guard: 'other' put the user's own address in destination.
    // Re-picking 'self' must not carry it over — destination is now the OTHER
    // party, and a stale value there mails the package to the wrong person.
    persist({
      ...INITIAL_DATA,
      sender: "other",
      destinationAddress: { ...INITIAL_DATA.destinationAddress, street: "231 Canyon Drive", verified: true },
      originAddress: { ...INITIAL_DATA.originAddress, street: "88 Oak Ave" },
      completedSteps: [0, 1, 10],
      email: "someone@example.com",
    });

    startFlowAs("self");

    const restored = loadPersisted()!;
    expect(restored.sender).toBe("self");
    expect(restored.destinationAddress.street).toBe("");
    expect(restored.destinationAddress.verified).toBeFalsy();
    expect(restored.originAddress.street).toBe("");
    expect(restored.completedSteps).toEqual([]);
    expect(restored.email).toBe("");
  });
});

describe("the address escape — 'I don't have their address'", () => {
  // OQ2 option (c): both branches start on full-label and only the escape moves
  // a flow to the shipping-link path. These lock the assumptions that makes safe.
  it("lands on a step the flexible path's guard actually admits", () => {
    // At the escape the user has completed steps 0 and 1 — both shared. If this
    // ever fails, the escape bounces the user to firstIncompleteUrl instead.
    expect(canAccessStep(20, [0, 1], "flexible")).toBe(true);
  });

  it("does not admit a flexible step the user has not earned", () => {
    expect(canAccessStep(22, [0, 1], "flexible")).toBe(false);
  });

  it("targets the preferences step", () => {
    expect(stepUrl("flexible", 20)).toBe("/onboarding/flexible/preferences");
  });

  it("returns to the origin step on undo", () => {
    expect(stepUrl("full_label", 10)).toBe("/onboarding/full-label/shipping");
  });

  it("keeps every pre-existing deep link resolving", () => {
    // Nothing about the routing shape changed, so URLs minted before this flow
    // (and the e2e specs that hard-code them) still map to the same steps.
    expect(slugToStep("full_label", "destination")).toBe(1);
    expect(slugToStep("full_label", "shipping")).toBe(10);
    expect(slugToStep("flexible", "preferences")).toBe(20);
    expect(slugToStep("flexible", "authorize")).toBe(22);
  });
});
