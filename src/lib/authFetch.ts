// ─── Refresh-retry fetch wrapper — Phase 1 of the session-durability fix ────
//
// auth-js's _recoverAndRefresh destroys the stored session when a token
// refresh returns anything it doesn't classify as retryable, and retryable is
// only network failures + 502/503/504 (auth-js lib/fetch.js NETWORK_ERROR_CODES).
// A single 429 or 500 on the one refresh a laptop makes after waking is a
// permanent silent logout.
//
// This wrapper intercepts ONLY the refresh-token grant. Session-killing
// statuses (429/500) get a bounded retry with backoff; if they persist, the
// response is rewritten to a synthetic 503 so auth-js keeps the session and
// retries on its own schedule. Every failed attempt is breadcrumbed.
//
// Deliberately untouched: 502/503/504 (auth-js already retries them), all
// other grants (a 429 on a password/OTP sign-in should surface to the user),
// and every non-token URL.

import { recordRefreshFailure } from "./authBreadcrumbs";

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
// A single Retry-After beyond this would hang app boot — bail to the synthetic
// 503 instead and let auth-js's own retry cadence pick it up later.
const MAX_DELAY_MS = 8_000;
// Hard ceiling on the whole retry window, measured from the first attempt.
// Refresh-token rotation runs with a 10s reuse interval (SPEC §17): if attempt
// 1 reached GoTrue and rotation committed but the response was lost as a 500,
// re-sending the now-consumed token OUTSIDE that interval reads as replay and
// revokes the whole session family — the exact logout this wrapper prevents.
// Staying under 9s keeps every retry inside the grace window, and also bounds
// how long a rate-limited wake can hold the boot spinner.
const MAX_TOTAL_MS = 9_000;

function isSessionKillingStatus(status: number): boolean {
  return status === 429 || status === 500;
}

function retryDelayMs(attempt: number, retryAfter: string | null): number | null {
  if (retryAfter) {
    // Delta-seconds form ("120") or HTTP-date form ("Wed, 21 Oct 2026 …") —
    // both are valid per RFC 9110.
    const seconds = Number(retryAfter);
    let ms: number | null = null;
    if (Number.isFinite(seconds)) {
      ms = seconds * 1000;
    } else {
      const dateMs = Date.parse(retryAfter);
      if (!Number.isNaN(dateMs)) ms = dateMs - Date.now();
    }
    if (ms !== null) {
      return ms > MAX_DELAY_MS ? null : Math.max(ms, 0); // null = don't wait, bail now
    }
    // Unparseable header — fall through to backoff.
  }
  return BASE_DELAY_MS * 2 ** (attempt - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bodySnippet(res: Response): Promise<string> {
  try {
    return (await res.clone().text()).slice(0, 300);
  } catch {
    return "";
  }
}

function syntheticRetryable(last: Response, snippet: string): Response {
  return new Response(snippet || JSON.stringify({ error: "refresh_retry_exhausted" }), {
    status: 503,
    statusText: "Service Unavailable (SendMo refresh-retry wrapper)",
    headers: { "Content-Type": last.headers.get("Content-Type") ?? "application/json" },
  });
}

export async function fetchWithRefreshRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

  // A Request object's body can only be consumed once, so it can't be
  // re-sent; supabase-js always calls fetch(stringUrl, init), so this only
  // guards against future callers.
  const retryable =
    typeof input !== "object" || input instanceof URL
      ? url.includes("/auth/v1/token") && url.includes("grant_type=refresh_token")
      : false;
  if (!retryable) return fetch(input, init);

  const startedAt = Date.now();
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(input, init);
    if (!isSessionKillingStatus(res.status)) return res;

    // One sentinel: delay === null means no more waiting — attempts spent,
    // Retry-After too long, or the next attempt would land outside the
    // rotation reuse window (MAX_TOTAL_MS).
    let delay =
      attempt < MAX_ATTEMPTS ? retryDelayMs(attempt, res.headers.get("Retry-After")) : null;
    if (delay !== null && Date.now() + delay - startedAt > MAX_TOTAL_MS) delay = null;

    const snippet = await bodySnippet(res);
    recordRefreshFailure({
      endpoint: url,
      status: res.status,
      attempt,
      final: delay === null,
      bodySnippet: snippet,
    });
    if (delay === null) return syntheticRetryable(res, snippet);
    await sleep(delay);
  }
}
