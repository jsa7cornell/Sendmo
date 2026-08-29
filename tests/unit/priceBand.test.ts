import { describe, it, expect } from "vitest";
import { computeSellerPriceBand, BAND_DESTINATIONS } from "../../supabase/functions/_shared/price-band";
import { applyMarkup } from "../../supabase/functions/_shared/pricing";

// PR10: the band is the CHEAPEST displayed option per representative
// destination, min/max across the three. Any destination failing → null
// (a partial band skews narrow and reads as a promise the real quote breaks).

const quoteResponse = (rates: Array<{ id: string; rate: string; carrier?: string; service?: string }>) =>
    new Response(JSON.stringify({ id: "shp_band", rates: rates.map((r) => ({ carrier: "USPS", service: "GroundAdvantage", ...r })) }), {
        status: 200, headers: { "Content-Type": "application/json" },
    });

function fetchReturningPerCall(responses: Response[], seenBodies: string[] = []) {
    let i = 0;
    return (_url: string, init?: RequestInit) => {
        if (init?.body) seenBodies.push(String(init.body));
        return Promise.resolve(responses[i++]);
    };
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

    it("stamps band quotes reference 'band:<id>' — NEVER the bare link id the binding checks trust (review #3)", async () => {
        const bodies: string[] = [];
        await computeSellerPriceBand({
            apiKey: "EZTK_test", origin, parcel, linkId: "link-123",
            fetchImpl: fetchReturningPerCall([
                quoteResponse([{ id: "r1", rate: "8.00" }]),
                quoteResponse([{ id: "r2", rate: "9.00" }]),
                quoteResponse([{ id: "r3", rate: "10.00" }]),
            ], bodies),
        });
        for (const body of bodies) {
            expect(body).toContain('"reference":"band:link-123"');
            expect(body).not.toContain('"reference":"link-123"');
        }
    });

    it("the band is the cheapest option the buyer can PICK — constraints and the denylist apply (review #2)", async () => {
        // Cheapest raw rate is a denylisted FedEx Smart Post; next is UPS,
        // but the link is USPS-constrained — the band must use the USPS rate.
        const band = await computeSellerPriceBand({
            apiKey: "EZTK_test", origin, parcel,
            preferredCarrier: "usps",
            fetchImpl: fetchReturningPerCall([
                quoteResponse([
                    { id: "d1", rate: "5.00", carrier: "FedExDefault", service: "SMART_POST" },
                    { id: "u1", rate: "7.00", carrier: "UPS", service: "Ground" },
                    { id: "s1", rate: "9.00", carrier: "USPS", service: "GroundAdvantage" },
                ]),
                quoteResponse([{ id: "s2", rate: "10.00" }]),
                quoteResponse([{ id: "s3", rate: "11.00" }]),
            ]),
        });
        expect(band).toEqual({ minCents: applyMarkup(9.0), maxCents: applyMarkup(11.0) });
    });

    it("null when the constraints filter out every rate at any destination", async () => {
        const band = await computeSellerPriceBand({
            apiKey: "EZTK_test", origin, parcel,
            preferredCarrier: "fedex",
            fetchImpl: fetchReturningPerCall([
                quoteResponse([{ id: "s1", rate: "9.00" }]), // USPS only → filtered out
                quoteResponse([{ id: "s2", rate: "10.00" }]),
                quoteResponse([{ id: "s3", rate: "11.00" }]),
            ]),
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
