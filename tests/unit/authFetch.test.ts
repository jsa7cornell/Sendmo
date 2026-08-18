import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithRefreshRetry } from "@/lib/authFetch";
import { recordRefreshFailure } from "@/lib/authBreadcrumbs";

vi.mock("@/lib/authBreadcrumbs", () => ({
  recordRefreshFailure: vi.fn(),
}));

// Regression tests for the session-durability Phase 1 fix: a 429 or 500 on
// the refresh-token grant must never reach auth-js as-is, because auth-js
// classifies both as non-retryable and destroys the stored session
// (_recoverAndRefresh → _removeSession). 502/503/504 are already retryable
// inside auth-js and must pass through untouched.

const REFRESH_URL =
  "https://test.supabase.co/auth/v1/token?grant_type=refresh_token";
const PASSWORD_URL =
  "https://test.supabase.co/auth/v1/token?grant_type=password";

function res(status: number, body = '{"error":"x"}', headers: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function run(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const promise = fetchWithRefreshRetry(input, init);
  // Drain all backoff sleeps regardless of how many attempts run.
  await vi.advanceTimersByTimeAsync(60_000);
  return promise;
}

describe("fetchWithRefreshRetry", () => {
  it("passes non-token URLs through untouched, even on 429", async () => {
    fetchMock.mockResolvedValue(res(429));
    const r = await run("https://test.supabase.co/rest/v1/profiles");
    expect(r.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordRefreshFailure).not.toHaveBeenCalled();
  });

  it("passes non-refresh grants through untouched — a sign-in 429 must surface to the user", async () => {
    fetchMock.mockResolvedValue(res(429));
    const r = await run(PASSWORD_URL, { method: "POST" });
    expect(r.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a successful refresh unchanged", async () => {
    fetchMock.mockResolvedValue(res(200, '{"access_token":"t"}'));
    const r = await run(REFRESH_URL, { method: "POST" });
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a refresh 429 and returns the eventual success", async () => {
    fetchMock.mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200, "{}"));
    const r = await run(REFRESH_URL, { method: "POST" });
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordRefreshFailure).toHaveBeenCalledTimes(1);
    expect(recordRefreshFailure).toHaveBeenCalledWith(
      expect.objectContaining({ status: 429, attempt: 1, final: false }),
    );
  });

  it("rewrites a persistent refresh 429 to a synthetic 503 after 3 attempts", async () => {
    fetchMock.mockResolvedValue(res(429));
    const r = await run(REFRESH_URL, { method: "POST" });
    expect(r.status).toBe(503); // 503 is in auth-js's NETWORK_ERROR_CODES → session survives
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(recordRefreshFailure).toHaveBeenCalledTimes(3);
    expect(recordRefreshFailure).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 429, attempt: 3, final: true }),
    );
  });

  it("treats a refresh 500 the same as a 429", async () => {
    fetchMock.mockResolvedValue(res(500));
    const r = await run(REFRESH_URL, { method: "POST" });
    expect(r.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("leaves 502/503/504 alone — auth-js already retries those", async () => {
    fetchMock.mockResolvedValue(res(502));
    const r = await run(REFRESH_URL, { method: "POST" });
    expect(r.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordRefreshFailure).not.toHaveBeenCalled();
  });

  it("bails to the synthetic 503 immediately when Retry-After exceeds the wait cap", async () => {
    fetchMock.mockResolvedValue(res(429, "{}", { "Retry-After": "60" }));
    const r = await run(REFRESH_URL, { method: "POST" });
    expect(r.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no point hanging app boot for 60s
    expect(recordRefreshFailure).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, final: true }),
    );
  });

  it("caps the TOTAL retry window under the 10s rotation reuse interval", async () => {
    // Two 8s Retry-After sleeps would put attempt 3 at ~16s after attempt 1 —
    // outside the reuse window, where GoTrue reads the re-sent token as replay
    // and revokes the session family. The budget must stop after attempt 2.
    fetchMock.mockResolvedValue(res(429, "{}", { "Retry-After": "8" }));
    const r = await run(REFRESH_URL, { method: "POST" });
    expect(r.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordRefreshFailure).toHaveBeenLastCalledWith(
      expect.objectContaining({ attempt: 2, final: true }),
    );
  });

  it("honors the RFC 9110 HTTP-date form of Retry-After", async () => {
    // A date ~3s ahead: within the wait cap, so the wrapper should wait and
    // retry rather than misparse it as NaN and retry at 0.5s.
    const headers = { "Retry-After": new Date(Date.now() + 3_000).toUTCString() };
    fetchMock.mockResolvedValueOnce(res(429, "{}", headers)).mockResolvedValueOnce(res(200, "{}"));
    const promise = fetchWithRefreshRetry(REFRESH_URL, { method: "POST" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still waiting at 2s — not the 500ms fallback
    await vi.advanceTimersByTimeAsync(58_000);
    const r = await promise;
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bails immediately on an HTTP-date Retry-After beyond the wait cap", async () => {
    const headers = { "Retry-After": new Date(Date.now() + 60_000).toUTCString() };
    fetchMock.mockResolvedValue(res(429, "{}", headers));
    const r = await run(REFRESH_URL, { method: "POST" });
    expect(r.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
