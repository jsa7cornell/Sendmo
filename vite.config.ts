import path from "path"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Build-time release/environment for Sentry tagging (T1-3 monitoring).
  // On Vercel these come from the "Automatically expose System Environment
  // Variables" project setting — after flipping the DSN, verify a Sentry
  // event shows the real SHA + environment, not "dev"/"development"
  // (proposal §6 step 3 / review N2). Always JSON.stringify: an undefined
  // define value would inject a bare token and break the build.
  define: {
    __APP_RELEASE__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA ?? ""),
    __APP_ENV__: JSON.stringify(process.env.VERCEL_ENV ?? ""),
  },
  // Pre-transform the whole app graph on dev-server boot. Without this the
  // first page a Playwright worker requests pays every module transform
  // on-demand — under full-suite parallelism that cold start took 35s+ and
  // blew a test timeout (2026-08-18).
  server: {
    warmup: {
      clientFiles: ["./src/main.tsx"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
