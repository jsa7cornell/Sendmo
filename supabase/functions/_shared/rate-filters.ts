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

// EasyPost returns carrier-ACCOUNT ids, not carrier names: "UPSDAP", not "UPS";
// "FedExDefault", not "FedEx". The UI stores the plain name ("ups", "fedex"),
// so comparing the two raw strings silently filtered out every UPS and FedEx
// rate — only "usps" matched, by coincidence. SERVICE_DENYLIST above already
// hedged both FedEx spellings for exactly this reason; this generalises that
// hedge instead of adding a second one.
//
// Mirrors normalizeCarrier in src/components/sender/senderState.ts, which is
// client-only and unexported. Substring-matched because EasyPost appends the
// account suffix; USPS is tested first so its check can never be shadowed.
export function normalizeCarrier(carrier: string): string {
    const c = carrier.toUpperCase();
    if (c.includes("USPS")) return "USPS";
    if (c.includes("FEDEX") || c.includes("FED_EX")) return "FedEx";
    if (c.includes("UPS")) return "UPS";
    if (c.includes("DHL")) return "DHL";
    return carrier;
}

/**
 * A link's carrier constraint, as stored: NULL/"any" means unconstrained, a
 * single name means one carrier, a comma-separated list means any of several.
 * The list form is what lets a seller say "USPS or UPS" — the column stays
 * TEXT, so no migration. Whitespace and casing are tolerated because this
 * value is also rendered to sellers.
 */
export function parseCarriers(preferred: string | null | undefined): string[] {
    if (!preferred) return [];
    return preferred
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c.length > 0 && c.toLowerCase() !== "any")
        .map(normalizeCarrier);
}

/** Whether a quoted rate's carrier satisfies a link's stored constraint. */
export function carrierMatchesPreference(
    rateCarrier: string,
    preferred: string | null | undefined,
): boolean {
    const allowed = parseCarriers(preferred);
    if (allowed.length === 0) return true; // unconstrained
    return allowed.includes(normalizeCarrier(rateCarrier));
}

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
    if (!carrierMatchesPreference(rate.carrier, prefs.preferredCarrier)) {
        return "carrier_filtered";
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
