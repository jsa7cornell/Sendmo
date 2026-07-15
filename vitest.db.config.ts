import path from "path";
import { defineConfig } from "vitest/config";

// Vitest config for DB-INTEGRATION tests — the layer the H2 repair added
// (decided proposal 2026-07-15_h2-carrier-adjustment-repair §5).
//
// Unlike tests/integration/** (which fetch DEPLOYED Edge Functions and never
// seed a DB), these run the importable recovery logic + the resolve_recovery_lock
// RPC against a REAL LOCAL Postgres — the only layer that catches the
// column/index/RPC-body bug class that killed H2 four times.
//
// Requires a local Supabase stack:
//   supabase start            # boots local Postgres (Docker) + applies migrations
//   npm run test:db
//
// SAFETY (Review N-b, 2026-05-04 prod-wipe post-mortem): tests/db-integration/
// helpers HARD-THROW if the target URL is not local — there is no describe.skip
// prod escape hatch. If no local target is configured at all, the suite skips
// (nothing to connect to); if a target IS configured it must be local or the
// run aborts before any query.
export default defineConfig({
  test: {
    include: ["tests/db-integration/**/*.test.ts"],
    environment: "node",
    globals: true,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => k.startsWith("VITE_") || k.startsWith("SENDMO_") || k.startsWith("SUPABASE_"),
      ),
    ),
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
