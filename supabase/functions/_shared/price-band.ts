// The seller link's public price band (PR10, seller-link launch §2.3).
//
// Design: computed ONCE per link (at creation, refreshed by the daily band
// sweep — Round-2 amendment: never on the anonymous GET, which the OG
// middleware calls on every page view), against three fixed representative
// destination ZIPs. Cost is bounded by links created, not traffic — and a
// precomputed number is the only kind that can ride the Facebook unfurl,
// where the click decision actually happens.
//
// Band definition: the CHEAPEST displayed option per destination (buyers
// overwhelmingly take the cheapest), min/max across the three destinations.
// It's a "typically" number, not a quote — the buyer always sees exact
// prices before paying.

import { applyMarkup } from "./pricing.ts";
import { createQuoteShipment, type QuoteAddress, type QuoteParcel } from "./easypost-quote.ts";
import type { FetchLike } from "./easypost-rates.ts";

// Near / mid / far zones for a contiguous-US origin. Deliberately EXCLUDES
// AK/HI (their rates would stretch every band into uselessness); the
// buyer-facing copy says "typically" and the exact price still gates the
// purchase. City/state/zip is all EasyPost needs to rate.
export const BAND_DESTINATIONS: QuoteAddress[] = [
    { city: "San Francisco", state: "CA", zip: "94105" },
    { city: "Chicago", state: "IL", zip: "60606" },
    { city: "New York", state: "NY", zip: "10007" },
];

export interface PriceBand {
    minCents: number;
    maxCents: number;
}

/**
 * Quote the three representative destinations and return the band, or null
 * when ANY destination fails to produce a usable cheapest rate — a band
 * built from partial data skews narrow, which reads as a promise the real
 * quote then breaks. Never throws.
 */
export async function computeSellerPriceBand(params: {
    apiKey: string;
    origin: QuoteAddress;
    parcel: QuoteParcel;
    reference?: string | null;
    fetchImpl?: FetchLike;
}): Promise<PriceBand | null> {
    const cheapestPerDestination: number[] = [];
    for (const destination of BAND_DESTINATIONS) {
        const quote = await createQuoteShipment({
            apiKey: params.apiKey,
            from: params.origin,
            to: destination,
            parcel: params.parcel,
            reference: params.reference ?? null,
            fetchImpl: params.fetchImpl,
        });
        if (!quote.ok || quote.rates.length === 0) return null;
        const cheapest = Math.min(
            ...quote.rates
                .map((r) => parseFloat(r.rate))
                .filter((n) => Number.isFinite(n) && n > 0)
                .map((dollars) => applyMarkup(dollars)),
        );
        if (!Number.isFinite(cheapest)) return null;
        cheapestPerDestination.push(cheapest);
    }
    return {
        minCents: Math.min(...cheapestPerDestination),
        maxCents: Math.max(...cheapestPerDestination),
    };
}
