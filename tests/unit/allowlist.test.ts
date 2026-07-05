// Unit tests for the shared live-charge allowlist gate
// (supabase/functions/_shared/allowlist.ts).
//
// Added 2026-07-05 with the security follow-up that closed the flex-path
// allowlist gap: the gate was enforced only in payments (full-label PI),
// leaving labels (flex off-session) and links (live-link creation) ungated.
// This helper is now the single definition all three call.
//
// Pure TS — Vitest exercises the truth table via the injectable getEnv,
// no Deno global needed.

import { describe, it, expect } from "vitest";
import { checkLiveChargeAllowed } from "../../supabase/functions/_shared/allowlist.ts";

// env factory: only the two allowlist vars matter here.
function env(vars: Record<string, string | undefined>) {
    return (k: string) => vars[k];
}

const U = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

describe("checkLiveChargeAllowed — customer role", () => {
    it("lever off/unset: any authenticated customer is allowed", () => {
        expect(checkLiveChargeAllowed("customer", U, env({})).allowed).toBe(true);
        expect(
            checkLiveChargeAllowed("customer", U, env({ PAYMENTS_LIVE_ALLOWLIST_ONLY: "false" })).allowed,
        ).toBe(true);
    });

    it("lever on: allowlisted customer passes", () => {
        const r = checkLiveChargeAllowed("customer", U, env({
            PAYMENTS_LIVE_ALLOWLIST_ONLY: "true",
            PAYMENTS_ALLOWED_USERS: `${OTHER}, ${U}`,
        }));
        expect(r.allowed).toBe(true);
    });

    it("lever on: non-allowlisted customer blocked (customer_not_allowlisted)", () => {
        const r = checkLiveChargeAllowed("customer", U, env({
            PAYMENTS_LIVE_ALLOWLIST_ONLY: "true",
            PAYMENTS_ALLOWED_USERS: OTHER,
        }));
        expect(r.allowed).toBe(false);
        expect(r.reason).toBe("customer_not_allowlisted");
    });

    it("lever on, empty list: every customer blocked", () => {
        const r = checkLiveChargeAllowed("customer", U, env({
            PAYMENTS_LIVE_ALLOWLIST_ONLY: "true",
            PAYMENTS_ALLOWED_USERS: "",
        }));
        expect(r.allowed).toBe(false);
        expect(r.reason).toBe("customer_not_allowlisted");
    });

    it("lever on, null user (shouldn't happen — defensive): blocked no_user", () => {
        const r = checkLiveChargeAllowed("customer", null, env({
            PAYMENTS_LIVE_ALLOWLIST_ONLY: "true",
            PAYMENTS_ALLOWED_USERS: U,
        }));
        expect(r.allowed).toBe(false);
        expect(r.reason).toBe("no_user");
    });
});

describe("checkLiveChargeAllowed — admin role (always gated, lever-independent)", () => {
    it("allowlisted admin passes regardless of the customer lever", () => {
        expect(checkLiveChargeAllowed("admin", U, env({ PAYMENTS_ALLOWED_USERS: U })).allowed).toBe(true);
    });

    it("empty list = closed (allowlist_empty)", () => {
        const r = checkLiveChargeAllowed("admin", U, env({ PAYMENTS_ALLOWED_USERS: "" }));
        expect(r.allowed).toBe(false);
        expect(r.reason).toBe("allowlist_empty");
    });

    it("non-allowlisted admin blocked (user_not_allowlisted)", () => {
        const r = checkLiveChargeAllowed("admin", U, env({ PAYMENTS_ALLOWED_USERS: OTHER }));
        expect(r.allowed).toBe(false);
        expect(r.reason).toBe("user_not_allowlisted");
    });

    it("admin ignores PAYMENTS_LIVE_ALLOWLIST_ONLY (its gate is unconditional)", () => {
        // lever explicitly off, but admin is still gated by the list
        const r = checkLiveChargeAllowed("admin", U, env({
            PAYMENTS_LIVE_ALLOWLIST_ONLY: "false",
            PAYMENTS_ALLOWED_USERS: OTHER,
        }));
        expect(r.allowed).toBe(false);
    });

    it("null admin user blocked no_user", () => {
        const r = checkLiveChargeAllowed("admin", null, env({ PAYMENTS_ALLOWED_USERS: U }));
        expect(r.allowed).toBe(false);
        expect(r.reason).toBe("no_user");
    });
});

describe("list parsing", () => {
    it("trims whitespace and ignores empty segments", () => {
        const r = checkLiveChargeAllowed("customer", U, env({
            PAYMENTS_LIVE_ALLOWLIST_ONLY: "true",
            PAYMENTS_ALLOWED_USERS: `  , ${U} ,,`,
        }));
        expect(r.allowed).toBe(true);
    });
});
