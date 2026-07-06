// Unit tests for the buy-time rate-gate price basis
// (supabase/functions/_shared/pricing.ts).
//
// Regression for the 2026-07-06 full-label price-integrity fix: the gate in
// labels/index.ts compared against the RAW BODY display_price_cents, and a
// client-supplied 0 (or omission) skipped the gate entirely — pay the 50¢
// payments-fn floor, send display_price_cents: 0, get a $50 label. The gate
// basis must be a number the server can vouch for: the server-derived rate
// (flex, B5) else the verified PaymentIntent amount (full-label), else 0
// (comp — nothing to compare).
//
// Pure TS — no Deno global, Vitest imports directly.

import { describe, it, expect } from "vitest";
import { resolveGateBasisCents } from "../../supabase/functions/_shared/pricing.ts";

describe("resolveGateBasisCents", () => {
    it("flex: server-derived value wins, even when a PI amount is also present", () => {
        expect(resolveGateBasisCents({ serverDerivedCents: 1234, verifiedPiAmountCents: 999 })).toBe(1234);
        expect(resolveGateBasisCents({ serverDerivedCents: 1234, verifiedPiAmountCents: null })).toBe(1234);
    });

    it("full-label: falls back to the verified PI amount (what the customer paid IS the display price)", () => {
        expect(resolveGateBasisCents({ serverDerivedCents: null, verifiedPiAmountCents: 5210 })).toBe(5210);
    });

    it("REGRESSION — a present PI amount can never yield 0 (the gate-skip hole)", () => {
        // Hostile full-label client: pays the 50¢ floor, zeroes/omits
        // display_price_cents. The basis must be the PI amount, never 0.
        expect(resolveGateBasisCents({ serverDerivedCents: null, verifiedPiAmountCents: 50 })).toBe(50);
        expect(resolveGateBasisCents({ serverDerivedCents: 0, verifiedPiAmountCents: 50 })).toBe(50);
    });

    it("comp: both null → 0 (nothing to compare; gate skips)", () => {
        expect(resolveGateBasisCents({ serverDerivedCents: null, verifiedPiAmountCents: null })).toBe(0);
    });

    it("non-positive inputs are treated as absent", () => {
        expect(resolveGateBasisCents({ serverDerivedCents: 0, verifiedPiAmountCents: null })).toBe(0);
        expect(resolveGateBasisCents({ serverDerivedCents: -5, verifiedPiAmountCents: -1 })).toBe(0);
        expect(resolveGateBasisCents({ serverDerivedCents: null, verifiedPiAmountCents: 0 })).toBe(0);
    });
});
