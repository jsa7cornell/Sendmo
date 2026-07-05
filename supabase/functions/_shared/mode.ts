// resolveLiveMode — the single server-side live/test mode policy.
//
// Decided proposal: 2026-07-04_customer-live-payments (T1-1), §3.2 as amended
// by review B1/B2/N6 + the recorded Decision:
//   • admin: explicit toolbar control (admin_active_mode) — unchanged from
//     the dogfood-era derivation. live_charge → live; live_comp → comp.
//   • authenticated non-admin: SENDMO_LIVE_DEFAULT === "true" decides (the
//     env signal doubles as the kill switch). Comp stays admin-only.
//   • unauthenticated: ALWAYS test, even with the env signal set (decided
//     OQ3 — an anonymous API caller can never resolve live; guarantees
//     Account Budget coverage on every live charge).
//
// This policy is hand-mirrored in the client (src/contexts/AuthContext.tsx)
// for publishable-key selection — N4. The truth table in
// tests/unit/mode.test.ts is the shared contract; keep both sides in sync.
//
// Comp AUTHORIZATION is not decided here (review nit): callers still enforce
// their own admin-JWT / flex-link gates. This answers mode, not permission.

export interface ModeCaller {
    callerRole: string | null;
    callerAdminMode: string | null;
    isAuthenticated: boolean;
}

// getEnv is injectable so Vitest can exercise the truth table without a Deno
// global; the default reads Deno only at call time (never module scope) so
// the module is importable under Node.
export function resolveLiveMode(
    caller: ModeCaller,
    getEnv: (k: string) => string | undefined = (k) => Deno.env.get(k),
): { isLive: boolean; isComp: boolean } {
    if (!caller.isAuthenticated) {
        return { isLive: false, isComp: false };
    }
    if (caller.callerRole === "admin") {
        return {
            isLive: caller.callerAdminMode === "live_charge",
            isComp: caller.callerAdminMode === "live_comp",
        };
    }
    return { isLive: getEnv("SENDMO_LIVE_DEFAULT") === "true", isComp: false };
}
