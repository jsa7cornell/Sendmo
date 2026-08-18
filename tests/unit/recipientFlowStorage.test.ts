import { describe, it, expect, beforeEach } from "vitest";
import {
  DRAFT_TTL_MS,
  clearFlow,
  loadResumable,
  INITIAL_DATA,
  loadPersisted,
  persist,
  prefillSlotFor,
  startFlowAs,
} from "@/lib/recipientFlowStorage";
import { canAccessStep, slugToStep, stepUrl } from "@/lib/stepRouting";

// jsdom in this project exposes `window.localStorage` as an object with NO
// methods (setItem/clear are undefined). `persist` swallows storage errors by
// design, so without a real implementation these tests would silently assert
// against a no-op. Install a minimal in-memory Storage so they exercise the
// logic rather than the environment's gap. Real browsers are unaffected —
// verified separately in Playwright.
function installMemoryStorage() {
  const map = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => { map.set(k, String(v)); },
      removeItem: (k: string) => { map.delete(k); },
      clear: () => { map.clear(); },
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() { return map.size; },
    },
  });
}

beforeEach(() => {
  installMemoryStorage();
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


describe("resuming an unfinished flow", () => {
  // The flow moved from sessionStorage to localStorage on 2026-08-18 so closing
  // the tab no longer destroys everything typed. The offer must stay narrow:
  // an unfinished flow the user is unlikely to recognise is worse than none.
  const started = () => ({
    ...INITIAL_DATA,
    sender: "other" as const,
    completedSteps: [0, 1],
    destinationAddress: { ...INITIAL_DATA.destinationAddress, street: "231 Canyon Drive" },
  });

  it("survives a closed tab — the whole point of the change", () => {
    persist(started());
    // sessionStorage is what a closed tab clears; localStorage is not.
    window.sessionStorage.clear();
    expect(loadResumable()?.destinationAddress.street).toBe("231 Canyon Drive");
  });

  it("does not offer a flow that never got past the door", () => {
    persist({ ...INITIAL_DATA, sender: "other" });
    expect(loadResumable()).toBeNull();
  });

  it("offers a flow where fields were typed but no step was completed", () => {
    // The case that exposed a too-strict predicate: name + phone + email
    // entered, address not yet verified, Continue not yet clicked. That is real
    // work and losing it is the complaint being fixed.
    persist({
      ...INITIAL_DATA,
      sender: "other",
      email: "j@e.com",
      destinationAddress: { ...INITIAL_DATA.destinationAddress, name: "Jane Doe", phone: "4155550100" },
    });
    expect(loadResumable()).not.toBeNull();
  });

  it("does not offer a finished flow", () => {
    persist({ ...started(), short_code: "ABC123" });
    expect(loadResumable()).toBeNull();
  });

  it("expires a stale draft rather than resurrecting it", () => {
    persist(started());
    // An address typed weeks ago is likelier wrong than useful — and this is
    // shared-computer data.
    expect(loadResumable(Date.now() + DRAFT_TTL_MS + 1)).toBeNull();
  });

  it("clearFlow removes it entirely", () => {
    persist(started());
    clearFlow();
    expect(loadResumable()).toBeNull();
    expect(loadPersisted()).toBeNull();
  });

  it("startFlowAs still wipes a draft — a new door pick is never contaminated", () => {
    persist(started());
    startFlowAs("self");
    const after = loadPersisted()!;
    expect(after.sender).toBe("self");
    expect(after.destinationAddress.street).toBe("");
    expect(loadResumable()).toBeNull();
  });
});
