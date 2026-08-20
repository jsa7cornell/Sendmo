import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './tests/e2e',
    // Real-service specs hit live EasyPost / Stripe / Edge Functions instead
    // of the page.route mocks — excluded from the default run so
    // `npm run test:e2e`, `/runtest`, and CI stay fully mocked. Run them
    // deliberately, e.g. `npx playwright test tests/e2e/buy_label_debug.spec.ts`.
    testIgnore: [
        '**/buy_label_debug.spec.ts',
        '**/playwright_verify.spec.ts',
        '**/cors_verify.spec.ts',
    ],
    // Mints an authenticated storage state for authed specs (no-op without
    // E2E_TEST_USER_* — see tests/e2e/global-setup.ts).
    globalSetup: './tests/e2e/global-setup.ts',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    // Explicit 4 on CI's 4-vCPU runner. This beats Playwright's cpus/2
    // default (= 2 there), measured on CI on the e2e step alone: 140s serial
    // -> 69s at 2 workers -> 52s at 4, holding at 52/53/53s across three
    // consecutive green runs. Anything above 4 is untested; re-measure before
    // changing it rather than reasoning from this comment.
    //
    // `workers: 1` here until 2026-08-20 was scaffolding from the original
    // "setup test framework and CI pipeline" commit, never an anti-flake
    // decision — it made CI the only place the suite ran serially. The two
    // parallelism-only flakes found on 2026-08-18 are fixed at the source, not
    // papered over: the auto-advance timer reset (a real app bug — an inline
    // callback in a useEffect dep list) and the cold Vite transform
    // (vite.config.ts server.warmup). Oversubscription was the risk while the
    // dev server did on-demand transform work; the preview server below is a
    // static file server using almost no CPU, so the browsers get the machine.
    workers: process.env.CI ? 4 : undefined,
    reporter: 'html',
    timeout: 30_000,
    use: {
        baseURL: 'http://localhost:5173',
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
    webServer: {
        // CI serves the production build; local keeps the dev server for HMR.
        //
        // Two reasons, in this order. It is what actually ships, so a
        // build-only breakage fails here instead of on Vercel. And it drops
        // Vite's on-demand transform from every navigation: measured 137s ->
        // 114s at one worker, a win that stacks with parallelism (60s -> 45s
        // at four). The build costs ~5s locally, ~10s on CI — and is paid
        // TWICE per job, once per Playwright invocation, because test.yml runs
        // a mocked step and an authed step. That is not waste to remove: VITE_
        // vars are inlined at build time and the two steps need different
        // Supabase values, so each genuinely needs its own bundle.
        //
        // `vite build`, not `npm run build`: that script is `tsc -b && vite
        // build`, and CI already runs `npx tsc -b` as its own step. Calling it
        // here would typecheck the project twice and hand back a chunk of what
        // this change just saved.
        command: process.env.CI
            ? 'npx vite build && npx vite preview --port 5173 --strictPort'
            : 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
        // --strictPort above is load-bearing. Without it `vite preview --port
        // 5173` does not fail when the port is taken — verified 2026-08-20 that
        // it binds the OTHER IP stack ([::1] beside an existing *:5173) and
        // still reports success. With two invocations per job building
        // DIFFERENT bundles (mock vs real Supabase), a lingering server from
        // the first step could then answer the second step's requests with the
        // wrong bundle. strictPort turns that into an immediate, legible error;
        // Playwright surfaces webServer startup failures verbatim rather than
        // as an opaque timeout.
        // Default is 60s. The build runs inside this window on CI's slower
        // runner, so the ceiling covers build + server boot, not boot alone.
        timeout: 120_000,
    },
});
