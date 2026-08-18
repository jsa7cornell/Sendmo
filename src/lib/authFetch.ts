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
// A Retry-After beyond this would hang app boot — bail to the synthetic 503
// instead and let auth-js's own retry cadence pick it up later.
const MAX_DELAY_MS = 8_000;

function isSessionKillingStatus(status: number): boolean {
  return status === 429 || status === 500;
}

function retryDelayMs(attempt: number, retryAfter: string | null): number | null {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      const ms = seconds * 1000;
      return ms > MAX_DELAY_MS ? null : ms; // null = don't wait, bail now
    }
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

async function syntheticRetryable(last: Response): Promise<Response> {
  const body = await bodySnippet(last);
  return new Response(body || JSON.stringify({ error: "refresh_retry_exhausted" }), {
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

  let last: Response | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(input, init);
    if (!isSessionKillingStatus(res.status)) return res;
    last = res;

    const delay = attempt < MAX_ATTEMPTS ? retryDelayMs(attempt, res.headers.get("Retry-After")) : 0;
    recordRefreshFailure({
      endpoint: url,
      status: res.status,
      attempt,
      final: attempt === MAX_ATTEMPTS || delay === null,
      bodySnippet: await bodySnippet(res),
    });
    if (delay === null) break;
    if (attempt < MAX_ATTEMPTS) await sleep(delay);
  }
  return syntheticRetryable(last as Response);
}
