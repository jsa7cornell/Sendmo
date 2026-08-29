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
import { classifySpeed, rateDisplayFilterReason, MAX_DISPLAY_PRICE } from "./rate-filters.ts";
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
    /**
     * The link's id. Stamped on band quotes as "band:<id>" — NEVER the bare
     * id: seller-checkout and labels accept any shipment whose reference
     * equals the link id verbatim, and a band shipment carries a fixed cheap
     * destination (review #3 — the prefix makes those checks reject it by
     * construction rather than by shp_-id secrecy).
     */
    linkId?: string | null;
    /**
     * The link's buyer-visible constraints (review #2): the band is the
     * cheapest option the buyer can actually PICK, so it runs through the
     * same display filter as the rate list — denylist, platform ceiling,
     * carrier, speed.
     */
    preferredCarrier?: string | null;
    preferredSpeed?: string | null;
    fetchImpl?: FetchLike;
}): Promise<PriceBand | null> {
    const cheapestPerDestination: number[] = [];
    for (const destination of BAND_DESTINATIONS) {
        const quote = await createQuoteShipment({
            apiKey: params.apiKey,
            from: params.origin,
            to: destination,
            parcel: params.parcel,
            reference: params.linkId ? `band:${params.linkId}` : null,
            fetchImpl: params.fetchImpl,
        });
        if (!quote.ok || quote.rates.length === 0) return null;
        const displayable = quote.rates
            .map((r) => ({
                cents: applyMarkup(parseFloat(r.rate)),
                carrier: r.carrier,
                service: r.service,
                speedTier: classifySpeed(r.deliveryDays),
                rawDollars: parseFloat(r.rate),
            }))
            .filter((r) => Number.isFinite(r.rawDollars) && r.rawDollars > 0)
            .filter((r) =>
                rateDisplayFilterReason(
                    { displayPriceDollars: r.cents / 100, carrier: r.carrier, service: r.service, speedTier: r.speedTier },
                    // Seller links carry no cap (PR4) — the platform ceiling applies.
                    { effectivePriceCapDollars: MAX_DISPLAY_PRICE, preferredCarrier: params.preferredCarrier, preferredSpeed: params.preferredSpeed },
                ) === null);
        if (displayable.length === 0) return null;
        cheapestPerDestination.push(Math.min(...displayable.map((r) => r.cents)));
    }
    return {
        minCents: Math.min(...cheapestPerDestination),
        maxCents: Math.max(...cheapestPerDestination),
    };
}
