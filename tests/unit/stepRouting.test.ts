import { describe, it, expect } from "vitest";
import {
  slugToStep,
  stepToSlug,
  stepsForPath,
  nextStep,
  prevStep,
  stepToProgressIndex,
  progressIndexToStep,
  canAccessStep,
  firstIncompleteSlug,
  isSlugValidForPath,
} from "@/lib/stepRouting";

// ─── slugToStep / stepToSlug ────────────────────────────────

describe("slugToStep", () => {
  it("maps known slugs to step numbers", () => {
    expect(slugToStep("address")).toBe(1);
    expect(slugToStep("shipping")).toBe(10);
    expect(slugToStep("payment")).toBe(11);
    expect(slugToStep("label")).toBe(12);
    expect(slugToStep("preferences")).toBe(20);
    expect(slugToStep("verify")).toBe(21);
    expect(slugToStep("authorize")).toBe(22);
    expect(slugToStep("link-ready")).toBe(23);
  });

  it("returns null for unknown slugs", () => {
    expect(slugToStep("unknown")).toBeNull();
    expect(slugToStep("")).toBeNull();
  });
});

describe("stepToSlug", () => {
  it("maps step numbers to slugs", () => {
    expect(stepToSlug(1)).toBe("address");
    expect(stepToSlug(10)).toBe("shipping");
    expect(stepToSlug(12)).toBe("label");
    expect(stepToSlug(23)).toBe("link-ready");
  });

  it("returns null for step 0 (index route)", () => {
    expect(stepToSlug(0)).toBeNull();
  });
});

// ─── Step ordering ──────────────────────────────────────────

describe("stepsForPath", () => {
  it("returns full label steps for full_label", () => {
    expect(stepsForPath("full_label")).toEqual([0, 1, 10, 11, 12]);
  });

  it("returns flex steps for flexible", () => {
    expect(stepsForPath("flexible")).toEqual([0, 1, 20, 21, 22, 23]);
  });

  it("defaults to full label when path is null", () => {
    expect(stepsForPath(null)).toEqual([0, 1, 10, 11, 12]);
  });
});

describe("nextStep / prevStep", () => {
  it("returns next step in full label path", () => {
    expect(nextStep(0, "full_label")).toBe(1);
    expect(nextStep(1, "full_label")).toBe(10);
    expect(nextStep(10, "full_label")).toBe(11);
    expect(nextStep(12, "full_label")).toBeNull();
  });

  it("returns prev step in flexible path", () => {
    expect(prevStep(23, "flexible")).toBe(22);
    expect(prevStep(20, "flexible")).toBe(1);
    expect(prevStep(0, "flexible")).toBeNull();
  });
});

// ─── Progress bar mapping ───────────────────────────────────

describe("stepToProgressIndex", () => {
  it("maps steps to progress bar indexes", () => {
    expect(stepToProgressIndex(0)).toBe(-1);
    expect(stepToProgressIndex(1)).toBe(0);
    expect(stepToProgressIndex(10)).toBe(1);
    expect(stepToProgressIndex(11)).toBe(2);
    expect(stepToProgressIndex(12)).toBe(3);
  });
});

describe("progressIndexToStep", () => {
  it("maps progress index back to step for full_label", () => {
    expect(progressIndexToStep(0, "full_label")).toBe(1);
    expect(progressIndexToStep(1, "full_label")).toBe(10);
    expect(progressIndexToStep(2, "full_label")).toBe(11);
    expect(progressIndexToStep(3, "full_label")).toBe(12);
  });

  it("maps progress index back to step for flexible", () => {
    expect(progressIndexToStep(0, "flexible")).toBe(1);
    expect(progressIndexToStep(1, "flexible")).toBe(20);
    expect(progressIndexToStep(3, "flexible")).toBe(23);
  });
});

// ─── Step guard logic ───────────────────────────────────────

describe("canAccessStep", () => {
  it("always allows step 0", () => {
    expect(canAccessStep(0, [], null)).toBe(true);
  });

  it("allows step 1 when step 0 is completed", () => {
    expect(canAccessStep(1, [0], "full_label")).toBe(true);
  });

  it("blocks step 1 when step 0 is not completed", () => {
    expect(canAccessStep(1, [], "full_label")).toBe(false);
  });

  it("allows step 10 when 0 and 1 are completed", () => {
    expect(canAccessStep(10, [0, 1], "full_label")).toBe(true);
  });

  it("blocks step 10 when only step 0 is completed", () => {
    expect(canAccessStep(10, [0], "full_label")).toBe(false);
  });

  it("blocks steps not in the path", () => {
    expect(canAccessStep(20, [0, 1], "full_label")).toBe(false);
  });
});

describe("firstIncompleteSlug", () => {
  it("returns address when no steps completed (path selected)", () => {
    expect(firstIncompleteSlug([], "full_label")).toBeNull(); // step 0 is first, no slug
  });

  it("returns address when only step 0 completed", () => {
    expect(firstIncompleteSlug([0], "full_label")).toBe("address");
  });

  it("returns shipping when steps 0,1 completed", () => {
    expect(firstIncompleteSlug([0, 1], "full_label")).toBe("shipping");
  });

  it("returns null when all steps completed", () => {
    expect(firstIncompleteSlug([0, 1, 10, 11, 12], "full_label")).toBeNull();
  });
});

// ─── Slug validity for path ─────────────────────────────────

describe("isSlugValidForPath", () => {
  it("address is valid for both paths", () => {
    expect(isSlugValidForPath("address", "full_label")).toBe(true);
    expect(isSlugValidForPath("address", "flexible")).toBe(true);
  });

  it("shipping is only valid for full_label", () => {
    expect(isSlugValidForPath("shipping", "full_label")).toBe(true);
    expect(isSlugValidForPath("shipping", "flexible")).toBe(false);
  });

  it("preferences is only valid for flexible", () => {
    expect(isSlugValidForPath("preferences", "flexible")).toBe(true);
    expect(isSlugValidForPath("preferences", "full_label")).toBe(false);
  });

  it("address is valid even when no path selected (shared step)", () => {
    expect(isSlugValidForPath("address", null)).toBe(true);
  });

  it("path-specific slugs are invalid when no path selected", () => {
    expect(isSlugValidForPath("shipping", null)).toBe(false);
    expect(isSlugValidForPath("preferences", null)).toBe(false);
  });
});
