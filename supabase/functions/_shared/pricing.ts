// resolveGateBasisCents — the trusted price basis for the buy-time rate gate.
//
// Extracted 2026-07-06 after the pre-launch money-path review found the gate
// in labels/index.ts compared against the RAW BODY display_price_cents on the
// full-label leg: payments creates the PI for a client-supplied amount (only
// the 50¢ Stripe floor is checked), so a hostile client could pay 50¢, send
// display_price_cents: 0 to skip the gate entirely, and buy a $50 label.
// The gate must only ever compare against a number the server can vouch for:
//   • flex leg   — the server-derived rate (B5; the client value is never
//                  trusted on that leg to begin with)
//   • full-label — the VERIFIED PaymentIntent amount: what the customer
//                  actually paid IS the display price
//   • comp       — no charge to compare; returns 0 and the gate skips.
//
// Pure TypeScript, no Deno reads — Vitest exercises it directly (same
// pattern as mode.ts / allowlist.ts). Truth table: tests/unit/pricingGate.test.ts.

export function resolveGateBasisCents(params: {
    /** Server-derived display price (flex leg, set by labels) — null elsewhere. */
    serverDerivedCents: number | null;
    /** Verified PaymentIntent amount (full-label / flex charge) — null for comp. */
    verifiedPiAmountCents: number | null;
}): number {
    if (typeof params.serverDerivedCents === "number" && params.serverDerivedCents > 0) {
        return params.serverDerivedCents;
    }
    if (typeof params.verifiedPiAmountCents === "number" && params.verifiedPiAmountCents > 0) {
        return params.verifiedPiAmountCents;
    }
    return 0;
}

// ─── applyMarkup — SendMo's label margin, single source of truth ────────────
//
// Display price = EasyPost rate × MARKUP_MULTIPLIER + MARKUP_FLAT_CENTS
// (15% + $1.00). Historically duplicated as literals in rates/index.ts:7-8 and
// labels/index.ts:28-33; centralized here so the seller-checkout leg shares one
// definition. Pure (no Deno reads) — safe for Vitest and for Deno edge fns.
// If you change these, the flex cap-check and the buy-time rate gate both
// depend on them staying in sync across rates/ + labels/.
export const MARKUP_MULTIPLIER = 1.15;
export const MARKUP_FLAT_CENTS = 100;

/** EasyPost rate in dollars → SendMo display price in cents. */
export function applyMarkup(rateDollars: number): number {
    return Math.round(rateDollars * 100 * MARKUP_MULTIPLIER) + MARKUP_FLAT_CENTS;
}
