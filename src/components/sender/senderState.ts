// Shared state + helpers for the 5-step sender flow at /s/:shortCode.
// See proposal 2026-05-11_sender-flow-wizard for the spec; SPEC.md §8 for
// the canonical step contract.

import type { AddressInput, ShippingRate } from "@/lib/types";
import type { LinkData } from "@/lib/api";
import { classifySpeedTier } from "@/lib/utils";

// Round 2 (proposal §11+§13): the "done" step is gone — the post-confirm
// surface is the shipment page at /t/<public_code>. The progress bar still
// shows 4 dots because the wizard has 4 form steps after the intro.
export type SenderStep = "intro" | "package" | "rates" | "review";

export const SENDER_STEP_ORDER: SenderStep[] = [
  "intro", "package", "rates", "review",
];

export type PackagingType = "box" | "envelope" | "tube";

export interface SenderParcel {
  length: number;
  width: number;
  height: number;
  weightOz: number;
  description: string;
  packaging: PackagingType;
}

// localStorage versioning per author-response non-blocking nit. Bump VERSION
// when the shape changes; reads tolerate version mismatch by returning null.
//
// v2 (2026-05-19): `phone` became a required field on AddressInput. A v1
// payload saved before that change has a senderAddress with no `phone` key —
// rehydrating it would seed a phone-less address into the sender flow. The
// version bump makes loadSavedSender discard those stale entries so the user
// re-enters (and the form collects) a phone. See finding 4,
// 2026-05-20_phone-required-flow-audit.md.
const STORAGE_KEY = "sendmo:sender:v1";
const STORAGE_VERSION = 2;

interface StoredSender {
  version: number;
  senderAddress: AddressInput;
  senderEmail: string;
}

export function loadSavedSender(): { senderAddress: AddressInput; senderEmail: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSender;
    if (parsed.version !== STORAGE_VERSION) return null;
    return { senderAddress: parsed.senderAddress, senderEmail: parsed.senderEmail };
  } catch {
    return null;
  }
}

export function saveSender(senderAddress: AddressInput, senderEmail: string): void {
  if (typeof window === "undefined") return;
  try {
    const payload: StoredSender = { version: STORAGE_VERSION, senderAddress, senderEmail };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // localStorage may be unavailable (Safari private mode, quota exceeded).
    // Silent — the save is a nice-to-have, not load-bearing.
  }
}

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
