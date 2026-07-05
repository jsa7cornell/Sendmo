// Live-charge allowlist gate (T1-1 decided N5/OQ2 — the closed-beta lever).
//
// Extracted 2026-07-05 after the pre-flip security review found the gate was
// enforced only in payments/index.ts (full-label PI), leaving the flex
// off-session charge (labels) and live-link creation (links) ungated — a
// non-allowlisted customer could still transact live end-to-end via the flex
// path during the invite-only beta. One definition, every live-charge entry
// point (Rule 6).
//
// Two levers, both reusing the PAYMENTS_ALLOWED_USERS UID list:
//   • admin live charges  — always gated (empty list = closed). Unchanged
//     behavior; this is the Phase-C dogfood guard.
//   • customer live charges — gated only when PAYMENTS_LIVE_ALLOWLIST_ONLY
//     === "true" (the beta window). Lever false/unset ⇒ any authenticated
//     customer may charge live (subject to the kill switch + risk controls).
//
// Pure TypeScript (Deno reads injectable) so Vitest exercises it directly —
// same pattern as mode.ts / budget.ts.

export type AllowlistRole = "admin" | "customer";

export interface AllowlistResult {
    allowed: boolean;
    /** Populated only when allowed === false — the event_logs `reason`. */
    reason?: "no_user" | "allowlist_empty" | "user_not_allowlisted" | "customer_not_allowlisted";
}

/**
 * Decides whether `userId` may perform a LIVE charge. Call ONLY when the
 * transaction has already resolved to live — a test-mode charge never
 * consults the allowlist.
 *
 * `userId` is the account whose card moves money: the payer for full-label,
 * the LINK OWNER for a flex off-session charge (the anonymous sender has no
 * identity — the vetted party is the recipient who saved the card).
 */
export function checkLiveChargeAllowed(
    role: AllowlistRole,
    userId: string | null,
    getEnv: (k: string) => string | undefined = (k) => Deno.env.get(k),
): AllowlistResult {
    if (role === "customer" && getEnv("PAYMENTS_LIVE_ALLOWLIST_ONLY") !== "true") {
        return { allowed: true };
    }
    // Admin path is always gated; customer path reaches here only under the lever.
    const allowlist = (getEnv("PAYMENTS_ALLOWED_USERS") || "")
        .split(",").map((s) => s.trim()).filter(Boolean);
    if (!userId) return { allowed: false, reason: "no_user" };
    if (allowlist.includes(userId)) return { allowed: true };
    if (role === "customer") return { allowed: false, reason: "customer_not_allowlisted" };
    return {
        allowed: false,
        reason: allowlist.length === 0 ? "allowlist_empty" : "user_not_allowlisted",
    };
}
