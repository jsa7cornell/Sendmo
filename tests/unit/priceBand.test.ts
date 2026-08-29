import { describe, it, expect } from "vitest";
import { computeSellerPriceBand, BAND_DESTINATIONS } from "../../supabase/functions/_shared/price-band";
import { applyMarkup } from "../../supabase/functions/_shared/pricing";

// PR10: the band is the CHEAPEST displayed option per representative
// destination, min/max across the three. Any destination failing → null
// (a partial band skews narrow and reads as a promise the real quote breaks).

const quoteResponse = (rates: Array<{ id: string; rate: string }>) =>
    new Response(JSON.stringify({ id: "shp_band", rates: rates.map((r) => ({ ...r, carrier: "USPS", service: "GroundAdvantage" })) }), {
        status: 200, headers: { "Content-Type": "application/json" },
    });

function fetchReturningPerCall(responses: Response[]) {
    let i = 0;
    return () => Promise.resolve(responses[i++]);
}

const origin = { city: "Portola Valley", state: "CA", zip: "94028" };
const parcel = { length: 10, width: 10, height: 10, weight_oz: 80 };

describe("computeSellerPriceBand", () => {
    it("takes the cheapest per destination, min/max across the three", async () => {
        const band = await computeSellerPriceBand({
            apiKey: "EZTK_test",
            origin, parcel,
            fetchImpl: fetchReturningPerCall([
                quoteResponse([{ id: "r1", rate: "8.00" }, { id: "r2", rate: "12.00" }]),  // near: cheapest $8
                quoteResponse([{ id: "r3", rate: "11.50" }]),                              // mid: $11.50
                quoteResponse([{ id: "r4", rate: "15.00" }, { id: "r5", rate: "14.25" }]), // far: cheapest $14.25
            ]),
        });
        expect(band).toEqual({
            minCents: applyMarkup(8.0),
            maxCents: applyMarkup(14.25),
        });
    });

    it("returns null when ANY destination fails or returns no rates", async () => {
        expect(await computeSellerPriceBand({
            apiKey: "EZTK_test", origin, parcel,
            fetchImpl: fetchReturningPerCall([
                quoteResponse([{ id: "r1", rate: "8.00" }]),
                new Response(JSON.stringify({ error: { message: "boom" } }), { status: 422 }),
                quoteResponse([{ id: "r4", rate: "15.00" }]),
            ]),
        })).toBe(null);
        expect(await computeSellerPriceBand({
            apiKey: "EZTK_test", origin, parcel,
            fetchImpl: fetchReturningPerCall([
                quoteResponse([]),
                quoteResponse([{ id: "r3", rate: "11.50" }]),
                quoteResponse([{ id: "r4", rate: "15.00" }]),
            ]),
        })).toBe(null);
    });

    it("never throws — a rejecting fetch yields null", async () => {
        const band = await computeSellerPriceBand({
            apiKey: "EZTK_test", origin, parcel,
            fetchImpl: () => Promise.reject(new Error("net down")),
        });
        expect(band).toBe(null);
    });

    it("uses three contiguous-US destinations (AK/HI deliberately excluded)", () => {
        expect(BAND_DESTINATIONS).toHaveLength(3);
        for (const d of BAND_DESTINATIONS) {
            expect(["AK", "HI"]).not.toContain(d.state);
        }
    });
});
