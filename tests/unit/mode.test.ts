// Truth-table tests for the shared live/test mode policy
// (supabase/functions/_shared/mode.ts) — T1-1 customer-live-payments.
//
// THIS TABLE IS THE CONTRACT (review N4): the client carries a hand-mirrored
// copy of this policy in src/contexts/AuthContext.tsx for publishable-key
// selection, with a mirrored unit test asserting the same outcomes. If a row
// changes here, the client test must change identically.
//
// Pattern: injectable getEnv (like the typed mocks in budget.test.ts); one
// test stubs the Deno global (alert.test.ts pattern) to prove the default
// getEnv reads Deno at call time, not import time.

import { describe, it, expect } from "vitest";
import { resolveLiveMode, type ModeCaller } from "../../supabase/functions/_shared/mode.ts";

function env(vars: Record<string, string>): (k: string) => string | undefined {
    return (k) => vars[k];
}

const ENV_UNSET = env({});
const ENV_LIVE = env({ SENDMO_LIVE_DEFAULT: "true" });
const ENV_KILLED = env({ SENDMO_LIVE_DEFAULT: "false" });

function admin(mode: string): ModeCaller {
    return { callerRole: "admin", callerAdminMode: mode, isAuthenticated: true };
}

function customer(adminMode: string | null = null): ModeCaller {
    return { callerRole: "user", callerAdminMode: adminMode, isAuthenticated: true };
}

describe("resolveLiveMode — admin (explicit toolbar control, env-independent)", () => {
    it("admin in test → test/no-comp, env unset", () => {
        expect(resolveLiveMode(admin("test"), ENV_UNSET)).toEqual({ isLive: false, isComp: false });
    });

    it("admin in test → test/no-comp, even with SENDMO_LIVE_DEFAULT=true (toolbar wins)", () => {
        expect(resolveLiveMode(admin("test"), ENV_LIVE)).toEqual({ isLive: false, isComp: false });
    });

    it("admin in live_comp → comp, not live, env unset", () => {
        expect(resolveLiveMode(admin("live_comp"), ENV_UNSET)).toEqual({ isLive: false, isComp: true });
    });

    it("admin in live_comp → comp, not live, even with SENDMO_LIVE_DEFAULT=true", () => {
        expect(resolveLiveMode(admin("live_comp"), ENV_LIVE)).toEqual({ isLive: false, isComp: true });
    });

    it("admin in live_charge → live, not comp, env unset (dogfood path pre-flip)", () => {
        expect(resolveLiveMode(admin("live_charge"), ENV_UNSET)).toEqual({ isLive: true, isComp: false });
    });

    it("admin in live_charge → live, not comp, with SENDMO_LIVE_DEFAULT=true", () => {
        expect(resolveLiveMode(admin("live_charge"), ENV_LIVE)).toEqual({ isLive: true, isComp: false });
    });

    it("admin in live_charge stays live even with the kill switch flipped to false (admin exempt at the mode layer)", () => {
        expect(resolveLiveMode(admin("live_charge"), ENV_KILLED)).toEqual({ isLive: true, isComp: false });
    });

    it("admin with null admin_active_mode → test/no-comp", () => {
        expect(resolveLiveMode(admin(null as unknown as string), ENV_LIVE)).toEqual({ isLive: false, isComp: false });
    });
});

describe("resolveLiveMode — authenticated customer (environment decides)", () => {
    it("customer with SENDMO_LIVE_DEFAULT=true → live (the launch flip)", () => {
        expect(resolveLiveMode(customer(), ENV_LIVE)).toEqual({ isLive: true, isComp: false });
    });

    it("customer with SENDMO_LIVE_DEFAULT=false → test (kill switch)", () => {
        expect(resolveLiveMode(customer(), ENV_KILLED)).toEqual({ isLive: false, isComp: false });
    });

    it("customer with SENDMO_LIVE_DEFAULT unset → test (ship-inert default: today's behavior)", () => {
        expect(resolveLiveMode(customer(), ENV_UNSET)).toEqual({ isLive: false, isComp: false });
    });

    it("customer never gets comp — even with a stale live_comp admin_active_mode column", () => {
        expect(resolveLiveMode(customer("live_comp"), ENV_LIVE)).toEqual({ isLive: true, isComp: false });
    });

    it("null role (profile row missing) is a customer, not an admin", () => {
        expect(
            resolveLiveMode({ callerRole: null, callerAdminMode: "live_charge", isAuthenticated: true }, ENV_UNSET),
        ).toEqual({ isLive: false, isComp: false });
    });
});

describe("resolveLiveMode — anonymous (decided OQ3: can NEVER resolve live)", () => {
    it("anonymous with SENDMO_LIVE_DEFAULT=true → still test", () => {
        expect(
            resolveLiveMode({ callerRole: null, callerAdminMode: null, isAuthenticated: false }, ENV_LIVE),
        ).toEqual({ isLive: false, isComp: false });
    });

    it("anonymous with env unset → test", () => {
        expect(
            resolveLiveMode({ callerRole: null, callerAdminMode: null, isAuthenticated: false }, ENV_UNSET),
        ).toEqual({ isLive: false, isComp: false });
    });

    it("anonymous claiming admin/live_charge → test (identity comes from the JWT, not the claim)", () => {
        expect(
            resolveLiveMode({ callerRole: "admin", callerAdminMode: "live_charge", isAuthenticated: false }, ENV_LIVE),
        ).toEqual({ isLive: false, isComp: false });
    });
});

describe("resolveLiveMode — default getEnv reads Deno at call time", () => {
    it("uses Deno.env.get when getEnv is omitted", () => {
        const priorDeno = (globalThis as Record<string, unknown>).Deno;
        (globalThis as Record<string, unknown>).Deno = {
            env: { get: (k: string) => (k === "SENDMO_LIVE_DEFAULT" ? "true" : undefined) },
        };
        try {
            expect(resolveLiveMode(customer())).toEqual({ isLive: true, isComp: false });
        } finally {
            (globalThis as Record<string, unknown>).Deno = priorDeno;
        }
    });
});
