// Unit tests for the shared rate-display predicate
// (supabase/functions/_shared/rate-filters.ts).
//
// This file exists because its absence let a real bug ship. Nothing imported
// rate-filters, so CI was green while `preferredCarrier: "ups"` filtered out
// every UPS rate — EasyPost returns the carrier-ACCOUNT id ("UPSDAP"), and the
// old predicate compared that raw string to the UI's plain name.
//
// The rule these tests encode: **use the carrier strings EasyPost actually
// returns.** The one pre-existing adjacent test used a synthetic "UPS", which
// is exactly the substitution that hid the bug. Values below are taken from
// production `shipments.carrier`: USPS, UPSDAP, FedExDefault.
//
// Pure module — no Deno or network deps to mock.

import { describe, it, expect } from "vitest";
import {
    rateDisplayFilterReason,
    normalizeCarrier,
    parseCarriers,
    carrierMatchesPreference,
    MAX_DISPLAY_PRICE,
} from "../../supabase/functions/_shared/rate-filters.ts";

/** The real strings EasyPost returns, verified against prod. */
const EP_USPS = "USPS";
const EP_UPS = "UPSDAP";
const EP_FEDEX = "FedExDefault";

function rate(over: Partial<{ displayPriceDollars: number; carrier: string; service: string; speedTier: string }> = {}) {
    return {
        displayPriceDollars: 10,
        carrier: EP_USPS,
        service: "GroundAdvantage",
        speedTier: "standard",
        ...over,
    };
}

const NO_PREFS = { effectivePriceCapDollars: MAX_DISPLAY_PRICE };

describe("normalizeCarrier", () => {
    it("maps EasyPost carrier-account ids to plain carrier names", () => {
        expect(normalizeCarrier(EP_UPS)).toBe("UPS");
        expect(normalizeCarrier(EP_FEDEX)).toBe("FedEx");
        expect(normalizeCarrier(EP_USPS)).toBe("USPS");
    });

    it("does not let USPS fall through to the UPS branch", () => {
        // "USPS" does not contain the substring "UPS", but the ordering is
        // load-bearing if that ever changes — pin it.
        expect(normalizeCarrier("USPS")).toBe("USPS");
        expect(normalizeCarrier("uspsReturns")).toBe("USPS");
    });

    it("passes an unrecognised carrier through untouched", () => {
        expect(normalizeCarrier("Canada Post")).toBe("Canada Post");
    });
});

describe("parseCarriers", () => {
    it("treats null, empty and 'any' as unconstrained", () => {
        expect(parseCarriers(null)).toEqual([]);
        expect(parseCarriers(undefined)).toEqual([]);
        expect(parseCarriers("")).toEqual([]);
        expect(parseCarriers("any")).toEqual([]);
    });

    it("parses a comma-separated list, tolerating whitespace and casing", () => {
        expect(parseCarriers("usps,ups")).toEqual(["USPS", "UPS"]);
        expect(parseCarriers(" USPS , ups ")).toEqual(["USPS", "UPS"]);
    });

    it("drops an 'any' mixed into a list rather than treating it as a carrier", () => {
        expect(parseCarriers("usps,any")).toEqual(["USPS"]);
    });
});

describe("carrierMatchesPreference", () => {
    it("matches EasyPost account ids against plain stored names", () => {
        expect(carrierMatchesPreference(EP_UPS, "ups")).toBe(true);
        expect(carrierMatchesPreference(EP_FEDEX, "fedex")).toBe(true);
        expect(carrierMatchesPreference(EP_USPS, "usps")).toBe(true);
    });

    it("still rejects a genuine mismatch", () => {
        expect(carrierMatchesPreference(EP_UPS, "usps")).toBe(false);
        expect(carrierMatchesPreference(EP_USPS, "fedex")).toBe(false);
    });

    it("accepts any carrier in a multi-carrier constraint", () => {
        expect(carrierMatchesPreference(EP_USPS, "usps,ups")).toBe(true);
        expect(carrierMatchesPreference(EP_UPS, "usps,ups")).toBe(true);
        expect(carrierMatchesPreference(EP_FEDEX, "usps,ups")).toBe(false);
    });

    it("is unconstrained when no preference is stored", () => {
        expect(carrierMatchesPreference(EP_UPS, null)).toBe(true);
        expect(carrierMatchesPreference(EP_UPS, "any")).toBe(true);
    });
});

describe("rateDisplayFilterReason — carrier constraint", () => {
    it("shows a UPS rate on a UPS-constrained link (the shipped bug)", () => {
        expect(
            rateDisplayFilterReason(rate({ carrier: EP_UPS }), { ...NO_PREFS, preferredCarrier: "ups" }),
        ).toBeNull();
    });

    it("shows a FedEx rate on a FedEx-constrained link", () => {
        expect(
            rateDisplayFilterReason(
                rate({ carrier: EP_FEDEX, service: "FEDEX_GROUND" }),
                { ...NO_PREFS, preferredCarrier: "fedex" },
            ),
        ).toBeNull();
    });

    it("shows a USPS rate on a USPS-constrained link", () => {
        expect(
            rateDisplayFilterReason(rate({ carrier: EP_USPS }), { ...NO_PREFS, preferredCarrier: "usps" }),
        ).toBeNull();
    });

    it("still hides a carrier the seller excluded", () => {
        expect(
            rateDisplayFilterReason(rate({ carrier: EP_UPS }), { ...NO_PREFS, preferredCarrier: "usps" }),
        ).toBe("carrier_filtered");
    });

    it("shows both carriers on a two-carrier link and hides the third", () => {
        const prefs = { ...NO_PREFS, preferredCarrier: "usps,ups" };
        expect(rateDisplayFilterReason(rate({ carrier: EP_USPS }), prefs)).toBeNull();
        expect(rateDisplayFilterReason(rate({ carrier: EP_UPS }), prefs)).toBeNull();
        expect(
            rateDisplayFilterReason(rate({ carrier: EP_FEDEX, service: "FEDEX_GROUND" }), prefs),
        ).toBe("carrier_filtered");
    });

    it("shows every carrier when the link is unconstrained", () => {
        for (const carrier of [EP_USPS, EP_UPS]) {
            expect(rateDisplayFilterReason(rate({ carrier }), NO_PREFS)).toBeNull();
            expect(rateDisplayFilterReason(rate({ carrier }), { ...NO_PREFS, preferredCarrier: "any" })).toBeNull();
            expect(rateDisplayFilterReason(rate({ carrier }), { ...NO_PREFS, preferredCarrier: null })).toBeNull();
        }
    });
});

describe("rateDisplayFilterReason — precedence is unchanged", () => {
    it("denylists FedEx Smart Post under either carrier spelling", () => {
        expect(rateDisplayFilterReason(rate({ carrier: EP_FEDEX, service: "SMART_POST" }), NO_PREFS))
            .toBe("denylisted");
        expect(rateDisplayFilterReason(rate({ carrier: "fedex", service: "SMART_POST" }), NO_PREFS))
            .toBe("denylisted");
    });

    it("reports the platform cap before the link's own cap", () => {
        expect(
            rateDisplayFilterReason(rate({ displayPriceDollars: MAX_DISPLAY_PRICE + 1 }), {
                effectivePriceCapDollars: 10,
            }),
        ).toBe("over_platform_cap");
    });

    it("reports the link's price cap before the carrier filter", () => {
        expect(
            rateDisplayFilterReason(rate({ displayPriceDollars: 50, carrier: EP_UPS }), {
                effectivePriceCapDollars: 20,
                preferredCarrier: "usps",
            }),
        ).toBe("over_price_cap");
    });

    it("hides a rate slower than the preferred speed, and keeps faster ones", () => {
        expect(
            rateDisplayFilterReason(rate({ speedTier: "economy" }), { ...NO_PREFS, preferredSpeed: "standard" }),
        ).toBe("speed_filtered");
        expect(
            rateDisplayFilterReason(rate({ speedTier: "express" }), { ...NO_PREFS, preferredSpeed: "standard" }),
        ).toBeNull();
    });
});
