import { describe, it, expect, beforeEach } from "vitest";
import {
  DRAFT_TTL_MS,
  clearFlow,
  loadResumable,
  INITIAL_DATA,
  loadPersisted,
  persist,
  prefillSlotFor,
  startFreshFlow,
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

  it("returns NO slot while sender is unresolved — nothing prefills on a guess", () => {
    // 2026-08-18: the who's-sending step is gone, so null is the normal
    // starting state, not a deep-link edge case. Prefilling a guessed slot is
    // the wrong-party bug; the chips resolve it instead.
    expect(prefillSlotFor(null)).toBeNull();
  });
});

describe("startFreshFlow", () => {
  it("clears a previous run's data — a fresh start is never contaminated", () => {
    persist({
      ...INITIAL_DATA,
      sender: "other",
      destinationAddress: { ...INITIAL_DATA.destinationAddress, street: "1 Old Draft St" },
    });
    startFreshFlow();
    const data = loadPersisted();
    expect(data?.destinationAddress.street).toBe("");
    // sender starts unresolved — it is derived in-flow now, not at a door.
    expect(data?.sender).toBeNull();
  });
});

describe("the address escape — 'I don't have their address'", () => {
  // OQ2 option (c): both branches start on full-label and only the escape moves
  // a flow to the shipping-link path. These lock the assumptions that makes safe.
  it("lands on a step the guard actually admits", () => {
    // Deferring the origin marks step 10 complete and navigates to the package
    // question (14) on the flexible segment. If this ever fails, the skip
    // bounces the user to firstIncompleteUrl instead.
    expect(canAccessStep(14, [0, 1, 10], "flexible")).toBe(true);
    // Deferring the package (from 14) lands on the shared shipping step.
    expect(canAccessStep(20, [0, 1, 10, 14], "flexible")).toBe(true);
  });

  it("does not admit a step the user has not earned", () => {
    expect(canAccessStep(12, [0, 1], "flexible")).toBe(false);
  });

  it("targets the shared shipping step (slug renamed from preferences, 2026-08-19)", () => {
    expect(stepUrl("flexible", 20)).toBe("/onboarding/flexible/shipping");
  });

  it("returns to the origin step on undo", () => {
    expect(stepUrl("full_label", 10)).toBe("/onboarding/full-label/origin");
  });

  it("keeps every pre-existing deep link resolving", () => {
    // One step map (2026-08-19): retired slugs resolve to the live step that
    // asks the same question, so URLs minted before the change still land.
    expect(slugToStep("full_label", "destination")).toBe(1);
    expect(slugToStep("full_label", "shipping")).toBe(20);
    expect(slugToStep("flexible", "preferences")).toBe(20);
    expect(slugToStep("flexible", "authorize")).toBe(12);
    expect(slugToStep("flexible", "share")).toBe(13);
    expect(slugToStep("flexible", "verify")).toBe(11);
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

  // ── Mid-deploy compat: drafts written by the pre-2026-08-18 code ──
  // The old code wrote a BARE payload (no savedAt envelope) to SESSIONstorage.
  // A user mid-flow when the deploy lands has their draft there, in that
  // shape, and nowhere else. The original loadResumable only read the
  // localStorage envelope, so exactly these drafts were never offered.

  const LEGACY_KEY = "sendmo:recipient_flow:v1";

  it("offers a pre-deploy draft: bare shape, sessionStorage", () => {
    window.sessionStorage.setItem(LEGACY_KEY, JSON.stringify(started()));
    expect(loadResumable()?.destinationAddress.street).toBe("231 Canyon Drive");
  });

  it("offers a bare-shape draft found under the localStorage key", () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(started()));
    expect(loadResumable()).not.toBeNull();
  });

  it("prefers the localStorage draft when both stores hold one", () => {
    window.sessionStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ ...started(), email: "old@session.com" }),
    );
    persist({ ...started(), email: "new@local.com" });
    expect(loadResumable()?.email).toBe("new@local.com");
  });

  it("clearFlow kills the sessionStorage copy too — Start over must not resurrect", () => {
    window.sessionStorage.setItem(LEGACY_KEY, JSON.stringify(started()));
    persist(started());
    clearFlow();
    expect(loadResumable()).toBeNull();
  });

  it("tolerates junk in one store without hiding the draft in the other", () => {
    window.localStorage.setItem(LEGACY_KEY, "not json{");
    window.sessionStorage.setItem(LEGACY_KEY, JSON.stringify(started()));
    expect(loadResumable()).not.toBeNull();
  });

  it("startFreshFlow still wipes a draft — Start fresh is never contaminated", () => {
    persist(started());
    startFreshFlow();
    const after = loadPersisted()!;
    expect(after.sender).toBeNull();
    expect(after.destinationAddress.street).toBe("");
    expect(loadResumable()).toBeNull();
  });
});
