// Unit tests for the T2-4 key-mismatch guard
// (supabase/functions/_shared/env-guard.ts) — T1-1 customer-live-payments.
//
// The guard is keyed on SENDMO_ENV === "production" (environment IDENTITY),
// deliberately NOT on SENDMO_LIVE_DEFAULT (the kill switch) — review B5:
// flipping the kill switch mid-incident must not disarm the guard.

import { describe, it, expect } from "vitest";
import { assertKeysMatchEnv } from "../../supabase/functions/_shared/env-guard.ts";

const MISMATCH_MSG = "FATAL: Environment key mismatch — test key present in production";

function env(vars: Record<string, string>): (k: string) => string | undefined {
    return (k) => vars[k];
}

describe("assertKeysMatchEnv — SENDMO_ENV=production", () => {
    it("throws when EASYPOST_API_KEY is a test key (EZTK…)", () => {
        expect(() =>
            assertKeysMatchEnv(env({
                SENDMO_ENV: "production",
                EASYPOST_API_KEY: "EZTKabc123",
                STRIPE_SECRET_KEY_LIVE: "sk_live_abc",
            })),
        ).toThrow(MISMATCH_MSG);
    });

    it("throws when STRIPE_SECRET_KEY is a test key (sk_test_…)", () => {
        expect(() =>
            assertKeysMatchEnv(env({
                SENDMO_ENV: "production",
                EASYPOST_API_KEY: "EZAKabc123",
                STRIPE_SECRET_KEY: "sk_test_abc",
            })),
        ).toThrow(MISMATCH_MSG);
    });

    it("throws when STRIPE_SECRET_KEY_LIVE is a test key (the primary live slot in _shared/stripe.ts)", () => {
        expect(() =>
            assertKeysMatchEnv(env({
                SENDMO_ENV: "production",
                EASYPOST_API_KEY: "EZAKabc123",
                STRIPE_SECRET_KEY_LIVE: "sk_test_abc",
            })),
        ).toThrow(MISMATCH_MSG);
    });

    it("passes with live keys in every slot", () => {
        expect(() =>
            assertKeysMatchEnv(env({
                SENDMO_ENV: "production",
                EASYPOST_API_KEY: "EZAKabc123",
                STRIPE_SECRET_KEY_LIVE: "sk_live_abc",
                STRIPE_SECRET_KEY: "sk_live_abc",
            })),
        ).not.toThrow();
    });

    it("passes when keys are absent — the guard checks mismatch, not presence (missing keys fail per-callsite)", () => {
        expect(() => assertKeysMatchEnv(env({ SENDMO_ENV: "production" }))).not.toThrow();
    });
});

describe("assertKeysMatchEnv — outside production it is a no-op", () => {
    it("SENDMO_ENV unset + test keys → no-op (local/dev/preview: today's reality)", () => {
        expect(() =>
            assertKeysMatchEnv(env({
                EASYPOST_API_KEY: "EZTKabc123",
                STRIPE_SECRET_KEY: "sk_test_abc",
            })),
        ).not.toThrow();
    });

    it("SENDMO_ENV=staging + test keys → no-op", () => {
        expect(() =>
            assertKeysMatchEnv(env({
                SENDMO_ENV: "staging",
                EASYPOST_API_KEY: "EZTKabc123",
                STRIPE_SECRET_KEY: "sk_test_abc",
            })),
        ).not.toThrow();
    });

    it("stays armed regardless of the kill switch — SENDMO_LIVE_DEFAULT=false does not disarm it (B5)", () => {
        expect(() =>
            assertKeysMatchEnv(env({
                SENDMO_ENV: "production",
                SENDMO_LIVE_DEFAULT: "false",
                EASYPOST_API_KEY: "EZTKabc123",
            })),
        ).toThrow(MISMATCH_MSG);
    });
});

describe("assertKeysMatchEnv — default getEnv reads Deno at call time", () => {
    it("uses Deno.env.get when getEnv is omitted", () => {
        const priorDeno = (globalThis as Record<string, unknown>).Deno;
        const vars: Record<string, string> = {
            SENDMO_ENV: "production",
            EASYPOST_API_KEY: "EZTKabc123",
        };
        (globalThis as Record<string, unknown>).Deno = {
            env: { get: (k: string) => vars[k] },
        };
        try {
            expect(() => assertKeysMatchEnv()).toThrow(MISMATCH_MSG);
        } finally {
            (globalThis as Record<string, unknown>).Deno = priorDeno;
        }
    });
});
