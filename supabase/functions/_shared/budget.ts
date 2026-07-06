// _shared/budget.ts
//
// Account Budget — per-account cumulative spending limit (proposal
// 2026-05-21_payments-risk-intelligence, B5). One budget per SendMo account:
// $200/day + $500/week (defaults; profiles.daily_/weekly_budget_cents,
// admin-raised via the set_account_budget RPC). Counts every charge against
// the account — flex (2a) and full-label (2b) — summed per mode.
//
// Enforced BEFORE the PaymentIntent is created, in the labels and payments
// Edge Functions. A breach refuses the charge (402) at the call site.
//
// Source of truth: the `transactions` ledger (type='charge'), the same
// append-only table the stripe-webhook writes. Note: transactions rows land
// when the webhook processes payment_intent.succeeded — slightly after the
// charge itself — so two near-simultaneous charges could both pass the gate.
// Acceptable at SendMo's volume; revisit if real concurrency emerges.

// Type-only import — at runtime TypeScript erases this so Vitest doesn't need
// to resolve the remote URL. Lets `tests/unit/budget.test.ts` import this
// helper directly and feed it a typed mock client.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.97.0";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// Fallback defaults — mirror the migration-031 column defaults. Used only if
// a profile row somehow lacks the columns (it shouldn't, post-031).
const DEFAULT_DAILY_CENTS = 20000;
const DEFAULT_WEEKLY_CENTS = 50000;

export interface BudgetCheckResult {
    ok: boolean;
    window?: "daily" | "weekly";
    limit_cents?: number;
    spent_cents?: number;
    attempted_cents?: number;
}

/**
 * Check whether charging `addCents` to `userId` would breach the account's
 * daily or weekly spending budget for `mode`. Returns { ok: true } when the
 * charge is within budget, or { ok: false, window, ... } when it would breach.
 *
 * Fails OPEN (returns ok) if the profile or ledger can't be read — the budget
 * is a backstop, not the primary control; Radar + the per-shipment cap still
 * apply, and a hard-fail here would block legitimate shipments on a transient
 * DB error.
 */
export async function checkAccountBudget(
    supabase: SupabaseClient,
    userId: string,
    mode: "live" | "test",
    addCents: number,
): Promise<BudgetCheckResult> {
    try {
        const { data: profile, error: profErr } = await supabase
            .from("profiles")
            .select("daily_budget_cents, weekly_budget_cents")
            .eq("id", userId)
            .maybeSingle();
        if (profErr || !profile) return { ok: true };

        const dailyLimit =
            (profile.daily_budget_cents as number | null) ?? DEFAULT_DAILY_CENTS;
        const weeklyLimit =
            (profile.weekly_budget_cents as number | null) ?? DEFAULT_WEEKLY_CENTS;

        const now = Date.now();
        const weekAgoIso = new Date(now - WEEK_MS).toISOString();
        const dayAgoMs = now - DAY_MS;

        // The weekly window is the superset — one query, split daily in JS.
        const { data: rows, error: txErr } = await supabase
            .from("transactions")
            .select("amount_cents, created_at")
            .eq("user_id", userId)
            .eq("type", "charge")
            .eq("mode", mode)
            .gte("created_at", weekAgoIso);
        if (txErr) return { ok: true };

        let weeklySpent = 0;
        let dailySpent = 0;
        for (const r of rows ?? []) {
            const amt = Math.abs((r.amount_cents as number | null) ?? 0);
            weeklySpent += amt;
            if (new Date(r.created_at as string).getTime() >= dayAgoMs) {
                dailySpent += amt;
            }
        }

        if (dailySpent + addCents > dailyLimit) {
            return {
                ok: false, window: "daily", limit_cents: dailyLimit,
                spent_cents: dailySpent, attempted_cents: addCents,
            };
        }
        if (weeklySpent + addCents > weeklyLimit) {
            return {
                ok: false, window: "weekly", limit_cents: weeklyLimit,
                spent_cents: weeklySpent, attempted_cents: addCents,
            };
        }
        return { ok: true };
    } catch {
        return { ok: true };
    }
}
