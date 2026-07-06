// Shared cron-auth helper for the scheduled sweeps (reconciliation-sweep,
// cron-refund-sweep). Both functions are called TWO ways:
//   1. pg_cron — POSTs `Authorization: Bearer <app.service_role_key GUC>`.
//   2. Manual admin — POSTs the admin's own user JWT (goes through requireAdmin).
//
// This helper isolates the "is this the cron/service-role path?" decision so
// both functions read the service-role key the SAME way (previously an
// asymmetry: reconciliation-sweep read only SUPABASE_SERVICE_ROLE_KEY while
// cron-refund-sweep / auth.ts also honored SB_SERVICE_ROLE_KEY — a mismatch
// that could make one sweep's cron path 403 while the other's succeeds).
// See proposals/2026-07-06_register-cron-sweeps_reviewed-2026-07-06.md N1/OQ3.
//
// SECURITY: the comparison is a constant string-equality against the
// service-role key from the function's own env. pg_cron must send the SAME
// string (the `app.service_role_key` GUC must equal the deployed
// SUPABASE_SERVICE_ROLE_KEY secret) — otherwise isCronCall is false and the
// request falls through to requireAdmin (which 403s a service-role principal).

/** The canonical service-role key read — both env names, in priority order. */
export function getServiceRoleKey(): string {
  return (
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    Deno.env.get("SB_SERVICE_ROLE_KEY") ||
    ""
  );
}

/**
 * True when the request's Bearer token exactly equals the service-role key —
 * i.e. this is the pg_cron scheduled invocation, not a user/admin call.
 * Returns false when no key is configured (never treat "" as a valid match).
 */
export function isCronCall(req: Request): boolean {
  const key = getServiceRoleKey();
  if (key === "") return false;
  const authHeader =
    req.headers.get("Authorization") || req.headers.get("authorization");
  return authHeader === `Bearer ${key}`;
}
