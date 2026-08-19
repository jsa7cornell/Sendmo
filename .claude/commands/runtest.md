---
description: Run the SendMo Playwright e2e suite — quick pass/fail check.
---

Run `npm run test:e2e:browser` from `/Users/ja/AI Brain/sendmo/`.

Before running, confirm `npm run dev` is already running on port 5173 (Playwright config sets `reuseExistingServer: !process.env.CI` and assumes the Vite dev server is up). If it's not running, boot it in the background first.

Report:
- Total tests run, passed, skipped, failed
- Names of any failing specs
- Wall-clock time
- If anything failed, paste the first failure's assertion error / stack trace
- Known-flaky context: per WISHLIST "Test / CI debt," ~14 e2e tests fail because `VITE_GOOGLE_MAPS_API_KEY` isn't set; surface failures matching that pattern but don't treat them as new regressions
