// Which quoted rates a person is actually SHOWN — one predicate for the
// buyer rate list (rates/) and the seller-link price band (PR10 review #2:
// the band's first draft used the cheapest RAW quote, so a carrier-
// constrained link promised a price the buyer could never pick).
//
// Extracted from rates/index.ts verbatim; rates/ keeps its telemetry by
// branching on the returned reason. Pure — Vitest imports it directly.

export interface DenylistedService {
    carrier: string; // lowercased
    service: string; // UPPERCASED
}

// Service denylist — carrier+service pairs whose buy-time rate is not
// guaranteed to equal the rate-shop quote (FedEx Smart Post forensics:
// proposals/2026-05-23_smart-post-denylist-handoff.md; re-enable path in
// rates/index.ts's header comment).
export const SERVICE_DENYLIST: DenylistedService[] = [
    { carrier: "fedexdefault", service: "SMART_POST" },
    { carrier: "fedex", service: "SMART_POST" }, // defensive — covers either FedEx EP carrier-account label
];

export const MAX_DISPLAY_PRICE = 200; // dollars — the platform-wide ceiling

export function classifySpeed(days: number | null): string {
    if (days === null) return "standard";
    if (days <= 3) return "express";
    if (days <= 5) return "standard";
    return "economy";
}

export type RateFilterReason =
    | "denylisted"
    | "over_platform_cap"
    | "over_price_cap"
    | "carrier_filtered"
    | "speed_filtered";

/**
 * null = displayable. Otherwise the first reason the rate is hidden, in the
 * same precedence order rates/ has always applied.
 */
export function rateDisplayFilterReason(
    rate: { displayPriceDollars: number; carrier: string; service: string; speedTier: string },
    prefs: {
        effectivePriceCapDollars: number;
        preferredCarrier?: string | null;
        preferredSpeed?: string | null;
    },
): RateFilterReason | null {
    const carrierLower = rate.carrier.toLowerCase();
    const serviceUpper = rate.service.toUpperCase();
    if (SERVICE_DENYLIST.some((d) => d.carrier === carrierLower && d.service === serviceUpper)) {
        return "denylisted";
    }
    if (rate.displayPriceDollars > MAX_DISPLAY_PRICE) return "over_platform_cap";
    if (rate.displayPriceDollars > prefs.effectivePriceCapDollars) return "over_price_cap";
    if (prefs.preferredCarrier && prefs.preferredCarrier !== "any") {
        if (carrierLower !== prefs.preferredCarrier.toLowerCase()) return "carrier_filtered";
    }
    if (prefs.preferredSpeed) {
        const speedRank: Record<string, number> = { economy: 0, standard: 1, express: 2 };
        const rateRank = speedRank[rate.speedTier] ?? 1;
        const prefRank = speedRank[prefs.preferredSpeed] ?? 1;
        // Show rates at the preferred speed or faster.
        if (rateRank < prefRank) return "speed_filtered";
    }
    return null;
}
