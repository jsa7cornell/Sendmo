---
title: Frontend error monitoring (Sentry) + analytics (PostHog) — T1-3 completion
slug: sentry-posthog-frontend-monitoring
project: sendmo
status: decided
created: 2026-07-06
last_updated: 2026-07-06 (Decision addendum appended — REVERSED by John same day; see addendum at end of file)
reviewed: 2026-07-06
decided: 2026-07-06
author: Claude session "SendMo — T1-3 monitoring wiring — 2026-07-06" (same session will implement)
reviewer: Claude (Fable 5) — fresh-eyes review session 2026-07-06; verified every file/claim against code at HEAD + the Sentry/PostHog SDK surfaces
outcome: approve-with-changes
---

# Frontend error monitoring (Sentry) + analytics (PostHog) — T1-3 completion

## 1. Context

**PRE-LAUNCH.md T1-3** is the last unfinished Tier-1 launch blocker. Its server half
shipped 2026-07-04: `_shared/alert.ts:sendAdminAlert` now emails John from every
money-path error site (`label.buy_error`, `auto_refund_failed` ×2,
`label.flex_off_session_error`, stripe-webhook refund-failed). What remains is the
**frontend half**: if a customer's browser throws — a render crash, a failed Stripe
Elements mount, a broken route — nobody finds out unless the customer emails us.
PLAYBOOK and SPEC both list "Sentry + PostHog" as the monitoring stack, but **zero
imports exist in `src/`** today.

This matters *now* because T1-1 is live in closed beta: real customers will hit the
frontend within days. A JS error in the payment step is invisible today.

**What this proposal covers:** the 🤖 code half — Sentry error capture wired into
`src/main.tsx`, and a deliberately minimal PostHog init. The 👤 half (John creates the
Sentry/PostHog projects and sets two Vercel env vars) is documented as a runbook at the
end. Like T1-1, **this ships inert**: with the env vars unset, both SDKs are never
initialized and the app behaves byte-for-byte as today.

**What honestly gets better / what doesn't:** after this + John's env vars, every
uncaught frontend exception and render crash lands in Sentry with the route, release
SHA, and browser context, and users see a graceful "something went wrong" screen
instead of a white page. What does NOT get better: server-side visibility (already
covered by the T1-3 alert half), performance profiling (not enabled), and product
funnels (PostHog lands as pageview-only; funnel events are an explicit fast-follow —
T1-3 itself calls PostHog "lower priority").

## 2. Architecture

```
BUILD TIME (Vercel)                      RUN TIME (browser)
──────────────────                       ──────────────────
vite.config.ts define:                   src/main.tsx
  __APP_RELEASE__  ← VERCEL_GIT_COMMIT_SHA   │
  __APP_ENV__      ← VERCEL_ENV              ▼
        │                                initMonitoring(import.meta.env)   src/lib/monitoring.ts
        │                                    │
        └────────────────────────────────►  ├─ VITE_SENTRY_DSN set?
                                             │    yes → Sentry.init({dsn, release, environment,
                                             │           browserTracing(router), sendDefaultPii:false})
                                             │    no  → skip entirely (local dev, CI, today's prod)
                                             ├─ VITE_POSTHOG_KEY set?
                                             │    yes → posthog.init({SPA pageviews,
                                             │           session recording OFF})
                                             │    no  → skip entirely
                                             ▼
                                         <Sentry.ErrorBoundary fallback={<CrashScreen/>}>
                                           <App/>                    ← unchanged
                                         </Sentry.ErrorBoundary>
```

Walkthrough — a customer on `/onboarding/full-label/payment` hits a render crash:
today they get a white screen and we never know. After this change, the ErrorBoundary
catches it, shows the crash screen ("Something went wrong — reload"), and Sentry
records the exception tagged `route=/onboarding/:pathSlug/:stepSlug`,
`release=<commit SHA>`, `environment=production`. John gets Sentry's email
notification (Sentry's own alerting, no code needed).

Walkthrough — a developer runs `npm run dev` locally: no `VITE_SENTRY_DSN` in their
env, so `initMonitoring` returns immediately. No SDK network calls, no behavior change,
no noise in the Sentry project from dev sessions.

### Design decisions (each is an invitation for the reviewer to push back)

1. **Gate on env-var presence, not `import.meta.env.PROD`.** Same "ships inert"
   pattern as T1-1's `SENDMO_LIVE_DEFAULT`: the code merges dead and John's env var is
   the switch. This also means preview deploys get Sentry *only if* John sets the var
   for the Preview environment (recommended: yes, with `environment` tag separating
   them — Vercel's `VERCEL_ENV` gives us `production` vs `preview` for free).

2. **A pure, unit-testable config resolver** (`resolveMonitoringConfig`) mirroring the
   `src/lib/mode.ts` pattern — the decision table (which vars enable what, fallbacks
   for release/environment) is pure TS with injected env, tested in vitest; the
   side-effectful `initMonitoring` wrapper stays thin.

3. **Sentry scope: errors + light tracing, no source-map upload, no session replay.**
   - `browserTracingIntegration` with React Router v7 instrumentation
     (`tracesSampleRate: 0.1`) so errors carry parameterized route names and we get
     coarse page-load timing. 10% keeps us far inside Sentry's free quota.
   - **Source-map upload deferred** (WISHLIST): it needs `@sentry/vite-plugin` + a
     `SENTRY_AUTH_TOKEN` build secret. Release tagging works without it (issues group
     by deploy); stack traces are minified until we add it. Cutting it keeps this PR
     free of new build-time secrets.
   - **No session replay** — a payments product; address forms on screen. Explicitly off.

4. **PII posture:** `sendDefaultPii: false` (no IP, no cookies). We do NOT call
   `Sentry.setUser` in this pass — not even the UID — so no auth-context coupling.
   If triage later needs user correlation, a follow-up can add `setUser({id})` (UUID
   only, never email). Stripe card data can never reach Sentry (Elements = iframe).

5. **PostHog: minimal, matching its "lower priority" billing in T1-3.**
   `posthog-js` init with SPA pageview capture (`capture_pageview: 'history_change'`),
   autocapture on, **session recording disabled** (`disable_session_recording: true` —
   same PII reasoning), `person_profiles: 'identified_only'`. No `identify()` calls, no
   custom funnel events — those need instrumentation across the step components and are
   the fast-follow T1-3 already anticipates. Including init now costs ~15 lines and
   means John's 👤 step is one visit to Vercel env vars for both tools.

6. **ErrorBoundary wraps `<App/>` in `main.tsx`, always** (even with Sentry disabled —
   `Sentry.ErrorBoundary` degrades to a plain React boundary). Today a render crash =
   white page; after this, a branded fallback with a reload button. Fallback uses
   design tokens (`bg-card rounded-2xl border border-border shadow-sm`), no new UI
   pattern.

7. **Release/environment via `vite.config.ts` `define`**, reading Vercel's build-time
   system env vars (`VERCEL_GIT_COMMIT_SHA`, `VERCEL_ENV` — auto-exposed by Vercel's
   default "expose system environment variables" setting). Locally both are undefined →
   `release: "dev"`, `environment: "development"`. No new `VITE_*` vars needed for
   these two.

### Bundle-size honesty

`@sentry/react` with browser tracing adds ~75 KB gzipped; `posthog-js` ~50 KB gzipped.
Both load in the main bundle (init must run before render to catch early errors —
lazy-loading Sentry defeats its purpose). This is the going rate for the industry-
standard stack the PLAYBOOK already committed to; flagging it so it's a decision, not
a surprise.

## 3. File-by-file plan

**New: `src/lib/monitoring.ts`** (~90 LOC)
```ts
export interface MonitoringConfig {
  sentry: { enabled: boolean; dsn: string; release: string; environment: string };
  posthog: { enabled: boolean; key: string; apiHost: string };
}

// Pure — injected env, unit-testable truth table (pattern: src/lib/mode.ts).
export function resolveMonitoringConfig(env: {
  sentryDsn?: string; posthogKey?: string; posthogHost?: string;
  release?: string; vercelEnv?: string;
}): MonitoringConfig { ... }

// Thin side-effect wrapper called once from main.tsx.
export function initMonitoring(): void { ... }
```
- `environment` mapping: `vercelEnv` `"production"` → `production`, `"preview"` →
  `preview`, else `development`. `release` falls back to `"dev"`.
- `initMonitoring` reads `import.meta.env.VITE_SENTRY_DSN` / `VITE_POSTHOG_KEY` and the
  two `define` globals, calls the resolver, then conditionally `Sentry.init` /
  `posthog.init`.
- Sentry init sketch:
  ```ts
  Sentry.init({
    dsn, release, environment,
    integrations: [Sentry.reactRouterV7BrowserTracingIntegration({
      useEffect, useLocation, useNavigationType, createRoutesFromChildren, matchRoutes,
    })],
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    ignoreErrors: [/* browser-extension + benign-abort noise, short curated list */],
  });
  ```

**New: `src/components/CrashScreen.tsx`** (~30 LOC) — the ErrorBoundary fallback.
Design-token card, "Something went wrong", reload button. No error details shown to
the user (they're in Sentry).

**Edit: `src/main.tsx`** (~10 LOC changed)
```tsx
import { initMonitoring } from './lib/monitoring'
import * as Sentry from '@sentry/react'
import CrashScreen from './components/CrashScreen'

initMonitoring()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<CrashScreen />}>
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>,
)
```

**Edit: `vite.config.ts`** (+4 LOC) — `define: { __APP_RELEASE__: ..., __APP_ENV__: ... }`
from `process.env.VERCEL_GIT_COMMIT_SHA` / `VERCEL_ENV`; matching `declare const` in
`src/vite-env.d.ts`.

**Edit: `src/pages/LabelTest.tsx`** (+~10 LOC) — a "Throw test error" button (the page
is already the internal test harness), so the T1-3 verification step ("throw a test
error → Sentry issue appears") is a click, not a code edit. Renders only when
monitoring is enabled or in dev.

**Edit: `package.json`** — add `@sentry/react`, `posthog-js`.

**Edit: `PRE-LAUNCH.md`** — T1-3 status update on land + again when John flips the vars.

**No edge-function changes. No schema changes. No changes to AuthContext, App.tsx
routes, or any payment path.**

## 4. Test plan

- **`tests/unit/monitoring.test.ts`** — truth table for `resolveMonitoringConfig`:
  {DSN set/unset} × {key set/unset} × {vercelEnv production/preview/undefined} ×
  release fallback. ~10 cases. This pins the "ships inert" contract: no DSN ⇒
  `sentry.enabled === false`.
- **`tests/unit/CrashScreen.test.tsx`** — render test: a child that throws inside the
  boundary shows the fallback (heading + reload button), not a blank screen.
- Full suite + `npx tsc -b --noEmit` green before push (Rule 18).
- e2e: none added — the monitoring path is env-gated off in CI; existing specs prove
  no regression in app boot.

## 5. Out of scope (explicit non-goals)

- **Source-map upload** (`@sentry/vite-plugin` + auth token) → WISHLIST entry.
- **PostHog funnel events + `identify()`** (onboarding funnel, buy conversion) →
  fast-follow, needs its own event-naming design.
- **Sentry on edge functions** — the Deno SDK story is different; the server half of
  T1-3 (admin-alert emails + event_logs) already covers it. Revisit only if alert
  volume demands aggregation.
- **Session replay / profiling** — deliberately off (PII).
- **Sentry alert-rule tuning** — Sentry's default "email on new issue" suffices at
  our traffic; John can tune in-dashboard.

## 6. Verification (end-to-end, after John's 👤 steps)

1. Merge (inert) → CI green → Vercel deploy green (Rule 21). Confirm prod boots with
   **no** Sentry/PostHog network calls (env vars not yet set) — DevTools network tab.
2. 👤 John: create Sentry project (React) + PostHog project (US cloud); set
   `VITE_SENTRY_DSN` + `VITE_POSTHOG_KEY` in Vercel (Production, and Preview for
   Sentry if desired); redeploy.
3. On sendmo.co: `/label-test` → "Throw test error" → issue appears in Sentry within
   ~1 min, tagged `release=<sha>`, `environment=production`, correct route.
4. Crash screen renders (the thrown error hits the boundary) with the reload button.
5. PostHog: navigate 3 routes → 3 pageviews visible in PostHog live events; confirm
   **no session recordings** are being captured.
6. Normal customer flow (test-mode buy) unaffected end-to-end.

## 7. Open questions

- **OQ1 — tracing on or off?** Proposed `tracesSampleRate: 0.1` for route-tagged
  errors + coarse perf. Zero would shave bundle (~20 KB) and quota; is the perf signal
  worth it at launch traffic?
- **OQ2 — PostHog now or strictly fast-follow?** Proposed: init now (15 lines, one 👤
  trip), events later. The alternative — Sentry-only PR — is even smaller and PostHog
  rides with the funnel-events follow-up.
- **OQ3 — preview deploys in Sentry?** Proposed yes (env-tagged). Costs occasional
  noise from preview testing; catches bugs before production.
- **OQ4 — is the LabelTest throw-button acceptable in prod?** It's behind no auth
  (LabelTest is unauthenticated today). Throwing a handled test error is harmless, but
  the reviewer may prefer it dev/admin-gated.

## Reconciliation with prior decided proposals

Scanned `proposals/` (2026-07-06). No prior proposal covers frontend monitoring; the
stack choice (Sentry + PostHog) predates the proposal protocol — it's in PLAYBOOK's
tech-stack table and SPEC §Phase-2, so this implements documented intent rather than
introducing a new vendor. Adjacent decided work honored: T1-1
([2026-07-04_customer-live-payments](2026-07-04_customer-live-payments_reviewed-2026-07-04_decided-2026-07-04.md))
established the "merge inert, env var is the switch" rollout pattern this proposal
copies; the T1-3 server half (LOG 2026-07-04) established `sendAdminAlert`, which this
does not touch. No external contract (MCP or otherwise) is affected.

---

## Review

```yaml
reviewer: Claude (Fable 5) — fresh-eyes review session 2026-07-06; verified every file/claim against code at HEAD + the Sentry/PostHog SDK surfaces
reviewed_at: 2026-07-06
verdict: approve-with-changes
```

### Summary

The right feature, the right patterns: this correctly reuses the T1-1 ships-inert
rollout (citation verified against the decided proposal), mirrors the `src/lib/mode.ts`
pure-resolver pattern (Rule 6), and takes the correct PII posture for a payments
product. The claims about the codebase mostly check out — `main.tsx`, `App.tsx`,
`vite.config.ts`, `package.json` (react 19.2, react-router-dom 7.13), `vercel.json`,
`alert.ts` all match. Four things need fixing before implementation: the
parameterized-route claim quietly requires an App.tsx change the file plan disclaims,
the "ships inert / byte-for-byte" contract is internally contradicted, §1 and §2.5
disagree about what PostHog captures, and the test plan doesn't name its Rule 19
Browser-verified block. All four are cheap to fix; none invalidate the design.

### Blocking issues

**B1 — The parameterized-route claim requires wrapping `<Routes>` in App.tsx, which §3
explicitly says won't change.**
- *Location:* §2 walkthrough ("tagged `route=/onboarding/:pathSlug/:stepSlug`") + §3
  Sentry init sketch vs. §3 closing line ("No changes to … App.tsx routes").
- *Issue:* `Sentry.reactRouterV7BrowserTracingIntegration` alone instruments
  pageload/navigation spans with **raw URLs**. Parameterized route names (on
  transactions, and hence the route context attached to errors) require wrapping the
  routes component: `const SentryRoutes = Sentry.withSentryReactRouterV7Routing(Routes)`
  and using `<SentryRoutes>` in [src/App.tsx](../src/App.tsx) (line 60). As written, the
  proposal either delivers raw-URL tags (weaker than the §2 walkthrough promises John)
  or the implementer improvises an App.tsx edit outside the reviewed file plan.
- *Suggested fix:* add the one-line wrapper to the §3 file plan (App.tsx, ~2 LOC — the
  HOC is a safe pass-through when `Sentry.init` was never called, so it doesn't break
  the inert contract), and amend the "No changes to App.tsx routes" line to "route
  *definitions* unchanged; `Routes` swapped for the Sentry wrapper." Alternatively,
  keep App.tsx untouched and downgrade the §2 walkthrough to raw-URL tagging — but say
  which.

**B2 — "Ships inert … behaves byte-for-byte as today" (§1) is contradicted by the
proposal's own §2.6, and the T1-1 precedent shows the honest way to state this.**
- *Location:* §1 ("with the env vars unset … the app behaves byte-for-byte as today")
  vs. §2.6 ("ErrorBoundary wraps `<App/>` … **always**, even with Sentry disabled") and
  the §2 bundle-size section (+~125 KB gzipped ships to every user pre-flip).
- *Issue:* both can't be true. With env vars unset, a render crash today = white page;
  after this merge = branded CrashScreen. That's a deliberate, *good* pre-flip behavior
  change — but the inert contract as stated overpromises. The cited T1-1 work handled
  this exactly right: its LOG entry has an explicit **"Behavior changes visible BEFORE
  the flip (deliberate, per decided design)"** list. Drift between the stated inert
  contract and reality is the recurrence class the proposal protocol warns about
  (decided proposals are load-bearing; a future agent reading "byte-for-byte" will
  mis-assume).
- *Suggested fix:* restate the contract precisely — "inert = no SDK init, no monitoring
  network calls, zero data leaves the browser" — and enumerate the two pre-flip visible
  changes (crash screen replaces white page; bundle +~125 KB). Carry the same list into
  the LOG entry on merge, T1-1-style.

**B3 — The test plan doesn't satisfy Rule 19: no Browser-verified block shape or
variant axis is named.**
- *Location:* §4 vs. PLAYBOOK Rule 19 (product-surface changes — `src/main.tsx`,
  `src/pages/LabelTest.tsx`, new `src/components/CrashScreen.tsx` all qualify).
- *Issue:* the LOG entry for this merge will require exactly one structured
  `Browser-verified:` block, and Rule 19's variant-axis discipline says name the
  variants of the changed path. §4 offers unit tests and "e2e: none added" without
  committing to a shape. The pieces actually exist in §6 (DevTools no-network check,
  crash-screen render) — they're just not assembled into the Rule 19 contract, which
  forces the implementer to improvise at LOG time (the exact gap the rule closes).
- *Suggested fix:* commit in §4 to the block, e.g. `spec:
  tests/unit/CrashScreen.test.tsx` + an `mcp-session:` dev-server pass, with
  `variants-covered: [{DSN unset → no monitoring network calls + crash screen renders},
  {DSN set locally → Sentry event fires + crash screen renders}]`, and state explicitly
  that the DSN-set-in-prod variant is deferred to §6 steps 3–5 (post-flip), mirroring
  how T1-1's live variants were deferred to its §5 step-4 smoke tests.

**B4 — §1 promises John "PostHog lands as pageview-only"; §2.5 turns autocapture on.
On a payments product these are different privacy decisions.**
- *Location:* §1 ("PostHog lands as pageview-only") vs. §2.5 ("SPA pageview capture …,
  **autocapture on**").
- *Issue:* autocapture is not pageview-only — it records clicks/interactions including
  `$element_text` of clicked elements. On pages where user data can be interpolated
  into buttons/links (address confirmations, "Continue as …"), that's PII leaking into
  a third-party analytics store, against both the proposal's own §2.4 posture and the
  spirit of the logging rule "never log PII in properties" (PLAYBOOK, Logging §Rules
  #5). John decides from §1's framing; §2.5 is what ships.
- *Suggested fix:* make them agree. Recommended: `autocapture: false` for this pass —
  truly pageview-only, matching §1, T1-3's "lower priority" billing, and the
  fast-follow plan (funnel events will be explicit captures anyway, which are better
  than autocapture for funnels).

### Non-blocking concerns

**N1 — `src/vite-env.d.ts` does not exist.** §3 lists it as an edit ("matching `declare
const` in `src/vite-env.d.ts`") — verified: no `.d.ts` exists anywhere under `src/`;
`import.meta.env` typing comes from `tsconfig.app.json` `types: ["vite/client"]`. The
file must be **created** (it will be picked up via `include: ["src"]`). Related: the
`define:` values in `vite.config.ts` must be `JSON.stringify`-wrapped or the build
injects bare tokens. Both are trivial, but each is a `tsc -b` / build failure if
forgotten (Rule 18).

**N2 — §6 should verify the release/environment tags, not assume them.** §2.7 leans on
Vercel's "automatically expose system environment variables" **project setting**
(default-on, but a setting, not a law). If it's off — or a future agent toggles it —
every prod error silently lands `release="dev", environment="development"`: monitoring
"works" but is untriageable, the Rule 20 "system claims success" shape. Add to §6 step
3: assert the Sentry issue shows `release=<real sha>` and `environment=production`,
and check the Vercel setting during John's 👤 step.

**N3 — PostHog's defaults collect client IP and set cookies/localStorage;
`sendDefaultPii: false` covers Sentry only.** Check that `/privacy` (a real page per
PRE-LAUNCH "already solid") discloses third-party analytics/error tracking, or add a
line. Cheap now, awkward after a customer asks. Optionally set PostHog's IP
anonymization / `respect_dnt`.

**N4 — Env-var documentation debt.** PLAYBOOK's "Environment Variables" section and the
"Environment variables on Vercel" list, plus `.env.example`, should gain
`VITE_SENTRY_DSN` / `VITE_POSTHOG_KEY` (the T1-1/N4 precedent documented its paired
vars in PLAYBOOK). The §3 file list has PRE-LAUNCH.md only.

**N5 — Bundle: PostHog need not ride the critical path.** The "init must run before
render" argument is correct for **Sentry** (early-error capture) but doesn't apply to
analytics — `posthog-js` can be dynamically imported after first paint, cutting ~50 KB
gzipped from the checkout-critical main bundle at the cost of ~10 lines. Worth doing on
a mobile-heavy payments funnel; fine to decline with a sentence.

**N6 — Name the initial `ignoreErrors` list in the PR.** "Short curated list" is where
noise-vs-signal lives. Suggest starting from the well-known set (browser-extension
frames, `ResizeObserver loop`, benign `AbortError`) and note that ad-blockers will
drop some fraction of both SDKs' traffic (accepted limitation, no proxy at this stage).

### Nits

- §3 labels `src/vite-env.d.ts` "Edit" — it's "New" (see N1).
- §2.6's "degrades to a plain React boundary" claim **verified accurate**:
  `Sentry.ErrorBoundary` calls `captureException` in `componentDidCatch`, which is a
  safe no-op with no client initialized. Worth keeping the verification in-repo as a
  comment, since the claim is load-bearing for the inert contract.
- Pin the `@sentry/react` major on install and confirm React 19 + RR v7 support in the
  changelog at that version (current major supports both — verified — but majors move).
- `LabelTest.tsx:21-22` contains a leftover editing-artifact comment ("I will rewrite
  this to use multi_replace…") — unrelated to this proposal, but since you're editing
  the file anyway, delete it.
- CrashScreen: consider one support line (mailto or /faq link) so a crashed customer
  mid-payment has a next step besides reload.

### Predicted pitfalls (required)

1. **Red `main` from the type-check, not the tests (Rule 18 / 2026-05-21 incident
   class).** Two new deps + two new ambient globals + a new `.d.ts` file is exactly the
   shape that passes Vitest and fails `tsc -b` (missing `declare const __APP_RELEASE__`,
   unused import, un-stringified `define`). The 2026-05-21 incident left `main` red for
   ~18h across 5 pushes. Mitigation: N1 + Rule 18 before push + Rule 21 deploy-watch.
2. **Silently mistagged telemetry.** If the Vercel system-env setting is off or the
   DSN var is scoped wrong, Sentry receives events tagged `release=dev` /
   `environment=development` — everything looks green, and the first real launch-week
   incident arrives untriageable (which deploy? prod or preview?). This is the Rule 20
   "system claims success, user reports failure" shape, moved into the monitoring
   layer itself. Mitigation: N2's assert-the-tags verification step.
3. **The public throw button burns the Sentry quota.** `/label-test` is unauthenticated
   (verified — no ProtectedRoute in App.tsx), and §3 renders the button "when
   monitoring is enabled" — i.e., publicly, in prod, post-flip. Bots and one bored
   stranger can spam real exceptions into a free-tier quota (~5k events/mo), rate-
   limiting out genuine launch-week errors. Same recurrence class as T2-3 (public
   endpoints burning EasyPost/Google quota — PRE-LAUNCH T2-3, shipped 2026-07-04). See
   OQ4 answer.
4. **Autocapture PII drift (if B4 resolves toward "on").** Nobody reviews what
   `$element_text` collects as new UI ships; months later a compliance/privacy pass
   finds customer names or address fragments in PostHog. The project's own logging rule
   ("never log PII in properties") exists because this class is silent until audited.
   Mitigation: B4's `autocapture: false`.

### What the proposal got right

- **Correct reuse of decided patterns, correctly cited:** T1-1's ships-inert rollout
  (citation verified against the decided proposal — accurately represented) and the
  `mode.ts` pure-resolver + injected-env pattern (Rule 6). This is how the protocol is
  supposed to work.
- **The PII posture is exactly right for a payments product** — session replay off,
  `sendDefaultPii: false`, no `setUser`, and the Stripe-Elements-iframe observation is
  accurate.
- **Bundle-size honesty** (§2) — flagging the +125 KB as a decision instead of burying
  it, and the "lazy-loading Sentry defeats its purpose" reasoning is correct (for
  Sentry; see N5 for PostHog).
- **Source-map upload deferred** — the right scope cut; keeps the PR free of a new
  build-time secret, and release grouping works without it.
- **"No edge-function changes, no schema changes" verified true** — the file plan is
  frontend-only; the external-contract check passes.
- **Verification split** (§6) between merge-time inert checks and post-flip live checks
  mirrors the T1-1 rollout discipline.

### Recommended answers to OQ1–OQ4 (for John, one pass)

- **OQ1 — keep `tracesSampleRate: 0.1`.** It's what carries route-level context and
  coarse page-load timing during the window you most need it (launch weeks), and 10%
  is well inside free quota at closed-beta traffic. Note it only delivers the promised
  parameterized routes if B1's wrapper lands. Revisit (possibly to 0) after a month of
  real data.
- **OQ2 — init PostHog now, but truly pageview-only** (`autocapture: false`, per B4).
  One Vercel trip for John covering both tools is worth the ~15 lines; explicit funnel
  events in the fast-follow will be better than autocapture anyway.
- **OQ3 — yes, enable Sentry on Preview deploys,** environment-tagged. The DSN is
  publishable, `VERCEL_ENV` separates the streams for free, and preview noise is
  filterable. Scope the Vercel var deliberately (Production + Preview, not
  Development) — the same env-scoping discipline the T1-1 review flagged as pitfall #3.
- **OQ4 — no, not as sketched.** Gate the throw button on `import.meta.env.DEV ||
  isAdmin`, not on "monitoring enabled" (predicted pitfall 3: public + spammable =
  quota burn). John triaging prod can still throw a test error from the console or
  while signed in as admin; strangers shouldn't have a crash-the-app button on an
  unauthenticated page of a payments product.

## Author response

*(author session, 2026-07-06 — same session as the draft; implementing after this response)*

**B1 — route wrapper requires an App.tsx change. ✅ Accept.** The reviewer is right that
`reactRouterV7BrowserTracingIntegration` alone yields raw-URL transaction names and the
§2 walkthrough promised parameterized routes. Adopting the suggested fix: §3 gains an
App.tsx edit — `const SentryRoutes = Sentry.withSentryReactRouterV7Routing(Routes)` and
`<Routes>` → `<SentryRoutes>` (~2 LOC; route *definitions* unchanged). The HOC is a
pass-through when Sentry was never initialized, so the inert contract holds.

**B2 — "byte-for-byte" overpromises. ✅ Accept.** The precise contract is: **inert = no
SDK initialization, no monitoring network calls, zero data leaves the browser.** Two
pre-flip visible changes ship deliberately: (1) a render crash now shows the branded
CrashScreen instead of a white page — an improvement we want regardless of Sentry;
(2) main bundle grows ~75 KB gzipped (Sentry; PostHog moves off the critical path per
N5, see below). The LOG entry will carry a T1-1-style "Behavior changes visible BEFORE
the flip" list.

**B3 — Rule 19 block not committed in the test plan. ✅ Accept.** Committing now:

```
Browser-verified:
  mcp-session: <dev-server pass, artifact/excerpt in LOG entry>
  variants-covered: [{DSN unset → app boots, zero monitoring network calls, crash
    screen renders on thrown error}, {DSN set (local dev value) → Sentry init runs +
    event POST observed on thrown error}, {prod DSN + release/environment tags →
    deferred to §6 steps 3–5, post-flip (T1-1 §5-step-4 pattern)}]
```

plus `spec: tests/unit/CrashScreen.test.tsx` for the boundary render. (One shape per
entry — the `mcp-session:` block is the primary; the unit spec is listed in Tests.)

**B4 — §1 vs §2.5 disagree on autocapture. ✅ Accept — `autocapture: false`.** Truly
pageview-only, matching §1's framing to John and the PII posture. The fast-follow's
explicit funnel events are better for conversion analysis than autocapture anyway.

**N1 (vite-env.d.ts is New, not Edit; JSON.stringify the defines) ✅** — also guarding
the global reads with `typeof __APP_RELEASE__ !== "undefined"` so vitest (separate
`vitest.config.ts`, no `define`) can never hit a bare token.
**N2 (assert release/environment tags in §6; check the Vercel system-env setting) ✅** —
added to §6 step 3 and John's 👤 runbook.
**N3 (privacy disclosure) ✅** — will check `/privacy` during implementation and add a
third-party error-monitoring/analytics line if absent; PostHog gets `respect_dnt: true`.
**N4 (env-var documentation) ✅** — PLAYBOOK env sections + `.env.example` gain both vars.
**N5 (PostHog off the critical path) ✅** — `posthog-js` becomes a post-first-paint
dynamic `import()`; only Sentry rides the main bundle (~75 KB, not ~125 KB).
**N6 (name the ignoreErrors list) ✅** — browser-extension frames, `ResizeObserver loop
limit exceeded`/`loop completed`, benign `AbortError`. Ad-blocker attrition noted as an
accepted limitation in the LOG entry.

**Nits:** all taken — vite-env.d.ts relabeled New; the ErrorBoundary-degrades
verification lands as a code comment; `@sentry/react` pinned at install after a
changelog check; the LabelTest editing-artifact comment (verified present at
`LabelTest.tsx:21`) gets deleted; CrashScreen gains a "contact support" mailto line.

**OQ resolutions (adopting all four reviewer recommendations):**
- **OQ1:** `tracesSampleRate: 0.1`, with B1's wrapper so routes are parameterized.
  Revisit after a month of data.
- **OQ2:** PostHog now, truly pageview-only (`autocapture: false`), dynamically
  imported (N5).
- **OQ3:** Sentry on Production + Preview (environment-tagged), not Development —
  John scopes the Vercel var accordingly.
- **OQ4:** throw button gated `import.meta.env.DEV || isAdmin` — no public crash
  button on an unauthenticated page (reviewer's T2-3 quota-burn recurrence argument
  is exactly right).

No unresolved points; nothing needs a Tradeoffs-for-John section.

## Decision

**Approved (approve-with-changes accepted in full) — 2026-07-06.** Authorization: John's
2026-07-06 directive to tackle PRE-LAUNCH T1-3 with a proposal review; review and author
response converged with zero unresolved points, all four OQs resolved per the reviewer's
recommendations. The 👤 half (Sentry/PostHog project creation + Vercel env vars, §6
steps 2–5) remains John's, and he can override any OQ choice at that step — nothing in
this merge is irreversible (env vars unset = fully inert). Implementation begins in the
author session; spec = sections 1–7 **as amended by the Author response** (B1 App.tsx
wrapper, B2 restated inert contract, B3 Rule 19 block, B4 + N5 PostHog
pageview-only/deferred-import).

## Decision addendum — REVERSED by John (2026-07-06, same day)

**John's direction (2026-07-06, after the flip hold recorded in LOG `939313b`):
SendMo will not use Sentry or PostHog.** This resolves the hold's "Decision John is
holding" as option 3 in its strongest form — the vendor choice is reversed, not
paused. No vendor accounts were ever created; no env vars were ever set; the merged
code (`364462a`) ran fully inert its whole life, so **nothing external needs
unwinding**.

What this means going forward:

- **Do NOT create Sentry/PostHog accounts or set `VITE_SENTRY_DSN` /
  `VITE_POSTHOG_KEY`** — this supersedes the "when John resolves the hold" framing
  in PRE-LAUNCH T1-3 and the §6 runbook above.
- **The merged inert layer is slated for removal.** The removal (deps, Sentry
  plumbing in `main.tsx`/`App.tsx`/`vite.config.ts`, PostHog branch) plus the
  replacement analytics (GA4) are specified in
  [2026-07-06_ga4-acquisition-analytics.md](2026-07-06_ga4-acquisition-analytics.md)
  — in-review; nothing is removed until that proposal is decided.
- **What survives the reversal:** the CrashScreen error boundary (this review's B2:
  "an improvement we want regardless of Sentry" — reimplemented as a plain React
  boundary), the pure-resolver ships-inert pattern in `monitoring.ts` (retargeted
  to GA4), the N3 privacy-disclosure discipline, and the untouched **server half of
  T1-3** (admin-alert emails).
- **The reviewed engineering in this file remains load-bearing institutional
  memory** — the PII postures, the idle-load rule, and the inert-contract wording
  are all carried forward by the GA4 proposal; only the vendors changed.

