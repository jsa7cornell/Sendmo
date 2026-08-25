// Rate resolution + rerate recovery on the label buy path.
//
// Regression cover for the 2026-08-24 checkout failure: EasyPost answered
// POST /shipments/{id}/buy with 404 NOT_FOUND ("The requested resource could
// not be found."), the customer saw that string verbatim after their card had
// been charged, and the price-cap gate had already skipped itself silently
// because its rate lookup found nothing and logged nothing.
//
// Pattern: same as pricingGate.test.ts / ledger-writes.test.ts — the helpers
// live in _shared/ precisely so Vitest can reach them (labels/index.ts calls
// Deno.serve at module load). `fetch` is injected, so no network.
//
// Cross-link: supabase/functions/_shared/easypost-rates.ts | LOG [2026-08-24]

import { describe, it, expect, vi } from "vitest";
import {
    lookupRate,
    rerateAndMatch,
    rerateRetryCapCents,
} from "../../supabase/functions/_shared/easypost-rates.ts";

const AUTH = "Basic dGVzdDo=";
const SHP = "shp_f030258aa7be49aab7f155277ec18bdc";
const RATE = "rate_0f7f0aee10734b118437a2f42d7ab29c";

const res = (status: number, body: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

// EasyPost's real 404 payload, copied from the production event_logs row.
const NOT_FOUND = {
    error: { code: "NOT_FOUND", message: "The requested resource could not be found." },
};

const UPS3 = { id: RATE, carrier: "UPSDAP", service: "3DaySelect", rate: "17.31" };

describe("lookupRate", () => {
    it("resolves from the per-rate endpoint when it answers", async () => {
        const f = vi.fn().mockResolvedValue(res(200, UPS3));
        expect(await lookupRate(SHP, RATE, AUTH, f)).toEqual({
            cents: 1731, carrier: "UPSDAP", service: "3DaySelect",
        });
        expect(f).toHaveBeenCalledTimes(1);
    });

    it("falls back to the shipment payload when the per-rate endpoint 404s", async () => {
        const f = vi.fn()
            .mockResolvedValueOnce(res(404, NOT_FOUND))
            .mockResolvedValueOnce(res(200, { id: SHP, rates: [UPS3] }));
        expect(await lookupRate(SHP, RATE, AUTH, f)).toEqual({
            cents: 1731, carrier: "UPSDAP", service: "3DaySelect",
        });
        expect(f).toHaveBeenCalledTimes(2);
    });

    // The 2026-08-24 state: the rate is on neither surface. This MUST be
    // distinguishable from a successful lookup — the old inline code returned
    // the same `null` for "gone" and "network threw", and the caller then
    // skipped the price cap without logging either.
    it("returns null when the rate is on neither surface", async () => {
        const f = vi.fn()
            .mockResolvedValueOnce(res(404, NOT_FOUND))
            .mockResolvedValueOnce(res(200, { id: SHP, rates: [{ ...UPS3, id: "rate_other" }] }));
        expect(await lookupRate(SHP, RATE, AUTH, f)).toBeNull();
    });

    it("returns null when the shipment itself cannot be read", async () => {
        const f = vi.fn().mockResolvedValue(res(404, NOT_FOUND));
        expect(await lookupRate(SHP, RATE, AUTH, f)).toBeNull();
    });

    it("returns null rather than throwing when fetch rejects", async () => {
        const f = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
        await expect(lookupRate(SHP, RATE, AUTH, f)).resolves.toBeNull();
    });

    it("treats a zero or unparseable rate as unusable", async () => {
        for (const bad of ["0.00", "", "abc", null]) {
            const f = vi.fn().mockResolvedValue(res(200, { ...UPS3, rate: bad }));
            expect(await lookupRate(SHP, RATE, AUTH, f)).toBeNull();
        }
    });
});

describe("rerateAndMatch", () => {
    it("returns the fresh rate id for the SAME carrier+service", async () => {
        const f = vi.fn().mockResolvedValue(res(200, {
            rates: [
                { id: "rate_new_usps", carrier: "USPS", service: "GroundAdvantage", rate: "10.28" },
                { id: "rate_new_ups3", carrier: "UPSDAP", service: "3DaySelect", rate: "17.55" },
            ],
        }));
        expect(await rerateAndMatch(SHP, "UPSDAP", "3DaySelect", AUTH, f)).toEqual({
            id: "rate_new_ups3", cents: 1755, carrier: "UPSDAP", service: "3DaySelect",
        });
        const [url, init] = f.mock.calls[0];
        expect(url).toBe(`https://api.easypost.com/v2/shipments/${SHP}/rerate`);
        expect(init.method).toBe("POST");
    });

    // The customer chose and paid for one service. Substituting a different
    // one — even a cheaper one — is not a retry.
    it("never substitutes a different service", async () => {
        const f = vi.fn().mockResolvedValue(res(200, {
            rates: [{ id: "rate_new_usps", carrier: "USPS", service: "GroundAdvantage", rate: "10.28" }],
        }));
        expect(await rerateAndMatch(SHP, "UPSDAP", "3DaySelect", AUTH, f)).toBeNull();
    });

    it("matches on carrier AND service, not either alone", async () => {
        const f = vi.fn().mockResolvedValue(res(200, {
            rates: [
                { id: "r1", carrier: "UPSDAP", service: "Ground", rate: "12.00" },
                { id: "r2", carrier: "FedExDefault", service: "3DaySelect", rate: "16.00" },
            ],
        }));
        expect(await rerateAndMatch(SHP, "UPSDAP", "3DaySelect", AUTH, f)).toBeNull();
    });

    it("returns null when the rerate call itself fails", async () => {
        const f = vi.fn().mockResolvedValue(res(422, { error: { code: "SHIPMENT.RERATE.FAILURE" } }));
        expect(await rerateAndMatch(SHP, "UPSDAP", "3DaySelect", AUTH, f)).toBeNull();
    });

    it("does not call EasyPost at all without a carrier+service to match", async () => {
        const f = vi.fn();
        expect(await rerateAndMatch(SHP, "", "3DaySelect", AUTH, f)).toBeNull();
        expect(await rerateAndMatch(SHP, "UPSDAP", "", AUTH, f)).toBeNull();
        expect(f).not.toHaveBeenCalled();
    });

    it("returns null rather than throwing when fetch rejects", async () => {
        const f = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
        await expect(rerateAndMatch(SHP, "UPSDAP", "3DaySelect", AUTH, f)).resolves.toBeNull();
    });
});

describe("rerateRetryCapCents", () => {
    const FEES = { stripeFeePct: 0.029, stripeFeeFlatCents: 30, minNetMarginPct: 0.05 };

    // The real numbers from the incident: $19.91 quoted.
    it("matches the buy-time gate formula", () => {
        expect(rerateRetryCapCents({ gateDisplayCents: 1991, isComp: false, ...FEES }))
            .toBe(Math.floor(1991 * (1 - 0.029 - 0.05) - 30));
    });

    it("lets a rerate at or under the cap through", () => {
        const cap = rerateRetryCapCents({ gateDisplayCents: 1991, isComp: false, ...FEES });
        expect(1755 <= cap).toBe(true);
        expect(cap).toBe(1803);
    });

    it("refuses a rerate that costs more than the payment supports", () => {
        const cap = rerateRetryCapCents({ gateDisplayCents: 1991, isComp: false, ...FEES });
        expect(1900 > cap).toBe(true);
    });

    it("is unbounded for comp labels — SendMo absorbs the cost by design", () => {
        expect(rerateRetryCapCents({ gateDisplayCents: 1991, isComp: true, ...FEES }))
            .toBe(Number.POSITIVE_INFINITY);
    });

    it("is unbounded when there is no charge to protect", () => {
        expect(rerateRetryCapCents({ gateDisplayCents: 0, isComp: false, ...FEES }))
            .toBe(Number.POSITIVE_INFINITY);
    });
});
