import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import dotenv from "dotenv";

// ─── Playwright global setup: authenticated e2e session ─────────────────────
//
// Mints a real Supabase session for the dedicated e2e test user and writes it
// as a Playwright storageState file (playwright/.auth/user.json) so authed
// specs — e.g. the dashboard /links/new flow — start logged in.
//
// One-time setup (done by a human — agents never handle the password):
//   1. Supabase dashboard → Authentication → Users → "Add user". Give it an
//      email + password and tick "Auto Confirm User".
//   2. Put the credentials in .env.local (gitignored via *.local) AND in the
//      CI secret store:
//        E2E_TEST_USER_EMAIL=...
//        E2E_TEST_USER_PASSWORD=...
//
// When those vars are absent this is a no-op and the authed specs skip
// themselves — local runs and CI without the secret stay green.

dotenv.config({ path: ".env.local" });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "https://fkxykvzsqdjzhurntgah.supabase.co";
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY ?? "";
const AUTH_FILE = "playwright/.auth/user.json";

export default async function globalSetup(): Promise<void> {
  const email = process.env.E2E_TEST_USER_EMAIL;
  const password = process.env.E2E_TEST_USER_PASSWORD;

  if (!email || !password) {
    console.warn(
      "[e2e global-setup] E2E_TEST_USER_EMAIL / E2E_TEST_USER_PASSWORD not set — " +
        "authed specs (dashboard /links/new) will be skipped.",
    );
    return;
  }
  if (!ANON_KEY) {
    throw new Error("[e2e global-setup] VITE_SUPABASE_ANON_KEY missing — cannot authenticate.");
  }

  // Password grant against GoTrue. The dedicated test user has a password set
  // (the app's UI uses OTP, but the Email provider still accepts password
  // grant for a user that has one).
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(
      `[e2e global-setup] password login failed (HTTP ${res.status}). ` +
        `Confirm the test user exists and the password is correct. Response: ${await res.text()}`,
    );
  }
  const session = await res.json();

  // supabase-js v2 persists the session under sb-<ref>-auth-token as a JSON
  // string; seeding that localStorage entry makes the app start authenticated.
  const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];
  const storageState = {
    cookies: [],
    origins: [
      {
        origin: "http://localhost:5173",
        localStorage: [
          { name: `sb-${projectRef}-auth-token`, value: JSON.stringify(session) },
        ],
      },
    ],
  };

  mkdirSync(dirname(AUTH_FILE), { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(storageState, null, 2));
  console.log(`[e2e global-setup] authenticated storage state written for ${email}.`);
}
