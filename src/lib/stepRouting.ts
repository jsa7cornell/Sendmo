import type { RecipientPath } from "@/lib/types";

// ─── Slug ↔ Step Mappings ───────────────────────────────────

export type RecipientSlug =
  | "address"
  | "shipping"
  | "payment"
  | "label"
  | "preferences"
  | "verify"
  | "authorize"
  | "link-ready";

const SLUG_TO_STEP: Record<RecipientSlug, number> = {
  address: 1,
  shipping: 10,
  payment: 11,
  label: 12,
  preferences: 20,
  verify: 21,
  authorize: 22,
  "link-ready": 23,
};

const STEP_TO_SLUG: Record<number, RecipientSlug> = {
  1: "address",
  10: "shipping",
  11: "payment",
  12: "label",
  20: "preferences",
  21: "verify",
  22: "authorize",
  23: "link-ready",
};

export function slugToStep(slug: string): number | null {
  return SLUG_TO_STEP[slug as RecipientSlug] ?? null;
}

export function stepToSlug(step: number): RecipientSlug | null {
  return STEP_TO_SLUG[step] ?? null;
}

// ─── Step Ordering ──────────────────────────────────────────

const FULL_LABEL_STEPS = [0, 1, 10, 11, 12];
const FLEX_LINK_STEPS = [0, 1, 20, 21, 22, 23];

export function stepsForPath(path: RecipientPath | null): number[] {
  return path === "flexible" ? FLEX_LINK_STEPS : FULL_LABEL_STEPS;
}

export function nextStep(current: number, path: RecipientPath | null): number | null {
  const steps = stepsForPath(path);
  const idx = steps.indexOf(current);
  return idx >= 0 && idx < steps.length - 1 ? steps[idx + 1] : null;
}

export function prevStep(current: number, path: RecipientPath | null): number | null {
  const steps = stepsForPath(path);
  const idx = steps.indexOf(current);
  return idx > 0 ? steps[idx - 1] : null;
}

export function stepIndex(step: number, path: RecipientPath | null): number {
  return stepsForPath(path).indexOf(step);
}

// ─── Progress Bar Mapping ───────────────────────────────────

const STEP_TO_PROGRESS: Record<number, number> = {
  0: -1,
  1: 0,
  10: 1,
  11: 2,
  12: 3,
  20: 1,
  21: 2,
  22: 2,
  23: 3,
};

export function stepToProgressIndex(step: number): number {
  return STEP_TO_PROGRESS[step] ?? -1;
}

export function progressIndexToStep(index: number, path: RecipientPath | null): number {
  if (path === "flexible") {
    return [1, 20, 21, 23][index] ?? 1;
  }
  return [1, 10, 11, 12][index] ?? 1;
}

// ─── Slug Validation for Path ───────────────────────────────

const FULL_LABEL_SLUGS: RecipientSlug[] = ["address", "shipping", "payment", "label"];
const FLEX_LINK_SLUGS: RecipientSlug[] = ["address", "preferences", "verify", "authorize", "link-ready"];

export function isSlugValidForPath(slug: string, path: RecipientPath | null): boolean {
  if (slug === "address") return true; // shared by both paths
  if (path === "flexible") return FLEX_LINK_SLUGS.includes(slug as RecipientSlug);
  if (path === "full_label") return FULL_LABEL_SLUGS.includes(slug as RecipientSlug);
  return false; // no path selected yet — only index (step 0) is valid
}

// ─── Step Guard Logic ───────────────────────────────────────

export function canAccessStep(step: number, completedSteps: number[], path: RecipientPath | null): boolean {
  if (step === 0) return true;
  const steps = stepsForPath(path);
  const idx = steps.indexOf(step);
  if (idx < 0) return false;
  // All prior steps must be completed
  for (let i = 0; i < idx; i++) {
    if (!completedSteps.includes(steps[i])) return false;
  }
  return true;
}

export function firstIncompleteSlug(completedSteps: number[], path: RecipientPath | null): string | null {
  const steps = stepsForPath(path);
  for (const step of steps) {
    if (!completedSteps.includes(step)) {
      return stepToSlug(step); // null for step 0 → means go to index
    }
  }
  return null;
}
