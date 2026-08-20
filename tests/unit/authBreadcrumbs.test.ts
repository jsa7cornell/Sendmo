// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";

// JSDOM's localStorage in this project's vitest config is incomplete (no
// setItem/clear). Same in-memory polyfill as senderState.test.ts.
beforeAll(() => {
  const store = new Map<string, string>();
  const mock = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: mock, writable: true, configurable: true });
  Object.defineProperty(window, "localStorage", { value: mock, writable: true, configurable: true });
});

import { recordAuthEvent, recordRefreshFailure } from "@/lib/authBreadcrumbs";

const BREADCRUMB_KEY = "sendmo-auth-breadcrumbs";
const HEARTBEAT_KEY = "sendmo-auth-heartbeat";

let fetchMock: ReturnType<typeof vi.fn>;

function crumbs(): Array<{ event: string; status?: number }> {
  return JSON.parse(localStorage.getItem(BREADCRUMB_KEY) ?? "[]");
}

function ingestCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("/functions/v1/ingest"));
}

beforeEach(() => {
  localStorage.clear();
  // Server sends are gated to the prod origin; tests opt in via the force key
  // (jsdom's origin is localhost).
  localStorage.setItem("sendmo-diag-send", "1");
  // jsdom cookies persist across tests within a file; expire the marker.
  document.cookie = "sm_bc=; max-age=0; path=/";
  vi.stubEnv("VITE_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "test-anon-key");
  fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("recordAuthEvent", () => {
  it("appends to the localStorage ring buffer and sets the marker cookie", () => {
    recordAuthEvent("SIGNED_IN", "user-1");
    expect(crumbs()).toHaveLength(1);
    expect(crumbs()[0].event).toBe("SIGNED_IN");
    expect(document.cookie).toContain("sm_bc=");
  });

  it("caps the ring buffer at 50 entries, keeping the newest", () => {
    for (let i = 0; i < 60; i++) recordAuthEvent("TOKEN_REFRESHED");
    recordAuthEvent("SIGNED_OUT");
    const all = crumbs();
    expect(all).toHaveLength(50);
    expect(all[all.length - 1].event).toBe("SIGNED_OUT");
  });

  it("sends SIGNED_OUT to ingest — the event the whole diagnosis waits for", () => {
    recordAuthEvent("SIGNED_OUT", "user-1");
    expect(ingestCalls()).toHaveLength(1);
    const body = JSON.parse(ingestCalls()[0][1].body as string);
    expect(body.event_type).toBe("auth.breadcrumb");
    expect(body.source).toBe("frontend");
    expect(body.actor_id).toBe("user-1");
    expect(body.properties.event).toBe("SIGNED_OUT");
  });

  it("heartbeats INITIAL_SESSION at most once per day", () => {
    recordAuthEvent("INITIAL_SESSION");
    recordAuthEvent("INITIAL_SESSION");
    recordAuthEvent("INITIAL_SESSION");
    expect(ingestCalls()).toHaveLength(1);
    expect(localStorage.getItem(HEARTBEAT_KEY)).toBe(new Date().toISOString().slice(0, 10));
    // All three still land in the local ring buffer.
    expect(crumbs().filter((c) => c.event === "INITIAL_SESSION")).toHaveLength(3);
  });

  it("does not burn the day's heartbeat slot when the send fails", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    recordAuthEvent("INITIAL_SESSION");
    await vi.waitFor(() => expect(localStorage.getItem(HEARTBEAT_KEY)).toBeNull());
    // Next (now-online) load retries the heartbeat instead of being throttled.
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    recordAuthEvent("INITIAL_SESSION");
    expect(ingestCalls()).toHaveLength(2);
    await vi.waitFor(() =>
      expect(localStorage.getItem(HEARTBEAT_KEY)).toBe(new Date().toISOString().slice(0, 10)),
    );
  });

  it("sends SIGNED_IN only on a genuine re-auth transition, not on tab focus", () => {
    // auth-js fires SIGNED_IN on every hidden→visible transition; those follow
    // existing crumbs and must stay local.
    recordAuthEvent("TOKEN_REFRESHED");
    recordAuthEvent("SIGNED_IN", "user-1");
    expect(ingestCalls()).toHaveLength(0);
    // But a SIGNED_IN right after SIGNED_OUT is a real re-login — send it.
    recordAuthEvent("SIGNED_OUT", "user-1");
    recordAuthEvent("SIGNED_IN", "user-1");
    expect(ingestCalls()).toHaveLength(2); // the SIGNED_OUT + the transition SIGNED_IN
  });

  it("sends SIGNED_IN when the ring buffer is empty — a sign-in after a storage wipe", () => {
    recordAuthEvent("SIGNED_IN", "user-1");
    expect(ingestCalls()).toHaveLength(1);
  });

  it("skips server sends entirely off the prod origin without the force key", () => {
    localStorage.removeItem("sendmo-diag-send");
    recordAuthEvent("SIGNED_OUT", "user-1");
    expect(ingestCalls()).toHaveLength(0);
    expect(crumbs()).toHaveLength(1); // local channel still records
  });

  it("keeps TOKEN_REFRESHED local-only — no hourly server spam", () => {
    recordAuthEvent("TOKEN_REFRESHED");
    expect(ingestCalls()).toHaveLength(0);
    expect(crumbs()).toHaveLength(1);
  });

  it("never throws when the server env is missing", () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    expect(() => recordAuthEvent("SIGNED_OUT")).not.toThrow();
    expect(crumbs()).toHaveLength(1); // local channel still records
  });
});

describe("recordRefreshFailure", () => {
  it("records status + attempt locally and reports error severity on the final attempt", () => {
    recordRefreshFailure({
      endpoint: "https://test.supabase.co/auth/v1/token?grant_type=refresh_token",
      status: 429,
      attempt: 3,
      final: true,
      bodySnippet: '{"error":"rate limit"}',
    });
    const all = crumbs();
    expect(all[0].event).toBe("REFRESH_FAILED");
    expect(all[0].status).toBe(429);
    const body = JSON.parse(ingestCalls()[0][1].body as string);
    expect(body.event_type).toBe("auth.refresh_failed");
    expect(body.severity).toBe("error");
    expect(body.properties.status).toBe(429);
  });

  it("reports warn severity on non-final attempts", () => {
    recordRefreshFailure({
      endpoint: "x",
      status: 500,
      attempt: 1,
      final: false,
      bodySnippet: "",
    });
    const body = JSON.parse(ingestCalls()[0][1].body as string);
    expect(body.severity).toBe("warn");
  });
});
