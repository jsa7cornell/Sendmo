// Shared state + helpers for the 5-step sender flow at /s/:shortCode.
// See proposal 2026-05-11_sender-flow-wizard for the spec; SPEC.md §8 for
// the canonical step contract.

import type { AddressInput, ShippingRate } from "@/lib/types";
import type { LinkData } from "@/lib/api";
import { classifySpeedTier } from "@/lib/utils";
import { isUsablePhone } from "@/lib/phone";

// Round 2 (proposal §11+§13): the "done" step is gone — the post-confirm
// surface is the shipment page at /t/<public_code>.
//
// 2026-08-24: the flow asks ONE question per step, and only the questions the
// link left open — mirroring the recipient flow's 2026-08-22/23 paradigm. The
// single "Package Details" mega-step (destination + origin + parcel on one
// screen, most of it pre-answered by the creator) is gone, and so is the
// progress bar, for the same reason the recipient's went: it narrated position
// instead of stating decisions. The review step's summary card states them.
export type SenderStep =
  | "intro"
  | "destination"
  | "origin"
  | "package"
  | "rates"
  | "review";

export const SENDER_STEP_ORDER: SenderStep[] = [
  "intro", "destination", "origin", "package", "rates", "review",
];

/** The three questions a link can leave open for the sender. */
export type SenderQuestion = "destination" | "origin" | "package";

export interface SenderPlan {
  /** Questions the sender must answer, in flow order. */
  questions: SenderQuestion[];
  /** Answered by the link's creator — shown in the summary, never asked. */
  answered: SenderQuestion[];
}

/**
 * What is this sender actually being asked?
 *
 * A question is skipped when the LINK answers it — the creator supplied a
 * ship-from address, or specced the parcel. It is NOT skipped merely because
 * the sender's own browser has a saved address: that is a prefill for a
 * question that is still theirs to answer. The distinction is the whole point
 * — the creator's answers are not the sender's to re-enter, and before this
 * the flow made them scroll past every one.
 */
export function planSenderSteps(link: {
  needs_destination?: boolean | null;
  origin_prefill?: { street1?: string; phone?: string | null } | null;
  package_prefill?: { length_in?: number; width_in?: number; weight_oz?: number | null } | null;
}): SenderPlan {
  const questions: SenderQuestion[] = [];
  const answered: SenderQuestion[] = [];

  // Destination: only ever a question when the creator deferred it. On an
  // ordinary flex link the address is the creator's own and never shown
  // (Rule 7) — it is not in `answered` either, because there is nothing the
  // sender may see or edit.
  if (link.needs_destination === true) questions.push("destination");

  // A prefilled origin only counts as answered if it is shippable as-is: the
  // carriers reject a label with no phone on the from-address, so a
  // phone-less prefill is a half-answer and the sender still has to be asked.
  const op = link.origin_prefill;
  const originKnown = !!op?.street1 && isUsablePhone(op.phone ?? "");
  (originKnown ? answered : questions).push("origin");

  const pp = link.package_prefill;
  const parcelKnown = !!pp && !!pp.length_in && !!pp.width_in && !!pp.weight_oz;
  (parcelKnown ? answered : questions).push("package");

  return { questions, answered };
}

export type PackagingType = "box" | "envelope" | "tube";

export interface SenderParcel {
  length: number;
  width: number;
  height: number;
  weightOz: number;
  description: string;
  packaging: PackagingType;
}

// The saved-sender localStorage store (v1/v2, 2026-05-19) is gone as of
// 2026-08-24, with the "Save my information on this device" checkbox that fed
// it and the ship-again CTA that read it. On a link that supplied the
// ship-from address it persisted the CREATOR's address as this browser's "my
// information", and most senders use a link once. Browser autofill covers the
// repeat case; nothing in the flow reads a saved sender any more.

// "Preferred by {recipient}" badge: a rate is preferred if its EasyPost
// service matches the link's preferred_speed tier. Re-uses the canonical
// classifySpeedTier from @/lib/utils to keep the mapping in lockstep with
// the rest of the app (PLAYBOOK Rule 6: extend, don't invent).
export function speedTierForService(_carrier: string, service: string): "economy" | "standard" | "express" {
  return classifySpeedTier(service);
}

export function isPreferredRate(rate: ShippingRate, linkData: LinkData): boolean {
  if (!linkData.preferred_speed) return false;
  return speedTierForService(rate.carrier, rate.service) === linkData.preferred_speed;
}

// Sort rates for the sender picker: preferred (matches link's speed tier)
// first, then cheapest within each group. The sender doesn't see prices but
// the ordering reflects what the recipient wants AND what they'd pay.
export function sortRatesForSender<T extends ShippingRate>(rates: T[], linkData: LinkData): T[] {
  return [...rates].sort((a, b) => {
    const ap = isPreferredRate(a, linkData) ? 0 : 1;
    const bp = isPreferredRate(b, linkData) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.display_price_cents - b.display_price_cents;
  });
}

// Normalize carrier names to a canonical key so service-level variants
// (e.g. "USPS", "USPSReturn", "FedEx", "FedExSmartPost") collapse correctly.
function normalizeCarrier(carrier: string): string {
  const c = carrier.toUpperCase();
  if (c.includes("USPS")) return "USPS";
  if (c.includes("FEDEX") || c.includes("FED_EX")) return "FedEx";
  if (c.includes("UPS")) return "UPS";
  if (c.includes("DHL")) return "DHL";
  return carrier;
}

// Best-value score: lower = better. Penalises slow delivery so a slightly
// cheaper but much slower option doesn't blindly win. Each day beyond 3
// adds 5% to the effective cost. Unknown delivery times are treated as 7 days.
//
// Examples:
//   $10 / 3 days → score 10.00
//   $8  / 7 days → score  9.60  (still beats $10/3-day)
//   $8  / 10 days → score 10.80 (worse than $10/3-day)
function valueScore(rate: ShippingRate): number {
  const days = rate.estimated_days ?? 7;
  const dayPenalty = Math.max(0, days - 3) * 0.05;
  return rate.display_price_cents * (1 + dayPenalty);
}

// Returns one rate per carrier (best-value within each), ranked best first.
// This trims the full EasyPost rate list down to a clean 2–3 card UI
// rather than an undifferentiated wall of options.
export function pickBestPerCarrier<T extends ShippingRate>(rates: T[]): T[] {
  const byCarrier = new Map<string, T[]>();
  for (const rate of rates) {
    const key = normalizeCarrier(rate.carrier);
    if (!byCarrier.has(key)) byCarrier.set(key, []);
    byCarrier.get(key)!.push(rate);
  }
  const winners: T[] = [];
  for (const carrierRates of byCarrier.values()) {
    const best = carrierRates.reduce((a, b) => valueScore(a) < valueScore(b) ? a : b);
    winners.push(best);
  }
  return winners.sort((a, b) => valueScore(a) - valueScore(b));
}

// Rough cost indicator for the sender — they don't see the exact price but
// $-symbols give an order-of-magnitude signal so they can pick mindfully.
// 1$ < $10 baseline (cheap USPS Ground envelope); scale is steeper at the
// low end where most everyday shipments cluster, wider at the top so a
// premium cross-country express ($75–150) lands at 8–9$.
export function priceTierSymbol(displayPriceCents: number): string {
  const dollars = displayPriceCents / 100;
  const buckets = [10, 15, 22, 32, 45, 65, 90, 125, 175];
  let n = 1;
  for (const b of buckets) {
    if (dollars < b) break;
    n += 1;
  }
  return "$".repeat(Math.min(n, 10));
}

// Drop-off copy keyed to the SELECTED rate's carrier, not the link's
// preferred carrier (reviewer non-blocking #3).
export function dropOffCopy(carrier: string): { body: string; locationUrl: string | null } {
  const c = (carrier || "").toLowerCase();
  if (c.includes("usps")) {
    return {
      body: "Drop off at any USPS Blue Box, Post Office, or hand to your mail carrier.",
      locationUrl: "https://tools.usps.com/find-location.htm",
    };
  }
  if (c.includes("ups")) {
    return {
      body: "Drop off at any UPS Store, UPS Drop Box, or UPS Access Point.",
      locationUrl: "https://www.ups.com/dropoff",
    };
  }
  if (c.includes("fedex")) {
    return {
      body: "Drop off at any FedEx location, FedEx Drop Box, or participating retailer.",
      locationUrl: "https://www.fedex.com/locate",
    };
  }
  if (c.includes("dhl")) {
    return {
      body: "Drop off at any DHL Service Point or scheduled pickup location.",
      locationUrl: "https://locator.dhl.com",
    };
  }
  return {
    body: `Drop off at any authorized ${carrier || "carrier"} location.`,
    locationUrl: null,
  };
}

export function isValidEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}


// ── Address gates ────────────────────────────────────────────
// Both address questions clear the same bar: a complete address plus a phone
// the carriers will accept (FedEx/UPS reject a label without one). They live
// here rather than beside their steps so the step files export components
// only — and so the gate is testable without rendering.

function addressErrors(a: AddressInput, what: string): string[] {
  const errs: string[] = [];
  if (!a.street || !a.city || !a.state || !a.zip) errs.push(`A complete ${what} address`);
  if (!isUsablePhone(a.phone)) errs.push("A phone number — the carriers require one");
  return errs;
}

export function destinationErrors(a: AddressInput): string[] {
  return addressErrors(a, "delivery");
}

export function originErrors(a: AddressInput): string[] {
  return addressErrors(a, "ship-from");
}
