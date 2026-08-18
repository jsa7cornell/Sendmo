// ─── Auth breadcrumbs — Phase 0 of the session-durability diagnosis ─────────
//
// SendMo signs John out "nearly every day" with zero server-side trace
// (proposals/2026-08-18_session-durability-and-auth-architecture_*.md). The
// candidate causes are indistinguishable without instrumentation, so every
// auth event is recorded on three channels that fail differently:
//
//   1. localStorage ring buffer — the client-side view. Destroyed by the
//      storage wipe it exists to detect, which is itself signal.
//   2. A JS cookie (`sm_bc`, first-write timestamp only) — survives a
//      localStorage-only clear (extension), dies with a whole-origin wipe.
//   3. event_logs via the `ingest` Edge Function — survives anything the
//      browser does. Signal events only, throttled, fire-and-forget.
//
// On the next logout, the combination discriminates:
//   ring buffer + cookie both gone            → whole-origin storage wipe
//   ring buffer gone, cookie present          → localStorage-only clear
//   ring buffer ends SIGNED_OUT after a
//   REFRESH_FAILED entry (status recorded)    → non-retryable refresh response
//   server has events from another origin     → www/apex origin split
//
// Never call the supabase client from this module — it runs inside the
// onAuthStateChange callback, where supabase calls deadlock the auth lock
// (see AuthContext.tsx). Plain localStorage + fetch only.

export interface AuthBreadcrumb {
  event: string;
  ts: string;
  origin: string;
  online: boolean;
  visibility: string;
  /** Present on REFRESH_FAILED entries only. */
  status?: number;
  attempt?: number;
  final?: boolean;
  bodySnippet?: string;
}

const BREADCRUMB_KEY = "sendmo-auth-breadcrumbs";
const HEARTBEAT_KEY = "sendmo-auth-heartbeat";
const DIAG_ID_KEY = "sendmo-diag-id";
const COOKIE_NAME = "sm_bc";
const MAX_CRUMBS = 50;
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60; // 400 days — the browser cap

// Server sends are prod-only: the diagnosis targets sendmo.co, and unsanctioned
// senders (dev servers, e2e contexts) would pollute the very event_logs data
// this module exists to collect. Tests opt in via the force key (the e2e spec
// sets it in addInitScript, then mocks ingest).
const PROD_ORIGIN = "https://sendmo.co";
const FORCE_SEND_KEY = "sendmo-diag-send";

/**
 * Auth events worth an unconditional server-side row. SIGNED_OUT is the one
 * the whole diagnosis waits for. SIGNED_IN is deliberately NOT here: auth-js
 * fires it on every hidden→visible tab transition (GoTrueClient
 * _onVisibilityChanged → _recoverAndRefresh), so an unconditional send would
 * post to ingest on every tab focus, in every open tab. SIGNED_IN is sent
 * only on a genuine re-auth transition — see recordAuthEvent.
 */
const SERVER_EVENTS = new Set(["SIGNED_OUT", "USER_UPDATED"]);

function safe<T>(fn: () => T): T | undefined {
  // Diagnostics must never break auth itself.
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function diagId(): string {
  return (
    safe(() => {
      let id = localStorage.getItem(DIAG_ID_KEY);
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem(DIAG_ID_KEY, id);
      }
      return id;
    }) ?? "no-storage"
  );
}

function readCrumbs(): AuthBreadcrumb[] {
  return (
    safe(() => {
      const raw = localStorage.getItem(BREADCRUMB_KEY);
      return raw ? (JSON.parse(raw) as AuthBreadcrumb[]) : [];
    }) ?? []
  );
}

function pushCrumb(crumb: AuthBreadcrumb): void {
  safe(() => {
    const crumbs = readCrumbs();
    crumbs.push(crumb);
    localStorage.setItem(BREADCRUMB_KEY, JSON.stringify(crumbs.slice(-MAX_CRUMBS)));
  });
  // First-write marker cookie. Its later absence vs. presence is the
  // origin-wipe discriminator; never overwrite an existing value.
  safe(() => {
    if (!document.cookie.split("; ").some((c) => c.startsWith(`${COOKIE_NAME}=`))) {
      document.cookie = `${COOKIE_NAME}=${Date.now()}; max-age=${COOKIE_MAX_AGE_S}; path=/; SameSite=Lax`;
    }
  });
}

function serverSendEnabled(): boolean {
  return (
    safe(() => window.location.origin) === PROD_ORIGIN ||
    safe(() => localStorage.getItem(FORCE_SEND_KEY)) === "1"
  );
}

/** Resolves true only when ingest accepted the event. Never throws. */
function sendToServer(
  event_type: string,
  severity: "info" | "warn" | "error",
  userId: string | null | undefined,
  properties: Record<string, unknown>,
): Promise<boolean> {
  try {
    if (!serverSendEnabled()) return Promise.resolve(false);
    const url = import.meta.env.VITE_SUPABASE_URL;
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !anonKey) return Promise.resolve(false);
    return fetch(`${url}/functions/v1/ingest`, {
      method: "POST",
      // keepalive lets the SIGNED_OUT event survive an immediate page unload.
      keepalive: true,
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event_type,
        severity,
        source: "frontend",
        session_id: diagId(),
        actor_id: userId ?? null,
        entity_type: "auth",
        properties,
      }),
    })
      .then((res) => res.ok)
      .catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

function baseCrumb(event: string): AuthBreadcrumb {
  return {
    event,
    ts: new Date().toISOString(),
    origin: safe(() => window.location.origin) ?? "unknown",
    online: safe(() => navigator.onLine) ?? true,
    visibility: safe(() => document.visibilityState) ?? "unknown",
  };
}

/** Record an onAuthStateChange event. Called from AuthContext. */
export function recordAuthEvent(event: string, userId?: string | null): void {
  const prevEvent = readCrumbs().at(-1)?.event;
  const crumb = baseCrumb(event);
  pushCrumb(crumb);

  if (SERVER_EVENTS.has(event)) {
    void sendToServer("auth.breadcrumb", "info", userId, { ...crumb });
    return;
  }
  // SIGNED_IN fires on every tab focus (see SERVER_EVENTS note). Send it only
  // on a genuine re-auth transition: the previous crumb was SIGNED_OUT, or the
  // ring buffer is empty (a sign-in right after a storage wipe — diagnostic
  // gold). Tab-focus SIGNED_INs always follow other crumbs and stay local.
  if (event === "SIGNED_IN") {
    if (prevEvent === "SIGNED_OUT" || prevEvent === undefined) {
      void sendToServer("auth.breadcrumb", "info", userId, { ...crumb });
    }
    return;
  }
  // INITIAL_SESSION fires on every page load — heartbeat it server-side at
  // most once per calendar day so event_logs shows liveness without spam.
  // The day marker is set optimistically (keeps the once-a-day guarantee
  // synchronous) but CLEARED if the send fails, so an offline first load
  // doesn't burn the day's slot and produce a false "browser never opened".
  if (event === "INITIAL_SESSION") {
    const today = crumb.ts.slice(0, 10);
    const already = safe(() => localStorage.getItem(HEARTBEAT_KEY)) === today;
    if (!already) {
      safe(() => localStorage.setItem(HEARTBEAT_KEY, today));
      void sendToServer("auth.breadcrumb", "info", userId, { ...crumb }).then((ok) => {
        if (!ok) safe(() => localStorage.removeItem(HEARTBEAT_KEY));
      });
    }
  }
}

/** Record a failed token-refresh attempt. Called from authFetch. */
export function recordRefreshFailure(failure: {
  endpoint: string;
  status: number;
  attempt: number;
  final: boolean;
  bodySnippet: string;
}): void {
  const crumb: AuthBreadcrumb = {
    ...baseCrumb("REFRESH_FAILED"),
    status: failure.status,
    attempt: failure.attempt,
    final: failure.final,
    bodySnippet: failure.bodySnippet,
  };
  pushCrumb(crumb);
  void sendToServer("auth.refresh_failed", failure.final ? "error" : "warn", null, {
    ...crumb,
    endpoint: failure.endpoint,
  });
}
