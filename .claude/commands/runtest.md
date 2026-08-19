---
description: Run the SendMo Playwright e2e suite — quick pass/fail check.
---

Run `npm run test:e2e:browser` from the root of **the checkout you are working in** — a worktree tests itself, not the primary checkout.

Do NOT pre-boot a dev server. `playwright.config.ts` has a `webServer` block that starts `npm run dev` on :5173 and manages its lifecycle. Booting one yourself leaves an orphan that `reuseExistingServer` then adopts — and if that orphan belongs to a different checkout, every result is meaningless, passes included (2026-08-18 A4c: 17 of 28 specs "failed" against correct code this way). Verify with `for pid in $(lsof -ti:5173); do lsof -a -p $pid -d cwd -Fn | grep '^n'; done`.

Report:
- Total tests run, passed, skipped, failed
- Names of any failing specs
- Wall-clock time
- If anything failed, paste the first failure's assertion error / stack trace
- **The baseline is 0 failures.** Since the 2026-08-18 de-rot the mocked suite runs 77–82 passed / 0 failed, and it is **merge-blocking** (`test.yml` runs it bare — a red result stops the merge). Treat any failure as a real regression until proven otherwise. The older "~14 fail on a missing `VITE_GOOGLE_MAPS_API_KEY`" note is obsolete; do not use it to wave a failure through.
- The **authed** step is separately non-blocking (`continue-on-error`, live Supabase), so a green run does not certify it — check the run's annotations
