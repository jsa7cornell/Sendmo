---
title: Handoff — platform-wide infra audit (CI signal + Vercel deploy stability)
slug: platform-infra-audit-handoff
project: sendmo
status: draft
blocked_on: null
created: 2026-08-17
last_updated: 2026-08-17
reviewed: null
decided: null
author: Claude Fable 5 — surfaced while implementing the who-is-sending onboarding change (PR #63). Every finding below was verified against the live workflow files, the actual CI run for PR #63, and its uploaded artifact — not inferred.
reviewer: null
outcome: null
---

> **This is a handoff, not a proposal.** It hands a fresh session enough verified detail to run an infra audit without rediscovering any of it. Nothing here is decided; the recommendations are starting points.
>
> **One-line summary:** **16 e2e specs are red on `main` right now**, CI is structurally incapable of reporting it, and the Vercel deploy path has an account-wide throttle that isn't modelled anywhere. None of this is a code bug in a feature; all of it is rot in the surfaces John relies on to know whether things work.

## Why this exists

While implementing PR #63 I hit three things that were not that change's fault and are not that change's to fix:

1. Several e2e specs asserted a heading (`"How should we set up your prepaid shipment"`) that the seller-link work renamed **weeks earlier**. They had been red the whole time and nothing surfaced it.
2. The CI run for PR #63 reported **success on every step** — including steps whose underlying commands are incapable of failing the build.
3. PR #62 was blocked, per LOG 2026-08-16, on a Vercel deploy limit that is **account-wide across all of John's projects**, not per-project.

(1) is a direct consequence of (2). That's the thread worth pulling.

---

## Part A — CI reports success it has not earned

### A0. 16 e2e specs are failing on `main` today

This is the concrete instance of everything in A1/A2, and it is the reason to act.

Measured at `main` HEAD `f11c009` (the review-docs commit — **no application code changed**), running the three specs directly:

| Spec | Failing |
|---|---|
| [`admin-reconciliation.spec.ts`](../tests/e2e/admin-reconciliation.spec.ts) | 8 |
| [`admin-refund-flow.spec.ts`](../tests/e2e/admin-refund-flow.spec.ts) | 7 |
| [`label-flow.spec.ts`](../tests/e2e/label-flow.spec.ts) | 1 |
| **Total** | **16** |

Full-suite shape: **78 tests = 57 passed / 5 skipped / 16 failed.** The failure mode is uniform — `expect(locator).toBeVisible()` timing out — which usually means the page under test never rendered its expected shell, not sixteen independent assertion bugs. That pattern suggests **one or two root causes**, not sixteen; likely candidates are a changed admin route/guard, a changed mocked-response shape, or a renamed heading (the same rot class that hit the onboarding specs). Diagnose before triaging individually.

**Reproduce:**

```bash
npx playwright test tests/e2e/admin-reconciliation.spec.ts \
  tests/e2e/admin-refund-flow.spec.ts \
  tests/e2e/label-flow.spec.ts --reporter=line 2>&1 \
  | grep -E '[0-9]+ (failed|passed|skipped)'
```

Two of the three cover **money surfaces** (reconciliation, refunds). They are the specs most worth trusting before launch, and they are currently the ones nobody is being told about.

> **Reporting trap — this cost me a wrong claim, and it will get the next agent too.** Playwright's line reporter prints the failed-test *list* first and the `N failed` *count* immediately above the `skipped`/`passed` lines. A short `tail` therefore shows the failure list plus two green summary lines while cutting off the count, which reads exactly like a clean run — I reported "57 passed / 0 failed" from `| tail -6` before catching it. **Never infer "0 failed" from the absence of a failed line in truncated output.** Always `grep -E '[0-9]+ (failed|passed|skipped)'`.

### A1. Three of five test gates cannot fail the build

[`.github/workflows/test.yml`](../.github/workflows/test.yml), verified at current HEAD:

| Step | Command | Can it fail CI? |
|---|---|---|
| Run ESLint | `npm run lint \|\| true` + `continue-on-error: true` | **No** |
| Run Type Check | `npx tsc -b` | **Yes** ✅ |
| Run Unit & Component Tests | `npm run test:unit` | **Yes** ✅ |
| Run Playwright E2E Tests | `npm run test:e2e \|\| true` + `continue-on-error: true` | **No** |
| Run Authed E2E | `npx playwright test … \|\| true` + `continue-on-error: true` | **No** |

Both suppressed steps are **double**-suppressed. That detail matters more than it looks:

- `continue-on-error: true` alone would let the step fail and render as a **yellow/neutral** result — a visible warning.
- `|| true` makes the shell exit **0**, so GitHub records the step as a clean green `success`. `continue-on-error` never even engages.

Net effect: a fully red e2e suite is **visually indistinguishable** from a fully green one, anywhere in the GitHub UI. Confirmed on PR #63's run (`32052410472`) — every step, including both e2e steps, reports `success`:

```bash
gh run view 32052410472 --json jobs --jq '.jobs[].steps[] | "\(.conclusion)\t\(.name)"'
```

The suppression was deliberate and is labelled in the step names ("non-blocking — … tracked separately"), so this is drift from a reasonable temporary decision, not carelessness. The question for the audit is whether "temporarily non-blocking" is still the right trade now that it has silently absorbed at least one real rot event.

### A2. The e2e report artifact is overwritten before upload — the results are unrecoverable

This is the one I'd fix first, because it's cheap and it removes the excuse for A1.

Both Playwright steps write to the default `playwright-report/`. The **Authed E2E** step runs *after* the full suite and re-runs Playwright, overwriting the directory. The `Upload Playwright Report` step then uploads whatever survived.

Verified by downloading and decoding the artifact from PR #63's run:

```bash
gh run download 32052410472 -R jsa7cornell/Sendmo -n playwright-report
# index.html only; data is inlined in <script id="playwrightReportBase64">
```

Aggregate stats in the uploaded report: **1 test** (`expected: 1, unexpected: 0, flaky: 0, skipped: 0`).

The full suite is **78 tests** (57 passed / 5 skipped / 16 failed locally at the same commit — see A0). So the artifact preserves the single authed spec and destroys the entire main suite's results, **including all 16 failures**.

**Combined with A1 this is the real problem:** e2e failures cannot fail the build, cannot be seen in the UI, and cannot be recovered from the artifact. There is currently **no path** by which anyone learns the e2e suite is broken. That is exactly how the stale heading assertions survived.

Suggested fix (small): give each invocation its own output dir and upload both —
`PLAYWRIGHT_HTML_REPORT=playwright-report-main` / `-authed`, two `upload-artifact` steps (or one with a glob). Independent of whether the gates stay non-blocking.

### A3. CI wall-clock has drifted ~3× from what the docs claim

PLAYBOOK Rule 21 says "CI takes ~12 min." PR #63's run took **35m0s**.

Contributing factors in [`playwright.config.ts`](../playwright.config.ts): `workers: 1` on CI (vs. 5 locally) and `retries: 2`. Serial execution plus two retries of anything failing is a plausible 3× on its own — which also means **the retry budget is being spent on specs that are expected to fail**, since nothing gates on them.

Worth measuring rather than assuming: if a chunk of those 35 minutes is retrying known-red specs, fixing A1/A2 speeds up CI as a side effect. Either way PLAYBOOK Rule 21's "~12 min" should be corrected to observed reality so nobody treats a normal run as hung.

### A4. Five e2e specs silently self-skip on missing env

All are conditional skips gated on env vars, so they no-op quietly rather than failing:

| Spec | Gate |
|---|---|
| [`sender-flow.spec.ts:64`](../tests/e2e/sender-flow.spec.ts) | `TEST_CODE` |
| [`tracking-anonymous-payment-gating.spec.ts:70-71`](../tests/e2e/tracking-anonymous-payment-gating.spec.ts) | `TEST_PUBLIC_CODE`, `TEST_PAYER_JWT` |
| [`account-budget-admin.spec.ts:75`](../tests/e2e/account-budget-admin.spec.ts) | auth state present |
| [`phone-gate.spec.ts:221`](../tests/e2e/phone-gate.spec.ts) | `E2E_TEST_USER_EMAIL` / `_PASSWORD` |

Self-skipping is the right pattern (PLAYBOOK: "a red e2e spec is worse than none"), but it means **sender-flow and anonymous-payment-gating coverage is probably not running anywhere**. The audit should determine which of these gates are satisfied in CI today and whether the unsatisfied ones represent coverage John believes he has. `account-budget-admin` and the payment-gating specs cover money paths, so this is not cosmetic.

### A4b. The local suite depends on a gitignored file, and fails opaquely without it

`playwright.config.ts` starts the dev server itself, and that server needs `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` from `.env.local` (gitignored) to boot. Without them the app serves a blank page and **every spec fails with `expect(locator).toBeVisible()`** — the same opaque error as a genuine regression, with nothing pointing at the real cause.

I hit this by deleting `.env.local` during cleanup: 11/11 specs "failed", then passed immediately once it was restored. A fresh clone has the same experience on day one.

Cheap fix: a `globalSetup` assertion that the required vars are present and fails with a one-line message naming the file, instead of letting 60+ specs fail meaninglessly. PLAYBOOK's e2e section documents the requirement in prose; making it enforce itself is strictly better.

### A5. Not a finding, but confirm it stays true

[`test.yml`](../.github/workflows/test.yml) hardcodes `VITE_SUPABASE_ANON_KEY` in plaintext. This is **fine and deliberate** — it's the publishable anon key that ships in every browser bundle, and there's an inline comment saying so. Flagging it only so the audit doesn't "discover" it and file a false Rule 0 alarm. Worth one check that it's still the anon key and not a service-role key.

---

## Part B — Vercel

### B1. The deploy limit is account-wide, and nothing models that

Per LOG 2026-08-16 and confirmed by PR #62 being held: SendMo is on **Vercel Hobby**, whose daily deploy cap is shared **across every project in John's account**, and preview builds count against it. One busy project can therefore block an unrelated project's production deploy for up to 24h.

This has already bitten once — #62 was deliberately not merged because merging would have put it on `main` while prod stayed on the old bundle, making `main` read as live when it wasn't. That was the right call, and it's a workaround, not a fix.

For the audit:
- Confirm the current plan and the actual cap (Hobby's published limit has moved before).
- Decide whether SendMo's launch posture tolerates a shared cap. If John is about to take real payments, an account-wide throttle sitting between him and a hotfix is a launch risk, not a billing preference.
- If Pro is the answer for SendMo specifically, that is a small, boring, high-leverage purchase — but it is **John's call**, not an agent's.
- Cheap mitigation regardless: preview deploys can be disabled per-project or per-branch, which stops feature branches consuming prod's quota.

### B2. There is no source of truth for required env vars

[`vercel.json`](../vercel.json) covers build, output, cache headers, and the SPA rewrite. It does **not** and cannot carry env vars — those are dashboard-only, and PLAYBOOK says so.

The practical consequence: the list of vars prod needs exists only in PLAYBOOK prose and `.env.example`. There's no check that the dashboard matches. The T2-4-class failure (a key present but wrong-mode) is exactly the shape this invites, and the 2026-07-19 seller-link `buyerLiveMode` launch-blocker was a near-miss of the same family.

Suggested: a tiny startup or CI assertion that every var the app reads is present and well-formed for the target mode — cheaper than it sounds, and it converts a silent misconfiguration into a loud one.

### B3. Confirm the SPA rewrite still shadows `api/s/[shortCode].ts`

`vercel.json`'s rewrite is `{"source": "/(.*)", "destination": "/index.html"}` — catch-all. LOG 2026-05-22 records that this bypasses the serverless `api/s/[shortCode].ts`, so `/s/` link previews are served by Edge Middleware ([`middleware.ts`](../middleware.ts), matcher `/s/:shortCode*`) instead, and `ogMeta.ts` is shared so the two can't drift.

That's understood and documented. The audit item is narrower: **`api/s/[shortCode].ts` is dead code that still exists and still imports the live module.** Either delete it or comment it as intentionally-unreachable, because the next person to debug link previews will read it and believe it runs. (This is a known-dead path, not a suspected one — see LOG 2026-08-10.)

---

## Suggested order of work

Roughly cheapest-and-highest-signal first:

1. **A0** — diagnose the 16 red specs on `main`. The uniform `toBeVisible` timeout points at one or two shared root causes, so start there rather than triaging sixteen tests. Two of the three files cover money surfaces.
2. **A2** — split the two Playwright report dirs and upload both. Small, and it restores the ability to answer "is e2e green?" from CI at all.
3. **A4** — determine which env-gated specs actually run in CI; treat unsatisfied money-path gates as coverage gaps, not as passing tests.
4. **A1** — decide, with real numbers in hand, whether e2e becomes blocking (possibly a green subset first, with the known-rotten specs quarantined explicitly rather than globally suppressed).
5. **A3** — re-measure CI wall-clock after the above and correct PLAYBOOK Rule 21.
6. **B1** — John's call on the Vercel plan; disable preview deploys on feature branches as a same-day mitigation either way.
7. **B2 / B3** — env-var assertion; delete or annotate the dead `api/s/` handler.

## What this handoff deliberately does not do

- **No changes were made to any of this.** PR #63 touches none of these files; the two e2e specs it edited were repointed because that change renamed the heading they asserted, which is in-scope for it.
- **No recommendation on the Vercel plan.** That's a spend decision.
- **No judgement on whether the non-blocking decision was wrong when it was made.** It was labelled and deliberate. The question is only whether it's still right.

## Related

- [PR #63](https://github.com/jsa7cornell/Sendmo/pull/63) — where these surfaced; its LOG entry records the two verification gotchas below.
- **Verification-tooling gap worth knowing before you audit anything UI-shaped:** the browser preview pane cannot verify step transitions in this app — Framer Motion's `AnimatePresence mode="wait"` never completes its exit there, so the outgoing step stays mounted under the new URL and reads exactly like a routing bug. Confirmed not-new by a control run on `main`'s own step 1 → step 10. Use Playwright for transitions. (LOG 2026-08-17.)
- **Test-quality pattern worth grepping for:** PR #63's first escape spec asserted the URL, then asserted on an element belonging to the step being *left* — so it passed against a UI that never swapped steps. Any transition test that only asserts URL + prior-step state has this bug. (LOG 2026-08-17.)
- LOG 2026-08-16 (Vercel Hobby rate limit, #62 held), LOG 2026-08-10 (middleware/OG, dead `api/s/`), LOG 2026-05-22 (SPA rewrite bypass).
