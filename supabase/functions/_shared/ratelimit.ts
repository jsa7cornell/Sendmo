// Shared in-memory sliding-window rate limiter (PRE-LAUNCH T2-3).
//
// Extracted from the inline copies that lived in cancel-label, labels,
// refunds, and label-print. One definition, many call sites (Rule 6).
//
// Scope caveat (same as the inline originals): the bucket is per-isolate.
// Edge-function instances and cold starts don't share it, so this is a
// speed bump against casual abuse/quota burn, not a hard guarantee. If
// real abuse appears, escalate to a DB/Upstash-backed limiter (WISHLIST).
//
// Pure TypeScript — no Deno APIs — so Vitest imports it directly
// (same pattern as budget.ts / ledger.ts / intents.ts).

export interface RateLimitOptions {
    /** Maximum requests allowed per window. */
    max: number;
    /** Window length in milliseconds. */
    windowMs: number;
}

// Prune the whole bucket when it holds this many keys — keeps a
// long-lived isolate from accumulating one entry per unique IP forever.
const PRUNE_THRESHOLD = 10_000;

const bucket = new Map<string, number[]>();

/**
 * Returns true when the call identified by `key` should be REJECTED
 * (i.e. it would exceed `max` requests within the trailing `windowMs`).
 * Records the call's timestamp when allowed.
 *
 * `now` is injectable for tests; defaults to Date.now().
 */
export function checkRateLimit(
    key: string,
    { max, windowMs }: RateLimitOptions,
    now: number = Date.now(),
): boolean {
    if (bucket.size >= PRUNE_THRESHOLD) {
        for (const [k, arr] of bucket) {
            if (arr.every((t) => now - t >= windowMs)) bucket.delete(k);
        }
    }
    const arr = (bucket.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
        bucket.set(key, arr);
        return true;
    }
    arr.push(now);
    bucket.set(key, arr);
    return false;
}

/**
 * Client IP from the standard proxy headers, for use as a rate-limit key.
 * Falls back to "unknown" — which means all unidentifiable callers share
 * one bucket (fail-closed-ish; acceptable for a speed bump).
 */
export function clientIpKey(req: Request): string {
    // SECURITY (pre-launch review 2026-07-06, M2): use the LAST x-forwarded-for
    // hop, not the first. The list is `client, proxy1, …, edge` — an attacker
    // can PREPEND arbitrary values, so the leftmost entry ([0], the old
    // behavior) is client-controlled: a per-request random X-Forwarded-For
    // landed every call in a fresh bucket and defeated the limiter entirely.
    // The trusted edge appends the real observed IP last, so the rightmost hop
    // is the spoof-resistant one to key on.
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
        const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
        if (parts.length > 0) return parts[parts.length - 1];
    }
    return req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Test-only: clear the shared bucket between test cases. */
export function _resetRateLimitBucket(): void {
    bucket.clear();
}
