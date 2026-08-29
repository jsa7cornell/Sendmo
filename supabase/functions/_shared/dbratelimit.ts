// DB-backed shared rate limiter for the MONEY paths (PR2 of the seller-link
// launch proposal, decided 2026-08-29).
//
// The in-memory limiter (_shared/ratelimit.ts) is per-isolate: concurrent
// requests land in separate empty maps and all pass, so it cannot hold on
// paths that move money or spend EasyPost quota per call. This wraps the
// rate_limit_hit RPC (migration 046) — one shared fixed-window counter.
//
// FAIL-OPEN by design: a limiter must never take down the buy path. On any
// RPC error the caller is allowed through and `failedOpen` is set so the
// caller can log it. Keep the in-memory limiter in front where it already
// exists — it's free and absorbs single-isolate bursts even when the DB
// check degrades.
//
// Pure TypeScript, client injected — Vitest imports it directly (ratelimit.ts
// / budget.ts pattern). Truth table: tests/unit/dbRateLimit.test.ts.

export interface DbRateLimitOptions {
    /** Maximum requests allowed per window. */
    max: number;
    /** Fixed-window length in seconds. */
    windowSeconds: number;
}

export interface DbRateLimitResult {
    /** True when the call should be rejected. */
    rejected: boolean;
    /** True when the RPC errored and the call was allowed through. */
    failedOpen: boolean;
    /** The RPC error message when failedOpen. */
    error: string | null;
}

// Minimal client surface — the supabase-js client satisfies this.
export interface RpcClient {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

// Once-per-isolate gate for the "limiter is failing open" admin alert
// (review PR2-#6): if the functions deploy before migration 046 lands (or
// the RPC breaks), EVERY money-path request fails open — a warn log per
// request reads as noise, while one email says "the limiter is off". Resets
// on cold start, which is the right cadence for re-noticing.
let failedOpenAlertSent = false;
export function shouldAlertFailedOpen(): boolean {
    if (failedOpenAlertSent) return false;
    failedOpenAlertSent = true;
    return true;
}

/** Test-only: reset the once-per-isolate alert gate. */
export function _resetFailedOpenAlert(): void {
    failedOpenAlertSent = false;
}

export async function checkDbRateLimit(
    client: RpcClient,
    key: string,
    { max, windowSeconds }: DbRateLimitOptions,
): Promise<DbRateLimitResult> {
    try {
        const { data, error } = await client.rpc("rate_limit_hit", {
            p_key: key,
            p_window_seconds: windowSeconds,
            p_max: max,
        });
        if (error) return { rejected: false, failedOpen: true, error: error.message };
        return { rejected: data === true, failedOpen: false, error: null };
    } catch (err) {
        return {
            rejected: false,
            failedOpen: true,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
