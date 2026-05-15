import path from "path";
import { defineConfig } from "vitest/config";

// Vitest config for integration tests that call real Supabase Edge Functions.
// These are intentionally excluded from the default vitest.config.ts to avoid
// hitting production APIs on every unit test run.
//
// Run: npm run test:integration:api
// Requires: VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY in .env.local
// Optional: SENDMO_TEST_EMAIL + SENDMO_TEST_PASSWORD for auth-gated tests

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    globals: true,
    // Load .env.local so VITE_SUPABASE_URL etc. are available
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k.startsWith("VITE_") || k.startsWith("SENDMO_"))
    ),
    // Integration tests hit real network — generous timeout
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
