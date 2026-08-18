// Single source of truth for the Supabase host the e2e specs mock against.
//
// Specs used to hardcode `https://fkxykvzsqdjzhurntgah.supabase.co` as their
// page.route target and `sb-fkxykvzsqdjzhurntgah-auth-token` as the storage
// key. That silently breaks in CI, where test.yml builds the app with
// VITE_SUPABASE_URL=http://localhost:54321: the app requests localhost while
// the mocks listen on the production host, so the routes never match and the
// requests hit a host with nothing on it. Measured cost: 30 of 80 tests failed
// under CI's env and 0 failed locally, purely from this mismatch.
//
// Deriving both values from the same env var Vite inlines keeps the mock target
// and the app's actual target in agreement wherever the suite runs.

import { existsSync, readFileSync } from "node:fs";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

export const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ?? "https://fkxykvzsqdjzhurntgah.supabase.co";

export const PROJECT_REF = new URL(SUPABASE_URL).hostname.split(".")[0];

/** supabase-js persists the session here; seed it to start a spec signed in. */
export const SUPABASE_STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;

export const AUTH_FILE = "playwright/.auth/user.json";

/**
 * True when global-setup's storage state exists AND was minted for the project
 * the app is currently built against.
 *
 * Existence alone is not enough: the file is gitignored but persists between
 * runs, so a state minted against the production project stays on disk when the
 * suite is later pointed somewhere else (CI uses http://localhost:54321). The
 * app then looks for `sb-localhost-auth-token`, the stale file supplies
 * `sb-<prod-ref>-auth-token`, and the specs run un-authenticated — failing with
 * opaque "element not found" errors instead of skipping cleanly.
 */
export function hasAuthStateForCurrentProject(): boolean {
  if (!existsSync(AUTH_FILE)) return false;
  try {
    const state = JSON.parse(readFileSync(AUTH_FILE, "utf-8")) as {
      origins?: { localStorage?: { name?: string }[] }[];
    };
    return (state.origins ?? []).some((o) =>
      (o.localStorage ?? []).some((e) => e.name === SUPABASE_STORAGE_KEY),
    );
  } catch {
    return false;
  }
}
