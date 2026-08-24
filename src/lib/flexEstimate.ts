import type { CreateLinkParams } from "@/lib/api";

/** The link-creation payload the flexible payment step works from. */
export type FlexPaymentInput = Omit<CreateLinkParams, "initial_status" | "notes">;

// ─── Rate estimate lookup ─────────────────────────────────────
// Gives recipients a sense of per-shipment cost before they save a card.
// Onboarding renders it inside the Shipping Link Details card (see
// getFlexEstimate below, called by RecipientStepFlexPayment); the /links/new
// dashboard flow shows only a small "See typical costs" disclosure instead
// (`showCostEstimate=false`).

export interface RangeEstimate {
  low: number;
  high: number;
  days: string;
}

type SizeKey = "envelope" | "smallbox" | "largebox" | "default";

const RATE_TABLE: Record<string, Record<string, Record<string, RangeEstimate>>> = {
  envelope: {
    nearby:  { economy: { low: 500, high: 600, days: "2–3" }, standard: { low: 800, high: 1000, days: "1–2" }, express: { low: 2800, high: 3000, days: "Next day" } },
    regional: { economy: { low: 600, high: 700, days: "3–4" }, standard: { low: 900, high: 1200, days: "2–3" }, express: { low: 2900, high: 3200, days: "1–2" } },
    cross:   { economy: { low: 700, high: 900, days: "4–5" }, standard: { low: 1100, high: 1400, days: "2–3" }, express: { low: 3000, high: 3400, days: "1–2" } },
  },
  smallbox: {
    nearby:  { economy: { low: 700, high: 1000, days: "2–4" }, standard: { low: 1000, high: 1400, days: "1–3" }, express: { low: 3200, high: 4200, days: "1–2" } },
    regional: { economy: { low: 1000, high: 1500, days: "3–5" }, standard: { low: 1400, high: 1900, days: "2–3" }, express: { low: 3600, high: 4800, days: "1–2" } },
    cross:   { economy: { low: 1400, high: 2000, days: "5–7" }, standard: { low: 1800, high: 2400, days: "2–3" }, express: { low: 4200, high: 5600, days: "1–2" } },
  },
  largebox: {
    nearby:  { economy: { low: 1400, high: 2000, days: "2–4" }, standard: { low: 1800, high: 2600, days: "1–3" }, express: { low: 4800, high: 6800, days: "1–2" } },
    regional: { economy: { low: 2000, high: 3000, days: "3–5" }, standard: { low: 2600, high: 3800, days: "2–3" }, express: { low: 5800, high: 8200, days: "1–2" } },
    cross:   { economy: { low: 2800, high: 4000, days: "5–7" }, standard: { low: 3400, high: 4800, days: "2–3" }, express: { low: 7200, high: 10000, days: "1–2" } },
  },
  default: {
    nearby:  { economy: { low: 500, high: 2000, days: "2–5" }, standard: { low: 800, high: 2600, days: "1–3" }, express: { low: 2800, high: 6800, days: "1–2" } },
    regional: { economy: { low: 600, high: 3000, days: "3–5" }, standard: { low: 900, high: 3800, days: "2–3" }, express: { low: 2900, high: 8200, days: "1–2" } },
    cross:   { economy: { low: 700, high: 4000, days: "4–7" }, standard: { low: 1100, high: 4800, days: "2–3" }, express: { low: 3000, high: 10000, days: "1–2" } },
  },
};

export interface FlexEstimate extends RangeEstimate {
  /** False when the cap sits below the cheapest rate we expect. */
  capCovers: boolean;
}

/**
 * The per-shipment range shown before a card is saved.
 *
 * The estimate must never advertise a price above the cap, because we never
 * charge one — a $9–$38 range under a $25 cap told the user two different
 * things on the same screen (2026-08-23). The cap is the ceiling, so it is
 * the ceiling here too.
 *
 * A cap BELOW the cheapest estimate is a different problem and is not clamped
 * away: it means no shipment this size is likely to go through, and the user
 * needs to know that before saving a card, not after a sender's first failed
 * attempt. `capCovers` is false in that case.
 */
export function getFlexEstimate(input: FlexPaymentInput): FlexEstimate {
  const size: SizeKey = (input.size_hint as SizeKey | null) ?? "default";
  const distance = input.distance_hint ?? "regional";
  const raw = RATE_TABLE[size]?.[distance]?.[input.speed_preference]
    ?? RATE_TABLE.default.regional.standard;
  const capCents = Math.round((input.price_cap_dollars ?? 0) * 100);
  return {
    ...raw,
    high: capCents > 0 ? Math.min(raw.high, capCents) : raw.high,
    capCovers: capCents <= 0 || raw.low <= capCents,
  };
}

