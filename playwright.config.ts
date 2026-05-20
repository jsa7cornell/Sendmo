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
    workers: process.env.CI ? 1 : undefined,
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
        command: 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
    },
});
