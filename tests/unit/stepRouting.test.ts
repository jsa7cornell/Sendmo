import { describe, it, expect } from "vitest";
import {
  slugToStep,
  stepToSlug,
  stepsForPath,
  nextStep,
  prevStep,
  canAccessStep,
  firstIncompleteUrl,
  isSlugValidForPath,
  pathSlugToPath,
  pathToPathSlug,
  pathForFlags,
  stepUrl,
  RETIRED_SLUG_REDIRECTS,
} from "@/lib/stepRouting";

// ONE step map since 2026-08-19 (flow-redesign proposal — completes the
// unified-onboarding proposal's Phase 2). Both path segments walk the same
// sequence [1, 10, 14, 20, 11, 12, 13]; the segment only names the product
// the flow is heading toward. Step numbers are historical, not ordinal —
// they survive so persisted drafts stay meaningful.

const SEQUENCE = [1, 10, 14, 20, 11, 12, 13];

describe("pathSlugToPath / pathToPathSlug", () => {
  it("converts URL path-slug to RecipientPath", () => {
    expect(pathSlugToPath("full-label")).toBe("full_label");
    expect(pathSlugToPath("flexible")).toBe("flexible");
    expect(pathSlugToPath("unknown")).toBeNull();
  });

  it("converts RecipientPath back to URL slug", () => {
    expect(pathToPathSlug("full_label")).toBe("full-label");
    expect(pathToPathSlug("flexible")).toBe("flexible");
  });
});

describe("slugToStep — one map, any segment", () => {
  it("maps every live slug to its step, identically on both segments", () => {
    for (const path of ["full_label", "flexible"] as const) {
      expect(slugToStep(path, "destination")).toBe(1);
      expect(slugToStep(path, "origin")).toBe(10);
      expect(slugToStep(path, "package")).toBe(14);
      expect(slugToStep(path, "shipping")).toBe(20);
      expect(slugToStep(path, "verify")).toBe(11);
      expect(slugToStep(path, "payment")).toBe(12);
      expect(slugToStep(path, "label")).toBe(13);
    }
  });

  it("resolves retired slugs to their replacement's step (guard can reason pre-redirect)", () => {
    expect(slugToStep("flexible", "preferences")).toBe(20);
    expect(slugToStep("flexible", "authorize")).toBe(12);
    expect(slugToStep("flexible", "share")).toBe(13);
    // The retired slugs resolve on the full-label segment too — the old
    // "invalid combination" rejection inverted when the maps unified.
    expect(slugToStep("full_label", "preferences")).toBe(20);
  });

  it("returns 0 for unknown slugs or empty slug", () => {
    expect(slugToStep("full_label", "unknown")).toBe(0);
    expect(slugToStep("full_label", "")).toBe(0);
    expect(slugToStep(null, null)).toBe(0);
    expect(slugToStep(null, undefined)).toBe(0);
  });

  it("is path-independent (null path behaves like either segment)", () => {
    expect(slugToStep(null, "destination")).toBe(1);
    expect(slugToStep(null, "shipping")).toBe(20);
    expect(slugToStep(null, "verify")).toBe(11);
  });
});

describe("RETIRED_SLUG_REDIRECTS", () => {
  it("covers exactly the three retired slugs", () => {
    expect(Object.keys(RETIRED_SLUG_REDIRECTS).sort()).toEqual(["authorize", "preferences", "share"]);
  });

  it("every redirect target is a live slug", () => {
    for (const target of Object.values(RETIRED_SLUG_REDIRECTS)) {
      expect(slugToStep(null, target)).toBeGreaterThan(0);
      expect(RETIRED_SLUG_REDIRECTS[target]).toBeUndefined();
    }
  });

  it("verify is NOT retired — magic-link emails in flight carry it as redirectTo", () => {
    expect(RETIRED_SLUG_REDIRECTS["verify"]).toBeUndefined();
    expect(slugToStep(null, "verify")).toBe(11);
  });
});

describe("stepToSlug", () => {
  it("maps every step to its slug, identically on both segments", () => {
    for (const path of ["full_label", "flexible"] as const) {
      expect(stepToSlug(path, 1)).toBe("destination");
      expect(stepToSlug(path, 10)).toBe("origin");
      expect(stepToSlug(path, 14)).toBe("package");
      expect(stepToSlug(path, 20)).toBe("shipping");
      expect(stepToSlug(path, 11)).toBe("verify");
      expect(stepToSlug(path, 12)).toBe("payment");
      expect(stepToSlug(path, 13)).toBe("label");
    }
  });

  it("returns null for step 0 (no-step value) and out-of-range steps", () => {
    expect(stepToSlug("full_label", 0)).toBeNull();
    expect(stepToSlug("full_label", 99)).toBeNull();
    // The old flex numbers no longer exist — drafts carrying them are
    // migrated on read (recipientFlowStorage LEGACY_STEP_MAP).
    expect(stepToSlug("flexible", 21)).toBeNull();
    expect(stepToSlug("flexible", 22)).toBeNull();
    expect(stepToSlug("flexible", 23)).toBeNull();
  });

  it("round-trips with slugToStep for every step in the sequence", () => {
    for (const step of SEQUENCE) {
      const slug = stepToSlug(null, step);
      expect(slug).not.toBeNull();
      expect(slugToStep(null, slug)).toBe(step);
    }
  });
});

describe("stepsForPath — one sequence", () => {
  it("returns the unified sequence for both paths and for null", () => {
    expect(stepsForPath("full_label")).toEqual(SEQUENCE);
    expect(stepsForPath("flexible")).toEqual(SEQUENCE);
    expect(stepsForPath(null)).toEqual(SEQUENCE);
  });

  it("has no step 0 and seven steps", () => {
    expect(stepsForPath(null)).not.toContain(0);
    expect(stepsForPath(null)).toHaveLength(7);
  });
});

describe("nextStep / prevStep", () => {
  it("next walks the whole sequence in order", () => {
    expect(nextStep(1, "full_label")).toBe(10);
    expect(nextStep(10, "full_label")).toBe(14);
    expect(nextStep(14, "full_label")).toBe(20);
    expect(nextStep(20, "full_label")).toBe(11);
    expect(nextStep(11, "full_label")).toBe(12);
    expect(nextStep(12, "full_label")).toBe(13);
    expect(nextStep(13, "full_label")).toBeNull();
  });

  it("walks identically on the flexible segment", () => {
    expect(nextStep(1, "flexible")).toBe(10);
    expect(nextStep(14, "flexible")).toBe(20);
    expect(nextStep(20, "flexible")).toBe(11);
    expect(nextStep(12, "flexible")).toBe(13);
  });

  it("prev walks the sequence backward, ending at the first step", () => {
    expect(prevStep(13, "flexible")).toBe(12);
    expect(prevStep(12, "flexible")).toBe(11);
    expect(prevStep(11, "flexible")).toBe(20);
    expect(prevStep(20, "flexible")).toBe(14);
    expect(prevStep(14, "flexible")).toBe(10);
    expect(prevStep(10, "flexible")).toBe(1);
    expect(prevStep(1, "flexible")).toBeNull();
  });

  it("returns null for steps not in the sequence", () => {
    expect(nextStep(21, "flexible")).toBeNull();
    expect(prevStep(0, "full_label")).toBeNull();
  });
});

describe("pathForFlags — the product is a function of the skips", () => {
  it("no skips → full_label", () => {
    expect(pathForFlags({ deferredDestination: false, deferredOrigin: false, deferredPackage: false })).toBe("full_label");
  });

  it("any single skip → flexible", () => {
    expect(pathForFlags({ deferredDestination: true, deferredOrigin: false, deferredPackage: false })).toBe("flexible");
    expect(pathForFlags({ deferredDestination: false, deferredOrigin: true, deferredPackage: false })).toBe("flexible");
    expect(pathForFlags({ deferredDestination: false, deferredOrigin: false, deferredPackage: true })).toBe("flexible");
  });

  it("every multi-skip combination → flexible (all 2^3 checked)", () => {
    for (const d of [true, false]) for (const o of [true, false]) for (const p of [true, false]) {
      const expected = d || o || p ? "flexible" : "full_label";
      expect(pathForFlags({ deferredDestination: d, deferredOrigin: o, deferredPackage: p })).toBe(expected);
    }
  });
});



describe("stepUrl", () => {
  it("builds the segment-scoped URL for any step", () => {
    expect(stepUrl("full_label", 1)).toBe("/onboarding/full-label/destination");
    expect(stepUrl("full_label", 10)).toBe("/onboarding/full-label/origin");
    expect(stepUrl("full_label", 14)).toBe("/onboarding/full-label/package");
    expect(stepUrl("full_label", 20)).toBe("/onboarding/full-label/shipping");
    expect(stepUrl("flexible", 20)).toBe("/onboarding/flexible/shipping");
    expect(stepUrl("flexible", 11)).toBe("/onboarding/flexible/verify");
    expect(stepUrl("flexible", 12)).toBe("/onboarding/flexible/payment");
    expect(stepUrl("flexible", 13)).toBe("/onboarding/flexible/label");
  });

  it("falls back to /onboarding for step 0, null path, or unknown steps", () => {
    expect(stepUrl("full_label", 0)).toBe("/onboarding");
    expect(stepUrl(null, 1)).toBe("/onboarding");
    expect(stepUrl("flexible", 99)).toBe("/onboarding");
  });
});

describe("isSlugValidForPath", () => {
  it("accepts every live slug on both segments", () => {
    for (const path of ["full_label", "flexible"] as const) {
      for (const slug of ["destination", "origin", "package", "shipping", "verify", "payment", "label"]) {
        expect(isSlugValidForPath(slug, path)).toBe(true);
      }
    }
  });

  it("accepts retired slugs (they resolve via redirect, not a bounce)", () => {
    expect(isSlugValidForPath("preferences", "flexible")).toBe(true);
    expect(isSlugValidForPath("authorize", "flexible")).toBe(true);
    expect(isSlugValidForPath("share", "flexible")).toBe(true);
  });

  it("rejects unknown slugs and null path", () => {
    expect(isSlugValidForPath("unknown", "full_label")).toBe(false);
    expect(isSlugValidForPath("destination", null)).toBe(false);
  });
});

describe("canAccessStep — sequential gate over one sequence", () => {
  it("always allows step 0", () => {
    expect(canAccessStep(0, [], "full_label")).toBe(true);
  });

  it("always allows step 1 — it is the first step", () => {
    expect(canAccessStep(1, [], "full_label")).toBe(true);
    expect(canAccessStep(1, [], "flexible")).toBe(true);
  });

  it("allows each step exactly when every prior step is complete", () => {
    expect(canAccessStep(10, [1], "full_label")).toBe(true);
    expect(canAccessStep(14, [1, 10], "full_label")).toBe(true);
    expect(canAccessStep(20, [1, 10, 14], "flexible")).toBe(true);
    expect(canAccessStep(11, [1, 10, 14, 20], "flexible")).toBe(true);
    expect(canAccessStep(12, [1, 10, 14, 20, 11], "full_label")).toBe(true);
    expect(canAccessStep(13, [1, 10, 14, 20, 11, 12], "flexible")).toBe(true);
  });

  it("blocks any step with an incomplete predecessor", () => {
    expect(canAccessStep(10, [], "full_label")).toBe(false);
    expect(canAccessStep(14, [1], "full_label")).toBe(false);
    expect(canAccessStep(20, [1, 10], "flexible")).toBe(false);
    expect(canAccessStep(11, [1, 10, 14], "full_label")).toBe(false);
    expect(canAccessStep(12, [1, 10, 14, 20], "flexible")).toBe(false);
    expect(canAccessStep(13, [1, 10, 14, 20, 11], "full_label")).toBe(false);
  });

  it("a deferred flow reaches shipping the same way — skips mark 10/14 complete", () => {
    // deferToSender marks the skipped step complete; the guard neither knows
    // nor cares that the completion came from a skip.
    expect(canAccessStep(20, [1, 10, 14], "flexible")).toBe(true);
  });

  it("blocks steps not in the sequence (old flex numbers)", () => {
    expect(canAccessStep(21, [1, 10, 14, 20], "flexible")).toBe(false);
    expect(canAccessStep(23, [1, 10, 14, 20, 11, 12], "flexible")).toBe(false);
  });

  it("tolerates inert extras in completedSteps (step 0 from old drafts)", () => {
    expect(canAccessStep(10, [0, 1], "full_label")).toBe(true);
  });
});

describe("firstIncompleteUrl", () => {
  it("returns /onboarding when no path selected", () => {
    expect(firstIncompleteUrl([], null)).toBe("/onboarding");
  });

  it("walks the sequence to the first gap", () => {
    expect(firstIncompleteUrl([], "full_label")).toBe("/onboarding/full-label/destination");
    expect(firstIncompleteUrl([1], "full_label")).toBe("/onboarding/full-label/origin");
    expect(firstIncompleteUrl([1, 10], "full_label")).toBe("/onboarding/full-label/package");
    expect(firstIncompleteUrl([1, 10, 14], "flexible")).toBe("/onboarding/flexible/shipping");
    expect(firstIncompleteUrl([1, 10, 14, 20], "flexible")).toBe("/onboarding/flexible/verify");
    expect(firstIncompleteUrl([1, 10, 14, 20, 11], "full_label")).toBe("/onboarding/full-label/payment");
  });

  it("lands on the last step when everything is complete", () => {
    expect(firstIncompleteUrl([1, 10, 14, 20, 11, 12, 13], "flexible")).toBe("/onboarding/flexible/label");
  });

  it("ignores inert old-draft entries (0 and unmigrated 21-23 don't advance it)", () => {
    expect(firstIncompleteUrl([0, 1, 21], "flexible")).toBe("/onboarding/flexible/origin");
  });
});
