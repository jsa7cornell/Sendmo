// Hard local-only guard for the DB-integration layer.
//
// Review N-b + the 2026-05-04 prod-DB-wipe post-mortem: the rail that failed on
// 2026-05-04 was advisory (a doc note + a describe.skip). This is the opposite —
// a hard throw at resolution time, BEFORE any client is constructed or any query
// runs. There is no way to point this suite at a non-local database.
//
// Contract:
//   - resolveLocalTarget() returns null when NO db target is configured at all
//     (CI without a local stack) → the suite skips. "No target" is safe.
//   - When a target IS configured, its host MUST be loopback or it THROWS. A
//     misconfigured prod URL aborts the run instead of seeding/truncating it.

export interface LocalTarget {
  url: string;
  serviceRoleKey: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "::1"]);

// The well-known Supabase local-stack service_role key (printed by
// `supabase start`; identical across local installs — it is NOT a secret and is
// safe to inline as a default). Override with SUPABASE_SERVICE_ROLE_KEY if your
// local stack was started with a custom JWT secret.
const DEFAULT_LOCAL_SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UtZGVtbyIsImlhdCI6MTY0MTc2OTIwMCwiZXhwIjoxNzk5NTM1NjAwfQ.DaYlNEoUrrEn2Ig7tqibS-PHK5vgusbcbo7X36XVt4Q";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    throw new Error(`[localGuard] target URL is unparseable: ${url}`);
  }
}

/**
 * Resolve the local target, or null if none is configured.
 * THROWS if a configured target is not loopback.
 */
export function resolveLocalTarget(): LocalTarget | null {
  // The target must be EXPLICIT — we never silently adopt an ambient SUPABASE_URL
  // (which may be prod from .env). Two ways to opt in:
  //   SUPABASE_DB_INTEGRATION_URL=<url>   — an explicit target, or
  //   SUPABASE_LOCAL=1                    — use SUPABASE_URL (from `supabase start`
  //                                         env) or default to the local API port.
  // Either way the host is then hard-checked for loopback below.
  const url =
    process.env.SUPABASE_DB_INTEGRATION_URL ||
    (process.env.SUPABASE_LOCAL === "1"
      ? (process.env.SUPABASE_URL || "http://127.0.0.1:54321")
      : "");

  if (!url) return null; // no explicit target → skip (safe)

  const host = hostOf(url);
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `[localGuard] REFUSING to run DB-integration tests against a non-local host '${host}' ` +
        `(url=${url}). These tests SEED and DELETE rows. Point SUPABASE_URL / ` +
        `SUPABASE_DB_INTEGRATION_URL at a local supabase stack (127.0.0.1) only. ` +
        `See the 2026-05-04 prod-DB-wipe post-mortem.`,
    );
  }

  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || DEFAULT_LOCAL_SERVICE_ROLE_KEY;

  return { url, serviceRoleKey };
}
