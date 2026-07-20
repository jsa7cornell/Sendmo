import { describe, it, expect } from "vitest";
import { applyMargin, addInsurance, formatCents, isOverCap } from "@/lib/api";
import {
  applyMarkup,
  MARKUP_MULTIPLIER,
  MARKUP_FLAT_CENTS,
} from "../../supabase/functions/_shared/pricing.ts";

describe("applyMargin", () => {
  it("applies 15% margin + $1.00 flat fee to a rate", () => {
    expect(applyMargin(1000)).toBe(1250); // $10.00 × 1.15 + $1.00 = $12.50
  });

  it("rounds to nearest cent then adds flat fee", () => {
    expect(applyMargin(333)).toBe(483); // $3.33 × 1.15 = $3.83 + $1.00 = $4.83
  });

  it("handles zero (flat fee still applies)", () => {
    expect(applyMargin(0)).toBe(100); // $0.00 × 1.15 + $1.00 = $1.00
  });
});

describe("addInsurance", () => {
  it("adds $2.50 (250 cents)", () => {
    expect(addInsurance(1150)).toBe(1400); // $11.50 + $2.50 = $14.00
  });
});

describe("formatCents", () => {
  it("formats cents as dollar string", () => {
    expect(formatCents(1150)).toBe("$11.50");
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(99)).toBe("$0.99");
    expect(formatCents(10000)).toBe("$100.00");
  });
});

describe("isOverCap", () => {
  it("returns false when under default $100 cap", () => {
    expect(isOverCap(9999)).toBe(false);
  });

  it("returns false at exactly $100", () => {
    expect(isOverCap(10000)).toBe(false);
  });

  it("returns true when over $100", () => {
    expect(isOverCap(10001)).toBe(true);
  });

  it("respects custom cap", () => {
    expect(isOverCap(5001, 50)).toBe(true);
    expect(isOverCap(5000, 50)).toBe(false);
  });
});

// ─── Seller-link: server-derived buyer charge (_shared/pricing.ts) ──────────
// seller-checkout derives the buyer's on-session charge amount server-side —
// the buyer never supplies the price. applyMarkup is that single authority;
// these lock the formula and, critically, prove it agrees cent-for-cent with
// the frontend applyMargin the buyer sees at rate-shopping. If the two ever
// drift, a buyer is charged an amount different from the price they clicked.
describe("applyMarkup (seller-checkout server-derived amount)", () => {
  it("applies 15% + $1.00 to a dollar rate → cents", () => {
    expect(applyMarkup(10)).toBe(1250); // $10.00 × 1.15 + $1.00 = $12.50
  });

  it("rounds to nearest cent BEFORE adding the flat fee", () => {
    expect(applyMarkup(3.33)).toBe(483); // 3.33×100×1.15=382.95 → 383 + 100 = 483
  });

  it("flat fee still applies at a zero rate", () => {
    expect(applyMarkup(0)).toBe(100);
  });

  it("uses the shared markup constants", () => {
    expect(MARKUP_MULTIPLIER).toBe(1.15);
    expect(MARKUP_FLAT_CENTS).toBe(100);
  });

  // The buyer sees applyMargin(rateCents) at rate-shopping and is charged
  // applyMarkup(rateDollars) by seller-checkout — these MUST match for every
  // realistic EasyPost rate (2-decimal dollars), or "you saw $X, charged $Y".
  it("agrees cent-for-cent with the frontend applyMargin (buyer-sees == charged)", () => {
    for (const dollars of [4.5, 7.99, 10, 12.34, 25.6, 88.88, 100]) {
      const cents = Math.round(dollars * 100);
      expect(applyMarkup(dollars)).toBe(applyMargin(cents));
    }
  });

  // seller-checkout caps the charge at link.max_price_cents. The effective
  // charge is min(applyMarkup(rate), cap); a buyer is never charged above the
  // seller-set ceiling even if the live rate spikes past it.
  it("cap composition: charge = min(applyMarkup(rate), max_price_cents)", () => {
    const cap = 1500;
    expect(Math.min(applyMarkup(10), cap)).toBe(1250); // under cap → full price
    expect(Math.min(applyMarkup(20), cap)).toBe(1500); // $23.00 > cap → capped
  });
});
