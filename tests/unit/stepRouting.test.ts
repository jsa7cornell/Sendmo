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
  firstIncompleteUrl,
  isSlugValidForPath,
  pathSlugToPath,
  pathToPathSlug,
  stepUrl,
} from "@/lib/stepRouting";

// The stepRouting API moved from flat single-arg helpers to a path-aware
// two-arg shape in late 2026-04. These tests exercise the current shape:
//   slugToStep(path, slug) → number
//   stepToSlug(path, step) → slug | null
//   firstIncompleteUrl(completedSteps, path) → "/onboarding/{slug}/{slug}"

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

describe("slugToStep", () => {
  it("maps full-label slugs to step numbers", () => {
    expect(slugToStep("full_label", "destination")).toBe(1);
    expect(slugToStep("full_label", "shipping")).toBe(10);
    expect(slugToStep("full_label", "verify")).toBe(11);
    expect(slugToStep("full_label", "payment")).toBe(12);
    expect(slugToStep("full_label", "label")).toBe(13);
  });

  it("maps flexible slugs to step numbers", () => {
    expect(slugToStep("flexible", "destination")).toBe(1);
    expect(slugToStep("flexible", "preferences")).toBe(20);
    expect(slugToStep("flexible", "verify")).toBe(21);
    expect(slugToStep("flexible", "authorize")).toBe(22);
    expect(slugToStep("flexible", "share")).toBe(23);
  });

  it("returns 0 for unknown slugs or empty slug", () => {
    expect(slugToStep("full_label", "unknown")).toBe(0);
    expect(slugToStep("full_label", "")).toBe(0);
    expect(slugToStep(null, null)).toBe(0);
  });

  it("falls back to the full-label map when path is null (matches stepsForPath default)", () => {
    // Source defaults to FULL_LABEL_STEP_BY_SLUG when path is null/unknown.
    expect(slugToStep(null, "destination")).toBe(1);
    expect(slugToStep(null, "shipping")).toBe(10);
  });
});

describe("stepToSlug", () => {
  it("maps step numbers to full-label slugs", () => {
    expect(stepToSlug("full_label", 1)).toBe("destination");
    expect(stepToSlug("full_label", 10)).toBe("shipping");
    expect(stepToSlug("full_label", 11)).toBe("verify");
    expect(stepToSlug("full_label", 12)).toBe("payment");
    expect(stepToSlug("full_label", 13)).toBe("label");
  });

  it("returns null for step 0 (path picker has no slug)", () => {
    expect(stepToSlug("full_label", 0)).toBeNull();
    expect(stepToSlug("flexible", 0)).toBeNull();
  });

  it("returns null for out-of-range steps", () => {
    expect(stepToSlug("full_label", 99)).toBeNull();
    expect(stepToSlug("flexible", 11)).toBeNull(); // 11 is full-label only
  });
});

describe("stepsForPath", () => {
  it("returns full-label steps including the new step 11 verify", () => {
    expect(stepsForPath("full_label")).toEqual([0, 1, 10, 11, 12, 13]);
  });

  it("returns flex steps", () => {
    expect(stepsForPath("flexible")).toEqual([0, 1, 20, 21, 22, 23]);
  });

  it("defaults to full-label when path is null", () => {
    expect(stepsForPath(null)).toEqual([0, 1, 10, 11, 12, 13]);
  });
});

describe("nextStep / prevStep", () => {
  it("next walks the full-label sequence including verify", () => {
    expect(nextStep(0, "full_label")).toBe(1);
    expect(nextStep(1, "full_label")).toBe(10);
    expect(nextStep(10, "full_label")).toBe(11);
    expect(nextStep(11, "full_label")).toBe(12);
    expect(nextStep(12, "full_label")).toBe(13);
    expect(nextStep(13, "full_label")).toBeNull();
  });

  it("prev walks the flex sequence backward", () => {
    expect(prevStep(23, "flexible")).toBe(22);
    expect(prevStep(20, "flexible")).toBe(1);
    expect(prevStep(1, "flexible")).toBe(0);
    expect(prevStep(0, "flexible")).toBeNull();
  });
});

describe("stepToProgressIndex", () => {
  it("maps full-label steps onto a 4-segment bar (verify + payment share segment 2)", () => {
    expect(stepToProgressIndex(0)).toBe(-1);
    expect(stepToProgressIndex(1)).toBe(0);
    expect(stepToProgressIndex(10)).toBe(1);
    expect(stepToProgressIndex(11)).toBe(2);
    expect(stepToProgressIndex(12)).toBe(2);
    expect(stepToProgressIndex(13)).toBe(3);
  });

  it("maps flex steps onto a 4-segment bar", () => {
    expect(stepToProgressIndex(20)).toBe(1);
    expect(stepToProgressIndex(21)).toBe(2);
    expect(stepToProgressIndex(22)).toBe(2);
    expect(stepToProgressIndex(23)).toBe(3);
  });
});

describe("progressIndexToStep", () => {
  it("maps progress index back to step for full-label (segment 2 → verify)", () => {
    expect(progressIndexToStep(0, "full_label")).toBe(1);
    expect(progressIndexToStep(1, "full_label")).toBe(10);
    expect(progressIndexToStep(2, "full_label")).toBe(11);
    expect(progressIndexToStep(3, "full_label")).toBe(13);
  });

  it("maps progress index back to step for flexible", () => {
    expect(progressIndexToStep(0, "flexible")).toBe(1);
    expect(progressIndexToStep(1, "flexible")).toBe(20);
    expect(progressIndexToStep(3, "flexible")).toBe(23);
  });
});

describe("stepUrl", () => {
  it("builds the path-scoped URL for any step", () => {
    expect(stepUrl("full_label", 0)).toBe("/onboarding");
    expect(stepUrl("full_label", 1)).toBe("/onboarding/full-label/destination");
    expect(stepUrl("full_label", 11)).toBe("/onboarding/full-label/verify");
    expect(stepUrl("full_label", 12)).toBe("/onboarding/full-label/payment");
    expect(stepUrl("flexible", 21)).toBe("/onboarding/flexible/verify");
    expect(stepUrl(null, 1)).toBe("/onboarding");
  });
});

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

  it("blocks step 11 (verify) when shipping (10) is not completed", () => {
    expect(canAccessStep(11, [0, 1], "full_label")).toBe(false);
  });

  it("allows step 11 when 0, 1, 10 are completed", () => {
    expect(canAccessStep(11, [0, 1, 10], "full_label")).toBe(true);
  });

  it("blocks steps not in the path", () => {
    expect(canAccessStep(20, [0, 1], "full_label")).toBe(false);
  });
});

describe("firstIncompleteUrl", () => {
  it("returns /onboarding when no path selected", () => {
    expect(firstIncompleteUrl([], null)).toBe("/onboarding");
  });

  it("returns the destination URL when only step 0 is completed", () => {
    expect(firstIncompleteUrl([0], "full_label")).toBe("/onboarding/full-label/destination");
  });

  it("returns the shipping URL when steps 0 and 1 are completed", () => {
    expect(firstIncompleteUrl([0, 1], "full_label")).toBe("/onboarding/full-label/shipping");
  });

  it("returns the verify URL when through shipping is completed", () => {
    expect(firstIncompleteUrl([0, 1, 10], "full_label")).toBe("/onboarding/full-label/verify");
  });

  it("returns the last step URL when everything is completed", () => {
    expect(firstIncompleteUrl([0, 1, 10, 11, 12, 13], "full_label")).toBe(
      "/onboarding/full-label/label",
    );
  });
});

describe("isSlugValidForPath", () => {
  it("destination is valid for both paths", () => {
    expect(isSlugValidForPath("destination", "full_label")).toBe(true);
    expect(isSlugValidForPath("destination", "flexible")).toBe(true);
  });

  it("shipping is only valid for full_label", () => {
    expect(isSlugValidForPath("shipping", "full_label")).toBe(true);
    expect(isSlugValidForPath("shipping", "flexible")).toBe(false);
  });

  it("preferences is only valid for flexible", () => {
    expect(isSlugValidForPath("preferences", "flexible")).toBe(true);
    expect(isSlugValidForPath("preferences", "full_label")).toBe(false);
  });

  it("verify is valid for both paths (full-label step 11 + flex step 21)", () => {
    expect(isSlugValidForPath("verify", "full_label")).toBe(true);
    expect(isSlugValidForPath("verify", "flexible")).toBe(true);
  });

  it("any slug is invalid when no path is selected", () => {
    expect(isSlugValidForPath("destination", null)).toBe(false);
    expect(isSlugValidForPath("shipping", null)).toBe(false);
  });
});
