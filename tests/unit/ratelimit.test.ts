// Unit tests for the shared sliding-window rate limiter
// (supabase/functions/_shared/ratelimit.ts) — PRE-LAUNCH T2-3.
//
// Extracted 2026-07-04 from the inline copies in cancel-label / labels /
// refunds / label-print, then applied to the previously-unprotected public
// endpoints (addresses, rates, guestimate, autocomplete, place-details).
//
// The helper is pure TypeScript (no Deno APIs), so Vitest imports it
// directly — same pattern as budget.ts / ledger.ts / intents.ts.

import { describe, it, expect, beforeEach } from "vitest";
import {
    checkRateLimit,
    clientIpKey,
    _resetRateLimitBucket,
} from "../../supabase/functions/_shared/ratelimit.ts";

const OPTS = { max: 5, windowMs: 60_000 };
const T0 = 1_000_000; // fixed base timestamp — injected, never Date.now()

beforeEach(() => {
    _resetRateLimitBucket();
});

describe("checkRateLimit", () => {
    it("allows up to max requests within the window", () => {
        for (let i = 0; i < OPTS.max; i++) {
            expect(checkRateLimit("k", OPTS, T0 + i)).toBe(false);
        }
    });

    it("rejects the (max+1)th request within the window", () => {
        for (let i = 0; i < OPTS.max; i++) checkRateLimit("k", OPTS, T0 + i);
        expect(checkRateLimit("k", OPTS, T0 + OPTS.max)).toBe(true);
    });

    it("allows again once the window slides past old requests", () => {
        for (let i = 0; i < OPTS.max; i++) checkRateLimit("k", OPTS, T0 + i);
        expect(checkRateLimit("k", OPTS, T0 + 10)).toBe(true);
        // All 5 recorded stamps are now ≥ windowMs old → allowed again.
        expect(checkRateLimit("k", OPTS, T0 + OPTS.windowMs + 5)).toBe(false);
    });

    it("rejected requests do not consume window slots", () => {
        for (let i = 0; i < OPTS.max; i++) checkRateLimit("k", OPTS, T0 + i);
        // Hammer 100 rejected attempts — none should extend the block.
        for (let i = 0; i < 100; i++) {
            expect(checkRateLimit("k", OPTS, T0 + 100 + i)).toBe(true);
        }
        // Original 5 stamps age out; the 100 rejections left no trace.
        expect(checkRateLimit("k", OPTS, T0 + OPTS.windowMs + 5)).toBe(false);
    });

    it("tracks keys independently", () => {
        for (let i = 0; i < OPTS.max; i++) checkRateLimit("a", OPTS, T0 + i);
        expect(checkRateLimit("a", OPTS, T0 + 10)).toBe(true);
        expect(checkRateLimit("b", OPTS, T0 + 10)).toBe(false);
    });

    it("respects per-call options (different max/window per endpoint)", () => {
        const tight = { max: 1, windowMs: 1_000 };
        expect(checkRateLimit("k", tight, T0)).toBe(false);
        expect(checkRateLimit("k", tight, T0 + 1)).toBe(true);
        expect(checkRateLimit("k", tight, T0 + 1_001)).toBe(false);
    });
});

describe("clientIpKey", () => {
    it("takes the first hop of x-forwarded-for, trimmed", () => {
        const req = new Request("http://x", {
            headers: { "x-forwarded-for": " 1.2.3.4 , 5.6.7.8" },
        });
        expect(clientIpKey(req)).toBe("1.2.3.4");
    });

    it("falls back to x-real-ip", () => {
        const req = new Request("http://x", {
            headers: { "x-real-ip": "9.9.9.9" },
        });
        expect(clientIpKey(req)).toBe("9.9.9.9");
    });

    it('falls back to "unknown" when no headers are present', () => {
        expect(clientIpKey(new Request("http://x"))).toBe("unknown");
    });
});
