import type { LinkData } from "@/lib/api";

// What this particular sender is being asked to supply.
//
// The creator's three skips are not stored on the link as flags — they are
// implied by what the link does and does not carry, which is the safer
// encoding: the sender flow asks for a field when the field is genuinely
// absent, so a mis-set flag can never cause it to skip collecting something
// the label needs.
//
//   destination — `needs_destination` (Phase 3, migration 042)
//   origin      — no `origin_prefill`  (2026-08-18, migration 041)
//   package     — no `package_prefill`
//
// One derivation, shared by the progress bar, the intro headline and the
// package header, so those three cannot disagree about what is being asked.
// They did disagree before this existed: the bar showed a fixed step count
// while the intro described a scenario.

export interface SenderScenario {
  needsDestination: boolean;
  needsOrigin: boolean;
  needsPackage: boolean;
}

export function senderScenario(link: LinkData): SenderScenario {
  return {
    needsDestination: link.needs_destination === true,
    // Seller links carry no origin_prefill by design (the origin is the
    // seller's and the reader is a stranger), so this is only meaningful for
    // flexible links — which is the only place the sender flow uses it.
    needsOrigin: !link.origin_prefill,
    needsPackage: !link.package_prefill,
  };
}

/**
 * The progress bar's label for the collection step, per the design handoff:
 * "Package" (nothing else needed), "Your info" (origin + package),
 * "Destination & info" (nothing prefilled).
 */
export function collectionStepLabel(s: SenderScenario): string {
  if (s.needsDestination) return "Destination & info";
  if (s.needsOrigin) return "Your info";
  return "Package";
}

/**
 * The intro's subhead — what this sender is actually about to do. Written as
 * a promise about their effort, not a description of the data model: a
 * sender does not know or care which party "deferred" what.
 */
export function senderIntroSubhead(s: SenderScenario): string {
  if (s.needsDestination && s.needsOrigin) {
    return "You'll add the delivery address, your own details, and what's inside — then print the label.";
  }
  if (s.needsDestination) {
    return "You'll choose where it goes and describe what's inside — then print the label.";
  }
  if (s.needsOrigin && s.needsPackage) {
    return "You'll add your details and describe what's inside — everything else is set.";
  }
  if (s.needsOrigin) {
    return "You'll add your details — everything else is set.";
  }
  if (s.needsPackage) {
    return "You'll describe what's inside — everything else is set.";
  }
  // Nothing outstanding: a full prepaid label, already complete.
  return "Everything's set — print the label and ship it.";
}
