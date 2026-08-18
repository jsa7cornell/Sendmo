// Shared admin-auth harness for fully-mocked admin e2e specs.
//
// Why this exists: `AuthContext` gets its session from supabase-js, which reads
// it out of **localStorage** on cold load — it never issues an `/auth/v1/`
// request for a spec to intercept. Specs that only mocked `**/auth/v1/**`
// therefore left `user` null, so `Admin.tsx` redirected to
// `/login?redirectTo=/admin` and every assertion timed out waiting for admin UI
// on the login page. Seeding the session is the only thing that gets past the
// gate without real credentials.
//
// Two pieces are required, and both are load-bearing:
//   1. a session in localStorage under supabase-js's `sb-<ref>-auth-token` key
//      (same shape global-setup.ts writes for the authed specs), and
//   2. a `/rest/v1/profiles*` mock returning role='admin', because
//      `AuthContext.ensureProfile` derives `isAdmin` from that row.
//
// The profiles mock is lifted from account-budget-admin.spec.ts, which already
// had it right — including the PostgREST Accept-header nuance.

import type { Page } from "@playwright/test";
import { SUPABASE_STORAGE_KEY as STORAGE_KEY } from "./supabase-env";

export const ADMIN_USER_ID = "00000000-0000-0000-0000-000000000000";
export const ADMIN_EMAIL = "e2e-admin@example.com";

// PostgREST returns a single object when the client uses .single()/.maybeSingle()
// (Accept: application/vnd.pgrst.object+json) and an array otherwise. Mock both.
export function profilesMockBody(req: { headers(): Record<string, string> }): string {
  const accept = req.headers().accept ?? "";
  const obj = {
    id: ADMIN_USER_ID,
    email: ADMIN_EMAIL,
    full_name: "E2E Admin",
    role: "admin",
    admin_active_mode: "test",
    stripe_customer_id_test: null,
    stripe_customer_id_live: null,
    daily_budget_cents: 20000,
    weekly_budget_cents: 50000,
  };
  return accept.includes("vnd.pgrst.object") ? JSON.stringify(obj) : JSON.stringify([obj]);
}

// Seeds a synthetic session before any page script runs. expires_at is set far
// out so supabase-js treats it as valid and never tries to refresh it against a
// GoTrue that isn't there.
export async function seedAdminSession(page: Page): Promise<void> {
  const session = {
    access_token: "e2e-mock-access-token",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: 4_102_444_800, // 2100-01-01
    refresh_token: "e2e-mock-refresh-token",
    user: {
      id: ADMIN_USER_ID,
      aud: "authenticated",
      role: "authenticated",
      email: ADMIN_EMAIL,
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: { full_name: "E2E Admin" },
      created_at: "2026-01-01T00:00:00.000Z",
    },
  };

  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    [STORAGE_KEY, JSON.stringify(session)] as const,
  );
}

/**
 * Makes `/admin` render as a signed-in admin under full mocks: seeds the
 * session and serves an admin profile row. Call before `page.goto`.
 */
export async function mockAdminAuth(page: Page): Promise<void> {
  await seedAdminSession(page);
  await page.route("**/rest/v1/profiles*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: profilesMockBody(route.request()),
    }),
  );
}
