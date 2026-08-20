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
    // No CI override. `workers: 1` here was scaffolding from the original
    // "setup test framework and CI pipeline" commit, never an anti-flake
    // decision — and it made CI the ONLY place the suite ran serially, so it
    // paid ~2x for a constraint nothing needed. Playwright's default is
    // cpus/2, which self-adjusts if runner sizes change; the PLAYBOOK's
    // standing warning about sizing anything from a quoted number applies
    // here too, so this deliberately hardcodes nothing.
    //
    // The two parallelism-only flakes found on 2026-08-18 are fixed at the
    // source, not papered over: the auto-advance timer reset (a real app bug
    // — inline callback in a useEffect dep list) and the cold Vite transform
    // (vite.config.ts server.warmup). Measured 2026-08-19, locally on 10
    // cores: 137s at 1 worker, 72s at 2, 60s at 4 — and both parallel runs
    // were clean while the serial run flaked.
    workers: undefined,
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
        // at four). The build costs ~5s.
        //
        // `vite build`, not `npm run build`: that script is `tsc -b && vite
        // build`, and CI already runs `npx tsc -b` as its own step. Calling it
        // here would typecheck the project twice and hand back a chunk of what
        // this change just saved.
        command: process.env.CI
            ? 'npx vite build && npx vite preview --port 5173'
            : 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
        // Default is 60s. The build runs inside this window on CI's slower
        // runner, so the ceiling covers build + server boot, not boot alone.
        timeout: 120_000,
    },
});
