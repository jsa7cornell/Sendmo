import type { RecipientPath } from "@/lib/types";

// ─── URL Structure ──────────────────────────────────────────
//
// All routes are path-scoped and self-describing:
//
//   /onboarding                          → path picker (step 0)
//   /onboarding/full-label/destination   → step 1 (recipient + email)
//   /onboarding/full-label/shipping      → step 10
//   /onboarding/full-label/verify        → step 11  (Supabase OTP — proposal 2026-05-11_account-creation-timing)
//   /onboarding/full-label/payment       → step 12
//   /onboarding/full-label/label         → step 13
//   /onboarding/flexible/destination     → step 1
//   /onboarding/flexible/preferences     → step 20
//   /onboarding/flexible/verify          → step 21
//   /onboarding/flexible/authorize       → step 22
//   /onboarding/flexible/share           → step 23
//
// `path` (full-label | flexible) is the URL segment; `RecipientPath` enum
// uses `full_label` (underscore) — convert at the boundary.

export type PathSlug = "full-label" | "flexible";
export type StepSlug =
  | "destination"
  | "shipping"
  | "payment"
  | "label"
  | "preferences"
  | "verify"
  | "authorize"
  | "share";

// Verify slug is shared between full-label (step 11) and flex (step 21) —
// both now use Supabase Auth OTP (RecipientStepEmailVerifySupabase /
// RecipientStepEmailVerifyFlex respectively).

export function pathSlugToPath(slug: string): RecipientPath | null {
  if (slug === "full-label") return "full_label";
  if (slug === "flexible") return "flexible";
  return null;
}

export function pathToPathSlug(path: RecipientPath): PathSlug {
  return path === "full_label" ? "full-label" : "flexible";
}

// ─── Step Maps (per path) ───────────────────────────────────

const FULL_LABEL_STEP_BY_SLUG: Record<string, number> = {
  destination: 1,
  shipping: 10,
  verify: 11,
  payment: 12,
  label: 13,
};

const FULL_LABEL_SLUG_BY_STEP: Record<number, StepSlug> = {
  1: "destination",
  10: "shipping",
  11: "verify",
  12: "payment",
  13: "label",
};

const FLEX_STEP_BY_SLUG: Record<string, number> = {
  destination: 1,
  preferences: 20,
  verify: 21,
  authorize: 22,
  share: 23,
};

const FLEX_SLUG_BY_STEP: Record<number, StepSlug> = {
  1: "destination",
  20: "preferences",
  21: "verify",
  22: "authorize",
  23: "share",
};

export function slugToStep(path: RecipientPath | null, slug: string | null | undefined): number {
  if (!slug) return 0;
  const map = path === "flexible" ? FLEX_STEP_BY_SLUG : FULL_LABEL_STEP_BY_SLUG;
  return map[slug] ?? 0;
}

export function stepToSlug(path: RecipientPath | null, step: number): StepSlug | null {
  if (step === 0) return null;
  const map = path === "flexible" ? FLEX_SLUG_BY_STEP : FULL_LABEL_SLUG_BY_STEP;
  return map[step] ?? null;
}

export function stepUrl(path: RecipientPath | null, step: number): string {
  if (step === 0 || !path) return "/onboarding";
  const slug = stepToSlug(path, step);
  if (!slug) return "/onboarding";
  return `/onboarding/${pathToPathSlug(path)}/${slug}`;
}

// ─── Step Ordering ──────────────────────────────────────────

const FULL_LABEL_STEPS = [0, 1, 10, 11, 12, 13];
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

// Progress bar has 4 segments. Full-label collapses verify (11) + payment (12)
// into the third segment so the visual cadence (destination/shipping/pay/label)
// stays the same after inserting the OTP step.
const STEP_TO_PROGRESS: Record<number, number> = {
  0: -1,
  1: 0,
  10: 1,
  11: 2,
  12: 2,
  13: 3,
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
  // Index 2 routes to verify (11) — payment (12) follows immediately after.
  return [1, 10, 11, 13][index] ?? 1;
}

// ─── Slug Validation ────────────────────────────────────────

export function isSlugValidForPath(slug: string, path: RecipientPath | null): boolean {
  if (!path) return false;
  return slugToStep(path, slug) !== 0;
}

// ─── Step Guard ─────────────────────────────────────────────

export function canAccessStep(step: number, completedSteps: number[], path: RecipientPath | null): boolean {
  if (step === 0) return true;
  const steps = stepsForPath(path);
  const idx = steps.indexOf(step);
  if (idx < 0) return false;
  for (let i = 0; i < idx; i++) {
    if (!completedSteps.includes(steps[i])) return false;
  }
  return true;
}

export function firstIncompleteUrl(completedSteps: number[], path: RecipientPath | null): string {
  if (!path) return "/onboarding";
  const steps = stepsForPath(path);
  for (const step of steps) {
    if (!completedSteps.includes(step)) {
      return stepUrl(path, step);
    }
  }
  return stepUrl(path, steps[steps.length - 1]);
}
