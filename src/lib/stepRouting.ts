import type { RecipientPath } from "@/lib/types";

// ─── URL Structure ──────────────────────────────────────────
//
// ONE step map (2026-08-19, flow-redesign proposal — completes Phase 2 of the
// unified-onboarding proposal, whose scope line reads "unify /onboarding/*
// routes into one step map with link_type computed at the end"). Both path
// segments walk the SAME sequence; the segment (`full-label` ⇄ `flexible`)
// only names the product the flow is currently heading toward, and rewrites
// when the first skip lands or the last one is undone.
//
//   /onboarding                          → resume offer if a draft exists, else redirects to full-label/destination
//   /onboarding/<path>/destination       → step 1   (recipient + email)
//   /onboarding/<path>/origin            → step 10  (ship-from address)
//   /onboarding/<path>/package           → step 14  (parcel details)
//   /onboarding/<path>/shipping          → step 20  (rates when everything is known; speed/cap preferences when anything was skipped)
//   /onboarding/<path>/verify            → step 11  (Supabase OTP — the design's "Contact" step; slug stays `verify`
//                                                    because magic-link emails already in inboxes carry it as redirectTo)
//   /onboarding/<path>/payment           → step 12  (charge now, or save card)
//   /onboarding/<path>/label             → step 13  (done — label to print, or link to share)
//
// Step numbers are HISTORICAL, not ordinal — sequence comes from STEPS below.
// They are kept (1/10/14/20/11/12/13) so persisted drafts' completedSteps stay
// meaningful: every full-label number survives unchanged, and old flex numbers
// (21/22/23) are migrated in recipientFlowStorage.readStored.
//
// `path` (full-label | flexible) is the URL segment; `RecipientPath` enum
// uses `full_label` (underscore) — convert at the boundary.

export type PathSlug = "full-label" | "flexible";
export type StepSlug =
  | "destination"
  | "origin"
  | "package"
  | "shipping"
  | "verify"
  | "payment"
  | "label";

export function pathSlugToPath(slug: string): RecipientPath | null {
  if (slug === "full-label") return "full_label";
  if (slug === "flexible") return "flexible";
  return null;
}

export function pathToPathSlug(path: RecipientPath): PathSlug {
  return path === "full_label" ? "full-label" : "flexible";
}

// ─── The Step Map ───────────────────────────────────────────

const STEP_BY_SLUG: Record<string, number> = {
  destination: 1,
  origin: 10,
  package: 14,
  shipping: 20,
  verify: 11,
  payment: 12,
  label: 13,
};

const SLUG_BY_STEP: Record<number, StepSlug> = {
  1: "destination",
  10: "origin",
  14: "package",
  20: "shipping",
  11: "verify",
  12: "payment",
  13: "label",
};

// Retired slugs → the live slug that asks the same question now. Every URL
// that ever circulated must keep resolving (decided 2026-08-17 OQ2; PR #68
// preserved the same property through the step-10 split):
//   preferences (old flex step 20) → shipping — the same screen, now one step
//     both paths share (rates when everything is known, preferences when not).
//   authorize   (old flex step 22) → payment — save-card IS the payment step.
//   share       (old flex step 23) → label   — the done screen.
// `verify` never retires — see the URL-structure comment. Old
// /full-label/shipping URLs resolve without an entry here because `shipping`
// is still a live slug; the access guard walks any deep link to the first
// incomplete step regardless, so position — not slug survival — is what the
// guard already normalizes.
export const RETIRED_SLUG_REDIRECTS: Record<string, StepSlug> = {
  preferences: "shipping",
  authorize: "payment",
  share: "label",
};

// Signature keeps the path argument for call-site stability (4 importers +
// the specs); one map means it no longer affects the answer.
export function slugToStep(path: RecipientPath | null, slug: string | null | undefined): number {
  void path;
  if (!slug) return 0;
  const live = STEP_BY_SLUG[slug];
  if (live !== undefined) return live;
  // Retired slugs resolve to their replacement's step so the guard can reason
  // about the redirect target before the URL is rewritten.
  const retired = RETIRED_SLUG_REDIRECTS[slug];
  return retired ? STEP_BY_SLUG[retired] : 0;
}

export function stepToSlug(path: RecipientPath | null, step: number): StepSlug | null {
  void path;
  if (step === 0) return null;
  return SLUG_BY_STEP[step] ?? null;
}

export function stepUrl(path: RecipientPath | null, step: number): string {
  if (step === 0 || !path) return "/onboarding";
  const slug = stepToSlug(path, step);
  if (!slug) return "/onboarding";
  return `/onboarding/${pathToPathSlug(path)}/${slug}`;
}

// ─── Step Ordering ──────────────────────────────────────────

// No step 0 (2026-08-18): the who's-sending picker is gone; /onboarding
// resolves straight to the destination step. Step 0 survives only as the
// "no step" value in stepUrl/canAccessStep and as inert entries in old
// persisted drafts' completedSteps.
const STEPS = [1, 10, 14, 20, 11, 12, 13];

export function stepsForPath(path: RecipientPath | null): number[] {
  void path;
  return STEPS;
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

// ─── Path Derivation ────────────────────────────────────────

// The product is a pure function of the three skip flags: anything handed to
// the sender means the price is unknowable, so the flow is a shipping link.
// The URL segment tracks this on every navigation — it rewrites when the
// first skip lands and rewrites back when the last one is undone (§2.2 of the
// 2026-08-19 flow-redesign proposal). ONE definition so the context's
// navigation calls and any future caller cannot disagree about the fork.
export function pathForFlags(flags: {
  deferredDestination: boolean;
  deferredOrigin: boolean;
  deferredPackage: boolean;
}): RecipientPath {
  return flags.deferredDestination || flags.deferredOrigin || flags.deferredPackage
    ? "flexible"
    : "full_label";
}

// ─── Slug Validation ────────────────────────────────────────

export function isSlugValidForPath(slug: string, path: RecipientPath | null): boolean {
  if (!path) return false;
  return slugToStep(path, slug) !== 0;
}

// ─── Step Guard ─────────────────────────────────────────────

// Load-bearing: read by the page-level guard in `RecipientOnboarding.tsx`
// (`<Navigate to={firstIncompleteUrl(...)} replace />`). The guard fires on
// every render where the URL's stepSlug doesn't match a completed-or-current
// state, so this function MUST be checked against the latest committed
// completedSteps — never a stale snapshot.
//
// Footgun: if a caller does `setData(completedSteps += step); navigate(stepUrl(next))`,
// the URL changes synchronously (`history.pushState`) while setData is still
// queued. The guard then runs with OLD completedSteps against NEW URL and
// returns false → bounce. See LOG.md → 2026-05-19 "navigate vs setData race"
// + PLAYBOOK Rule 20 "Telemetry before browser." Fix: wrap the setData in
// `flushSync` from react-dom before calling navigate (see `tryAdvance` in
// `RecipientFlowContext.tsx`).
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
