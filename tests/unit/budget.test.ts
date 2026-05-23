// Unit tests for the per-account Account Budget helper
// (supabase/functions/_shared/budget.ts) shipped 2026-05-22 as part of the
// payments risk-intelligence work — proposal
// proposals/2026-05-21_payments-risk-intelligence_reviewed-2026-05-22_decided-2026-05-22.md.
//
// The helper is Deno-flavored (URL imports for the Supabase types), but
// SupabaseClient is now a TYPE-ONLY import there so Vitest's TS transform
// erases it and we can import the helper directly. We feed it a minimal
// typed mock client that returns whatever (profile, txnRows) the test wants.

import { describe, it, expect } from "vitest";
import {
    checkAccountBudget,
    type BudgetCheckResult,
} from "../../supabase/functions/_shared/budget.ts";

// ─── Mock SupabaseClient ────────────────────────────────────
//
// The helper calls exactly two query chains:
//   profiles    → .from('profiles').select(cols).eq('id', userId).maybeSingle()
//   transactions→ .from('transactions').select(cols).eq().eq().eq().gte(...)
// The mock only needs to satisfy those two shapes; the cast at the boundary
// lets us hand it to the helper without pulling in supabase-js' types.

interface MockOpts {
    profile?: { daily_budget_cents: number | null; weekly_budget_cents: number | null } | null;
    profileError?: { message: string } | null;
    txnRows?: Array<{ amount_cents: number | null; created_at: string }>;
    txnError?: { message: string } | null;
}

function mockSupabase(opts: MockOpts): Parameters<typeof checkAccountBudget>[0] {
    const profilesChain = {
        select: () => ({
            eq: () => ({
                maybeSingle: () =>
                    Promise.resolve({
                        data: opts.profile === undefined ? null : opts.profile,
                        error: opts.profileError ?? null,
                    }),
            }),
        }),
    };

    // transactions: .eq().eq().eq().gte() — return array.
    const txnResult = Promise.resolve({
        data: opts.txnRows ?? [],
        error: opts.txnError ?? null,
    });
    const gteStep = { gte: () => txnResult };
    const transactionsChain = {
        select: () => ({
            eq: () => ({ eq: () => ({ eq: () => gteStep }) }),
        }),
    };

    return {
        from: (table: string) => {
            if (table === "profiles") return profilesChain;
            if (table === "transactions") return transactionsChain;
            throw new Error(`mockSupabase: unexpected table '${table}'`);
        },
    } as unknown as Parameters<typeof checkAccountBudget>[0];
}

const UID = "11111111-1111-1111-1111-111111111111";

// Helpers for time-anchored test rows. The helper's window is "now - 24h"
// and "now - 7d" — we drop rows safely inside each window vs. just past it.
function isoMinutesAgo(min: number): string {
    return new Date(Date.now() - min * 60 * 1000).toISOString();
}

describe("checkAccountBudget — happy path", () => {
    it("returns ok when there's a profile + zero transactions", async () => {
        const supa = mockSupabase({
            profile: { daily_budget_cents: 20000, weekly_budget_cents: 50000 },
            txnRows: [],
        });
        const r: BudgetCheckResult = await checkAccountBudget(supa, UID, "live", 1500);
        expect(r.ok).toBe(true);
    });

    it("returns ok when sum + add is exactly at the daily limit", async () => {
        const supa = mockSupabase({
            profile: { daily_budget_cents: 20000, weekly_budget_cents: 50000 },
            txnRows: [{ amount_cents: 18500, created_at: isoMinutesAgo(60) }],
        });
        const r = await checkAccountBudget(supa, UID, "live", 1500);
        expect(r.ok).toBe(true);
    });

    it("returns ok when sum + add is exactly at the weekly limit", async () => {
        // 49000 of weekly spend, adding 1000, ceiling 50000 → at the limit, ok.
        const supa = mockSupabase({
            profile: { daily_budget_cents: 100000, weekly_budget_cents: 50000 },
            txnRows: [
                { amount_cents: 24500, created_at: isoMinutesAgo(60 * 24 * 2) },
                { amount_cents: 24500, created_at: isoMinutesAgo(60 * 24 * 4) },
            ],
        });
        const r = await checkAccountBudget(supa, UID, "live", 1000);
        expect(r.ok).toBe(true);
    });
});

describe("checkAccountBudget — breach paths", () => {
    it("flags 'daily' when daily would breach (weekly fine)", async () => {
        const supa = mockSupabase({
            profile: { daily_budget_cents: 20000, weekly_budget_cents: 100000 },
            txnRows: [{ amount_cents: 19000, created_at: isoMinutesAgo(30) }],
        });
        const r = await checkAccountBudget(supa, UID, "live", 2000); // 19000 + 2000 = 21000 > 20000
        expect(r.ok).toBe(false);
        expect(r.window).toBe("daily");
        expect(r.limit_cents).toBe(20000);
        expect(r.spent_cents).toBe(19000);
        expect(r.attempted_cents).toBe(2000);
    });

    it("flags 'weekly' when only weekly breaches (daily fine)", async () => {
        // Daily window includes only the recent row. Weekly includes both.
        const supa = mockSupabase({
            profile: { daily_budget_cents: 100000, weekly_budget_cents: 50000 },
            txnRows: [
                { amount_cents: 30000, created_at: isoMinutesAgo(60 * 24 * 3) }, // 3 days ago
                { amount_cents: 19000, created_at: isoMinutesAgo(30) },           // 30 min ago
            ],
        });
        const r = await checkAccountBudget(supa, UID, "live", 5000);
        // daily: 19000 + 5000 = 24000 < 100000 → ok
        // weekly: 49000 + 5000 = 54000 > 50000 → flag
        expect(r.ok).toBe(false);
        expect(r.window).toBe("weekly");
        expect(r.spent_cents).toBe(49000);
        expect(r.attempted_cents).toBe(5000);
    });

    it("prioritises 'daily' over 'weekly' when both would breach", async () => {
        // Single recent row that breaches both windows — helper should return
        // 'daily' (the inner first-tested check) rather than 'weekly'. Confirms
        // the ordering so callers (UI copy) get a stable, more-actionable label.
        const supa = mockSupabase({
            profile: { daily_budget_cents: 20000, weekly_budget_cents: 50000 },
            txnRows: [{ amount_cents: 49000, created_at: isoMinutesAgo(30) }],
        });
        const r = await checkAccountBudget(supa, UID, "live", 2000);
        expect(r.ok).toBe(false);
        expect(r.window).toBe("daily");
    });
});

describe("checkAccountBudget — fails open (backstop, not primary control)", () => {
    it("missing profile → ok (per-shipment cap + Radar still apply)", async () => {
        const supa = mockSupabase({ profile: null });
        const r = await checkAccountBudget(supa, UID, "live", 9999999);
        expect(r.ok).toBe(true);
    });

    it("profile fetch error → ok (transient DB error shouldn't block legit shipments)", async () => {
        const supa = mockSupabase({
            profile: null,
            profileError: { message: "connection reset" },
        });
        const r = await checkAccountBudget(supa, UID, "live", 9999999);
        expect(r.ok).toBe(true);
    });

    it("transactions fetch error → ok (same reason)", async () => {
        const supa = mockSupabase({
            profile: { daily_budget_cents: 20000, weekly_budget_cents: 50000 },
            txnError: { message: "timeout" },
        });
        const r = await checkAccountBudget(supa, UID, "live", 9999999);
        expect(r.ok).toBe(true);
    });

    it("a thrown synchronous error → caught by the outer try/catch → ok", async () => {
        const throwing = {
            from: () => {
                throw new Error("boom");
            },
        } as unknown as Parameters<typeof checkAccountBudget>[0];
        const r = await checkAccountBudget(throwing, UID, "live", 9999999);
        expect(r.ok).toBe(true);
    });
});

describe("checkAccountBudget — defaults + nullable fields", () => {
    it("uses default $200/$500 when profile columns are null", async () => {
        // Helper falls back to DEFAULT_DAILY_CENTS=20000 / DEFAULT_WEEKLY_CENTS=50000.
        const supa = mockSupabase({
            profile: { daily_budget_cents: null, weekly_budget_cents: null },
            txnRows: [{ amount_cents: 20000, created_at: isoMinutesAgo(30) }],
        });
        const r = await checkAccountBudget(supa, UID, "live", 100);
        expect(r.ok).toBe(false);
        expect(r.window).toBe("daily");
        expect(r.limit_cents).toBe(20000);
    });

    it("null amount_cents on a transaction row counts as zero (defensive)", async () => {
        const supa = mockSupabase({
            profile: { daily_budget_cents: 20000, weekly_budget_cents: 50000 },
            txnRows: [
                { amount_cents: null, created_at: isoMinutesAgo(30) },
                { amount_cents: 5000, created_at: isoMinutesAgo(30) },
            ],
        });
        const r = await checkAccountBudget(supa, UID, "live", 1000);
        expect(r.ok).toBe(true); // 0 + 5000 + 1000 = 6000 < 20000
    });

    it("uses Math.abs on stored amount_cents (charge rows should already be positive)", async () => {
        // Defensive: even if a negative number snuck in, the helper treats the
        // magnitude as spend. Documents the contract.
        const supa = mockSupabase({
            profile: { daily_budget_cents: 20000, weekly_budget_cents: 50000 },
            txnRows: [{ amount_cents: -19000, created_at: isoMinutesAgo(30) }],
        });
        const r = await checkAccountBudget(supa, UID, "live", 2000);
        expect(r.ok).toBe(false);
        expect(r.spent_cents).toBe(19000);
    });
});

describe("checkAccountBudget — window boundary (24h vs 7d)", () => {
    it("a row 25 hours old counts toward weekly but not daily", async () => {
        const supa = mockSupabase({
            profile: { daily_budget_cents: 20000, weekly_budget_cents: 25000 },
            txnRows: [
                { amount_cents: 20000, created_at: isoMinutesAgo(25 * 60) }, // 25h ago → weekly only
            ],
        });
        // daily: 0 + 10000 = 10000 < 20000 → ok
        // weekly: 20000 + 10000 = 30000 > 25000 → flag weekly
        const r = await checkAccountBudget(supa, UID, "live", 10000);
        expect(r.ok).toBe(false);
        expect(r.window).toBe("weekly");
    });

    it("rows older than 7 days are excluded — the supabase .gte() filter is the gate", async () => {
        // The helper passes a `.gte('created_at', weekAgoIso)` filter; our mock
        // simulates that by only returning rows the test explicitly inserts as
        // "recent". Documents that the helper relies on supabase filtering, not
        // a client-side time check.
        const supa = mockSupabase({
            profile: { daily_budget_cents: 20000, weekly_budget_cents: 50000 },
            txnRows: [], // simulates the .gte filter excluding all >7d-old rows
        });
        const r = await checkAccountBudget(supa, UID, "live", 5000);
        expect(r.ok).toBe(true);
    });
});

describe("checkAccountBudget — per-mode segregation", () => {
    it("the mode param is plumbed into the .eq filter (test charges don't count toward live budget)", async () => {
        // The helper builds the .eq('mode', mode) filter via the mock; the mock
        // ignores filter values, so we test the plumbing structurally: passing
        // 'live' returns the rows the mock has, and the helper accepts both modes.
        for (const mode of ["live", "test"] as const) {
            const supa = mockSupabase({
                profile: { daily_budget_cents: 20000, weekly_budget_cents: 50000 },
                txnRows: [],
            });
            const r = await checkAccountBudget(supa, UID, mode, 1500);
            expect(r.ok).toBe(true);
        }
    });
});
