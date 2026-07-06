---
title: GA4 as the only analytics tool + removal of the inert Sentry/PostHog layer
slug: ga4-acquisition-analytics
project: sendmo
status: decided
created: 2026-07-06
last_updated: 2026-07-06 (Decision appended — approved by John same day)
reviewed: 2026-07-06
decided: 2026-07-06
author: Claude session "SendMo — SEO + GA4 discovery research — 2026-07-06"
reviewer: Claude (Fable 5) — fresh-eyes review session 2026-07-06; verified every file/line claim against origin/main and the gtag.js/GA4 semantics from knowledge
outcome: approve-with-changes
---

# GA4 as the only analytics tool + removal of the inert Sentry/PostHog layer

## 1. Context

**John's 2026-07-06 direction: SendMo will not use Sentry or PostHog.** This resolves
the T1-3 flip hold (LOG entry `939313b`, "Decision John is holding" → option 3:
reconsider the vendor choice) in the strongest form — the vendors are out, not
paused. That has two consequences this proposal now covers as one PR:

**1. GA4 becomes SendMo's only analytics tool — not a complement.** The first draft
of this proposal positioned GA4 as the acquisition layer on top of PostHog's product
analytics. With PostHog gone, GA4 carries everything analytics: pageviews now,
funnel/conversion events in the fast-follow (single sink, no dual-instrumentation
helper), Search Console query reports, channel attribution, and Google Ads
readiness. A practical point in its favor given how the flip hold arose: GA4 lives
under John's **existing Google account** — no new vendor org, though it does mean
accepting Google Analytics terms for the property.

**2. The merged inert Sentry/PostHog layer comes out.** The T1-3 frontend half
merged this morning (`364462a`, decided proposal
[2026-07-06_sentry-posthog-frontend-monitoring](2026-07-06_sentry-posthog-frontend-monitoring_reviewed-2026-07-06_decided-2026-07-06.md))
ships inert — but not free: `@sentry/react` rides the checkout-critical main bundle
(~75 KB gzipped), both SDKs sit in `package.json`, and `main.tsx` / `App.tsx` /
`vite.config.ts` carry Sentry plumbing. With no future flip, that's permanent dead
weight and a standing trap for future agents ("why is Sentry imported but never
initialized?"). Removing it in the same PR that adds GA keeps `monitoring.ts` from
being touched twice.

**What survives the removal — deliberately:** the **CrashScreen error boundary**.
The T1-3 review (B2) established it as "an improvement we want regardless of
Sentry," and that reasoning is unchanged: without it, a render crash is a white
page. It just needs a plain ~20-LOC React boundary instead of `Sentry.ErrorBoundary`
(React ships no boundary component; writing one is the standard pattern, not a new
construct). The **server half of T1-3 is untouched and unaffected** — admin-alert
emails from every money-path error site have nothing to do with Sentry.

**What honestly gets worse — and the $0 tripwire that narrows it (John's call,
2026-07-06 follow-up):** frontend error visibility. Dropping Sentry re-opens the
gap the T1-3 frontend half existed to close — if a customer's browser throws
(render crash, failed Stripe Elements mount), nobody finds out unless they email
support. GA4 is **not** an error monitor: no stack traces, no grouping, no
alerting. John weighed Sentry's free tier (real, ~5k errors/mo) against staying
lean and chose lean — so this proposal folds in the next-best thing at zero cost:
**a GA `exception`-event tripwire** (§2.7). The CrashScreen boundary and global
error handlers send `gtag('event', 'exception', …)` with the error name and page
path — converting "completely blind" into "a crash counter with a location."
What the tripwire honestly does NOT give: stacks (a spike must be reproduced
manually to debug), notifications (John checks GA), or same-day data (24–48 h
report lag; Realtime shows counts sooner). Server-side money-path failures still
email John, unchanged. The named escalation trigger: **an exception spike that
can't be reproduced manually is the day Sentry's free tier earns its account** —
solving an observed problem, not insuring a hypothetical one. No bespoke
browser→server error endpoint (a public report path is exactly the
unauthenticated-endpoint spam/quota class T2-3 exists for).

## 2. Architecture

`src/lib/monitoring.ts` keeps its decided shape — pure env-injected resolver +
thin init wrapper, gated on env-var presence, ships inert — and slims to one tool:

```
BUILD TIME (Vercel)                RUN TIME (browser)
──────────────────                 ──────────────────
VITE_GA_MEASUREMENT_ID             src/main.tsx
  (Vercel env var,                     │
   Production only — OQ3)              ├─ initMonitoring()          src/lib/monitoring.ts
        │                              │    └─ VITE_GA_MEASUREMENT_ID set AND browser
        │                              │       DNT not enabled?  (OQ5)
        └─────────────────────────►    │         no  → skip entirely (today's prod, dev,
                                       │               CI — inert: no script, no network
                                       │               calls, zero data leaves the browser)
                                       │         yes → requestIdleCallback → inject gtag.js
                                       │               <script async>, then
                                       │               gtag('config', id, {
                                       │                 allow_google_signals: false,
                                       │                 allow_ad_personalization_signals: false,
                                       │               })
                                       │               → initial page_view
                                       │               → SPA route changes: GA4 Enhanced
                                       │                 Measurement history-change
                                       │                 detection (§6 verifies, OQ4)
                                       │               → window 'error' + 'unhandledrejection'
                                       │                 listeners → trackException() (§2.7)
                                       ▼
                                   <ErrorBoundary fallback={<CrashScreen/>}>   ← NEW plain
                                     <App/>          boundary replaces Sentry.ErrorBoundary;
                                   </ErrorBoundary>  componentDidCatch → trackException()
```

### Design decisions (each an invitation to push back)

1. **Same ships-inert contract, same wording:** inert = no script tag, no analytics
   network calls, zero data leaves the browser when `VITE_GA_MEASUREMENT_ID` is
   unset. The **removal half is a real pre-flip change** and is stated as such
   (T1-1/T1-3 honesty convention): main bundle shrinks ~75 KB gzipped, two deps
   leave `package.json`, and the crash boundary swaps implementation with identical
   user-visible behavior (unit-tested, §4).
2. **PII/ads posture carried over from the reversed proposal's decisions** (the
   postures were reviewed and right; only the vendor died): no ads signals
   (`allow_google_signals: false`, `allow_ad_personalization_signals: false` until a
   deliberate Ads decision), no `user_id`, no custom events, no session recording of
   any kind (GA4 has none — moot), no revenue values ever (the append-only ledger is
   the only money truth, Rule 16 culture).
3. **Honor the existing Do-Not-Track promise (OQ5).** `/privacy` currently tells
   users "we honor your browser's Do Not Track setting for analytics" — that was
   implemented by PostHog's `respect_dnt`. GA4 has no such option, so keeping the
   sentence honest costs ~3 LOC: the resolver takes a `doNotTrack` input and
   `ga.enabled` requires it false. Recommended over quietly deleting a published
   privacy promise.
4. **SPA pageviews via GA4 Enhanced Measurement** (history-change detection,
   property-level, default ON) — zero code, supported path. Known failure mode is
   stale `document.title` racing the route change; acceptable because reports key on
   paths. Named fallback if §6 step 4 shows misattribution: ~10-LOC manual
   `page_view` on router location change.
5. **Production-only env var (OQ3).** GA4 has no free environment dimension;
   preview traffic would pollute the single property.
6. **US-only launch → no consent banner.** With ads signals off and GA4's no-stored-IP
   behavior, US-only is fine without a consent layer. **Consent Mode v2 becomes
   mandatory if EEA/UK marketing ever starts** — WISHLIST line so it isn't
   rediscovered the hard way.
7. **The exception tripwire (decided by John 2026-07-06, replacing old OQ1).**
   A `trackException(error, fatal)` helper pushes GA's standard `exception` event
   with a PII-safe payload: `description` = `error.name: error.message` truncated
   to 150 chars (never the URL, never form values, no stack), plus the SPA route
   path via `page_location` handling gtag already does. Wired from three places:
   the ErrorBoundary's `componentDidCatch` (fatal render crashes), a `window`
   `error` listener, and an `unhandledrejection` listener (both non-fatal). Two
   properties make this near-free: (a) gtag calls are `dataLayer.push` — they
   queue even before the idle-loaded script arrives, so early errors aren't lost;
   (b) when GA is disabled (no env var / DNT), `trackException` is a no-op, so the
   boundary works everywhere with zero coupling. Dedupe guard: at most 10
   exception events per page load (a render-loop crash must not machine-gun the
   GA quota — the same runaway-noise class the T1-3 review's `ignoreErrors` list
   handled for Sentry).

## 3. File-by-file plan

**Rewrite: `src/lib/monitoring.ts`** (net −~90 LOC) — same file, same pattern, one tool:
```ts
export interface MonitoringConfig {
  ga: { enabled: boolean; measurementId: string };
}
export interface MonitoringEnv {
  gaMeasurementId?: string;
  doNotTrack?: boolean;   // navigator.doNotTrack === "1" (§2.3)
}
// Pure — injected env, unit-tested truth table (pattern unchanged from the
// decided T1-3 resolver, which itself followed src/lib/mode.ts).
export function resolveMonitoringConfig(env: MonitoringEnv): MonitoringConfig {
  return {
    ga: {
      enabled: !!env.gaMeasurementId && !env.doNotTrack,
      measurementId: env.gaMeasurementId ?? "",
    },
  };
}
export function initMonitoring(): void {
  const cfg = resolveMonitoringConfig({
    gaMeasurementId: import.meta.env.VITE_GA_MEASUREMENT_ID,
    doNotTrack: navigator.doNotTrack === "1",
  });
  if (!cfg.ga.enabled) return;
  // same idle() helper the T1-3 implementation used — analytics never rides
  // the checkout-critical path; load failure is silent best-effort
  idle(() => {
    const s = document.createElement("script");
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${cfg.ga.measurementId}`;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer ?? [];
    const gtag = (...args: unknown[]) => { window.dataLayer.push(args); };
    gtag("js", new Date());
    gtag("config", cfg.ga.measurementId, {
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });
  });
  // §2.7 tripwire — capture-phase listeners; trackException no-ops if GA disabled
  window.addEventListener("error", (e) => trackException(e.error ?? e.message, false));
  window.addEventListener("unhandledrejection", (e) => trackException(e.reason, false));
}

let exceptionCount = 0;
/** GA exception tripwire (§2.7). PII-safe, deduped, no-op when GA disabled. */
export function trackException(err: unknown, fatal: boolean): void {
  if (!gaEnabled || exceptionCount >= 10) return;   // gaEnabled set in initMonitoring
  exceptionCount++;
  const description = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 150);
  window.dataLayer?.push(["event", "exception", { description, fatal }]);
}
```
(Sketch shows intent — implementation routes through the same `gtag()` closure so
the arguments object shape matches; details at implementer's discretion.) All
Sentry/PostHog imports, config, `IGNORE_ERRORS`/`DENY_URLS`, and the
`__APP_RELEASE__`/`__APP_ENV__` reads go (release/environment tagging existed only
for Sentry).

**New: `src/components/ErrorBoundary.tsx`** (~25 LOC) — plain class boundary:
`componentDidCatch(error)` calls `trackException(error, true)` then renders
`fallback`. Replaces `Sentry.ErrorBoundary` in main.tsx. `CrashScreen.tsx` itself
is unchanged except its header comment (which currently says errors go to Sentry —
after this it must say: a count goes to GA when enabled, details go nowhere).

**Edit: `src/main.tsx`** — drop the `@sentry/react` import and `Sentry.ErrorBoundary`,
use the local boundary; `initMonitoring()` call site unchanged.

**Edit: `src/App.tsx`** — the `SentryRoutes` wrapper (lines 32/66/116) reverts to
plain `<Routes>`; route definitions untouched.

**Edit: `vite.config.ts` + `src/vite-env.d.ts`** — remove the `define:` block and the
two ambient `declare const`s (Sentry-only consumers); add
`interface Window { dataLayer: unknown[] }`.

**Edit: `package.json`** — remove `@sentry/react`, `posthog-js`. **No new
dependencies** (gtag is a script tag).

**Edit: `src/pages/Privacy.tsx`** (~2 LOC) — the third-party sentence drops
Sentry/PostHog and gains "Google Analytics (anonymous page-view statistics; no
name, address, or payment details, no advertising use)". The DNT sentence stays —
now backed by §2.3.

**Edit: `tests/unit/monitoring.test.ts`** — truth table rewritten:
{id set/unset} × {DNT on/off} → `ga.enabled`; id fallback `""`.
**Edit: `tests/unit/CrashScreen.test.tsx`** — retarget to the local boundary
(a child that throws renders CrashScreen, not a blank screen).

**Edit: `.env.example` + PLAYBOOK** — remove `VITE_SENTRY_DSN` / `VITE_POSTHOG_KEY` /
`VITE_POSTHOG_HOST`, add `VITE_GA_MEASUREMENT_ID=`; PLAYBOOK tech-stack row
"Monitoring | Sentry + PostHog" becomes "Analytics | GA4 (gtag.js) — alerting =
server admin-alert emails (`_shared/alert.ts`)".

**Edit: `PRE-LAUNCH.md` + `WISHLIST.md`** — T1-3 status reflects the reversal (the
docs-side status update lands with the reversal record; the implementation PR
re-touches it on merge); WISHLIST gains "Consent Mode v2 before any EEA/UK
marketing" and re-scopes the funnel-events fast-follow to GA-only
(`track()` → `gtag('event')` behind the enabled flag); the WISHLIST "Sentry
source-map upload" line from T1-3 is deleted (moot).

**No edge-function changes. No schema changes. No changes to any payment path.**

## 4. Test plan

- **`tests/unit/monitoring.test.ts`** — resolver truth table (§3); pins the
  ships-inert contract and the DNT gate. Plus `trackException` cases: no-op when GA
  disabled; pushes a PII-safe truncated description when enabled; stops at the
  10-per-pageload cap.
- **`tests/unit/CrashScreen.test.tsx`** — throwing child → CrashScreen renders via
  the new plain boundary (proves the removal didn't regress the B2 improvement),
  and `componentDidCatch` invoked `trackException` with `fatal: true`.
- Full suite + `npx tsc -b --noEmit` green before push (Rule 18 — note this PR
  *removes* two deps and two ambient globals; the incident class the T1-3 review's
  pitfall 1 warned about applies in reverse: a leftover `__APP_RELEASE__` reference
  or stale import fails the build, not the tests).
- **Rule 19 Browser-verified block** (committed now):
  ```
  Browser-verified:
    mcp-session: <dev-server pass>
    variants-covered: [
      {VITE_GA_MEASUREMENT_ID unset → app boots; zero requests to googletagmanager.com
        or google-analytics.com; thrown test error → CrashScreen renders (plain boundary),
        no exception event attempted},
      {var set (local test id) → gtag.js loads after idle; /g/collect page_view fires on
        load AND on a client-side route change; thrown test error → exception event with
        truncated description visible in the /g/collect payload},
      {var set + browser DNT enabled → no gtag script, no GA network calls},
      {prod property + Search Console link → deferred to §6 steps 2–5, post-flip}
    ]
  ```

## 5. Out of scope (explicit non-goals)

- **Real error monitoring (stacks, grouping, alerting)** — the §2.7 tripwire is a
  crash *counter*, deliberately not a Sentry substitute; the escalation trigger is
  named in §1. No bespoke browser→server error endpoint (T2-3 spam/quota class).
- **Custom events / funnels / key events** — fast-follow, now single-sink:
  `track(event, props)` → `gtag('event', …)` behind `ga.enabled`; marking
  `link_created` / `label_purchased` as GA4 key events is a 👤 UI step then.
- **Google Ads linkage, remarketing, demographics** — off until an Ads decision.
- **Consent banner / Consent Mode v2** — WISHLIST-gated on EEA/UK marketing.
- **Revenue/ecommerce values in GA** — never; the ledger is truth.
- **Google Tag Manager** — an indirection layer for one tag (Rule 6 bait).

## 6. Verification (end-to-end, after John's 👤 steps)

1. Merge → CI green → deploy green (Rule 21). On prod (var unset): **no** requests
   to `googletagmanager.com` / `google-analytics.com`; bundle size dropped vs the
   prior deploy (Vercel build output); test-mode buy flow end-to-end unaffected.
2. 👤 **John (~10 min, one property, existing Google account):**
   analytics.google.com → create property "SendMo" (US timezone) → Web data stream
   for `https://sendmo.co` → copy the `G-XXXXXXXXXX` ID → set
   `VITE_GA_MEASUREMENT_ID` in Vercel (**Production only**) → redeploy. In the
   stream settings, confirm Enhanced Measurement is ON including "Page changes
   based on browser history events" (§2.4 assumption, verified not assumed).
3. Visit sendmo.co → GA4 Realtime shows the visit within ~1 min.
4. Navigate `/` → `/faq` → `/privacy` client-side → Realtime/DebugView shows 3
   `page_view` events with correct `page_path` values.
5. 👤 After the sibling SEO proposal's Search Console verification exists: GA4
   Admin → Product links → Search Console → link; queries surface within ~48 h.
6. Property settings show **no** Google-signals/advertising features active.

## 7. Open questions

- **OQ1 — RESOLVED (John, 2026-07-06): no Sentry; fold in the GA exception
  tripwire instead.** John weighed Sentry's free tier (~5k errors/mo, $0) and chose
  lean: no second vendor account, no 75 KB SDK. The §2.7 tripwire gives a crash
  counter + location at zero cost; server money-path alerts and CrashScreen are
  unchanged. Named escalation: an exception spike that can't be reproduced manually
  → revisit Sentry free tier (or GlitchTip self-hosted) behind the same inert
  pattern. Nothing is foreclosed.
- **OQ2 — RESOLVED (John, 2026-07-06): GA4 yes, PostHog no.** Rationale recorded in
  session: GA4's attribution history compounds from install day (deferring it costs
  history), while PostHog answers mostly "now" questions that beta-scale Supabase
  queries + the admin report already cover; the reserved single-sink `track()` shape
  keeps PostHog a cheap later add if funnel-optimization work ever demands it.
  Revisit triggers: traffic outgrows DB eyeballing, a deliberate funnel push, or
  person-level support debugging.
- **OQ3 — Production-only env var?** Recommended yes (§2.5). Alternative: a second
  "SendMo Dev" property for previews — more fidelity, more upkeep; not justified at
  launch scale.
- **OQ4 — Enhanced Measurement vs manual `page_view` events?** Recommended EM,
  verified in §6 step 4, manual listener as the named fallback.
- **OQ5 — keep the Do-Not-Track promise?** Recommended keep + implement (§2.3,
  ~3 LOC). Alternative is editing the published `/privacy` promise away, which is
  legal-adjacent copy John should not change casually.

## Reconciliation with prior decided proposals

**[2026-07-06_sentry-posthog-frontend-monitoring (decided 2026-07-06)](2026-07-06_sentry-posthog-frontend-monitoring_reviewed-2026-07-06_decided-2026-07-06.md)
— REVERSED by John the same day** (addendum appended to that file; LOG decision
entry + PRE-LAUNCH T1-3 update ride with this proposal's docs commit). This
proposal is the removal vehicle, and the reversal is framed precisely: the
**vendors** are out; the **decided patterns are kept** — the pure resolver +
env-gated ships-inert contract (T1-1 lineage), the idle-load
never-on-the-checkout-path posture (N5), the privacy-disclosure discipline (N3,
sentence rewritten not deleted), the env-var documentation convention (N4), and
the CrashScreen boundary (B2: "an improvement we want regardless of Sentry" —
survives on a plain React boundary). The T1-3 **server half** (admin-alert emails,
LOG 2026-07-04) is untouched. Sibling:
[2026-07-06_seo-crawl-hygiene-and-discovery.md](2026-07-06_seo-crawl-hygiene-and-discovery.md)
is unaffected by the reversal (no monitoring dependency) and supplies the Search
Console verification §6 step 5 links to — soft dependency. No external contract
(MCP or otherwise) is affected.

---

## Review

```yaml
reviewer: Claude (Fable 5) — fresh-eyes review session 2026-07-06; verified every file/line claim against origin/main (the local tree is on a mid-flight feature branch without the merged monitoring code) and the gtag.js/GA4 semantics from knowledge
reviewed_at: 2026-07-06
verdict: approve-with-changes
```

### Summary

The right proposal for John's decision: it removes the dead vendor layer honestly, preserves
exactly the pieces the reversed proposal's Decision addendum says survive (verified — the
reconciliation section represents the prior proposal faithfully, including B2's CrashScreen
reasoning and the N3/N5 lineage), and the file/line claims check out against origin/main
(`SentryRoutes` at App.tsx lines 32/66/116 — exact; all listed files exist with the claimed
content). Two problems need fixing before implementation: the §3 code sketch has **two silent
zero-data bugs** (array-push vs `arguments` object; dataLayer created after the error listeners
that depend on it), and the removal plan **misses two files that carry Sentry references**
(SPEC.md, LabelTest.tsx). Plus one honesty gap: GA4 does not show `exception` event
`description`s in reports without a custom-dimension registration step that §6 never gives John.

### Blocking issues

**B1 — The gtag sketch pushes plain arrays; gtag.js only processes `arguments` objects. As
written, GA receives nothing, silently.**
- *Location:* §3 sketch — `const gtag = (...args: unknown[]) => { window.dataLayer.push(args); }`
  and `trackException`'s `window.dataLayer?.push(["event", "exception", {…}])`.
- *Issue:* gtag.js identifies command entries in `dataLayer` by their being `arguments` objects
  (the official snippet is `function gtag(){dataLayer.push(arguments);}`). A rest-parameter
  arrow function pushes a real `Array`, which gtag.js ignores as a command — so the sketch's
  `config` never registers, no page_view ever fires, and every exception push is dropped. The
  parenthetical hedge ("implementation routes through the same `gtag()` closure so the
  arguments object shape matches") names the right requirement, but the closure it points at
  is itself array-shaped — an implementer following the sketch faithfully ships a GA
  integration that does nothing, with no error anywhere (Rule 20's "system claims success"
  shape, moved into analytics). §6 steps 3–4 would catch it — but only post-flip, days later,
  in prod.
- *Suggested fix:* make the sketch correct rather than hedged: `function gtag(){
  window.dataLayer.push(arguments); }` (a real `function`, pushing `arguments`), hoist it to
  module scope, and route `trackException` through it. Add a §4 unit case asserting the pushed
  entry is an `arguments` object (`typeof entry.length === "number" && !Array.isArray(entry)`),
  so the contract is pinned, not remembered.

**B2 — §2.7's "early errors aren't lost" claim is contradicted by the sketch's own ordering:
`window.dataLayer` is created inside `idle()`, but the error listeners register synchronously.**
- *Location:* §2.7 property (a) vs. §3 sketch (`window.dataLayer = window.dataLayer ?? []` is
  inside the `idle()` callback; `addEventListener("error", …)` runs immediately after it in
  `initMonitoring`, i.e. before the idle callback fires).
- *Issue:* an error thrown between init and the idle callback (precisely the "early errors"
  §2.7 claims to capture — and page-load-time crashes are the likeliest kind) hits
  `window.dataLayer?.push` while `dataLayer` is `undefined`; the optional chain silently
  no-ops and the event is gone. The justification John was given for the tripwire's
  reliability doesn't hold as sketched.
- *Suggested fix:* initialize `window.dataLayer = window.dataLayer ?? []` (and the queued
  `gtag("js")`/`gtag("config")` calls) synchronously at the top of the enabled branch; only
  the `<script>` injection belongs inside `idle()`. This is also the standard gtag pattern —
  queue immediately, load the processor lazily.

**B3 — The removal plan misses two files that carry Sentry/PostHog references: `SPEC.md` and
`src/pages/LabelTest.tsx`.**
- *Location:* §3 file list vs. `git grep -il -e sentry -e posthog origin/main` — hits not in
  the plan: **SPEC.md** (line 103 tech-stack row "Monitoring | Sentry (errors) + PostHog
  (analytics)", line 1028 "Sentry + PostHog integration") and **src/pages/LabelTest.tsx**
  (lines ~144–152: the "Throw test error (monitoring check)" button, whose comments cite
  Sentry capture and Sentry-quota burn as the gating rationale).
- *Issue:* stale-doc drift is a named failure class on this project (PRE-LAUNCH's "stale-doc
  cleanup" note exists because PLAYBOOK's stub labels misled agents for weeks; the 2026-07-04
  review had to correct them) — leaving SPEC.md saying "Sentry + PostHog" after this PR
  recreates it, and John's global rule 5 requires SPEC updates when architecture moves.
  LabelTest is subtler: the throw button should NOT be removed — it's the natural vehicle for
  §4's "thrown test error" browser-verify variants and the future tripwire check — but its
  comments must be retargeted (boundary + GA tripwire, not "Sentry capture") or the next agent
  inherits exactly the "why does this cite Sentry?" trap §1 warns about.
- *Suggested fix:* add both files to §3 — SPEC.md's two rows updated to match the new PLAYBOOK
  wording; LabelTest.tsx comment retarget (~3 LOC, keep the button and its DEV-or-admin gate).
  While there: the PLAYBOOK edit should enumerate all four Sentry/PostHog locations (line 24
  tech-stack row, lines 99–100 env-var block, lines 362–363 Vercel env list), not just the
  tech-stack row — the env sections are where the T1-3 vars are documented.

**B4 — GA4 won't show the exception `description` in any report until John registers it as a
custom dimension; §6 never has him do that, and §1's "crash counter with a location" oversells
what he'll see.**
- *Location:* §1 tripwire framing + §2.7 vs. §6 step 2 (John's 👤 GA setup).
- *Issue:* GA4 collects `exception` as an ordinary event: the *count* appears in the Events
  report and the page path comes along via standard page params, but the `description`
  parameter (which error — the entire diagnostic payload) is invisible in reports and
  explorations until it's registered as an event-scoped custom dimension (GA4 Admin → Custom
  definitions; ~48 h before data populates it). Without that step, a spike is a bare number:
  John can't distinguish extension noise from a failed Stripe Elements mount — which
  immediately trips the named escalation trigger ("a spike that can't be reproduced") and
  undermines the tradeoff he made when he picked the $0 tripwire over Sentry. This is
  decision-relevant, not cosmetic.
- *Suggested fix:* add to §6 step 2: register event-scoped custom dimensions for `description`
  (and optionally `fatal`), and to §6 step 4's DebugView check: confirm the description param
  arrives. Temper §1 to "a crash counter with a location, and — after a one-time custom-
  dimension registration — the error name."

### Non-blocking concerns

**N1 — The sketch's module state (`gaEnabled`, `exceptionCount`) is declared but never set/reset.**
`trackException` gates on `gaEnabled` which no sketched line assigns, and both variables are
module-level mutable state — vitest will leak them across test cases (the §4 truth-table +
cap tests need `vi.resetModules()` or an exported test-only reset, same discipline the current
`monitoring.test.ts` avoided by keeping the resolver pure). Name the mechanism in §3 so the
implementer doesn't improvise; better, derive `gaEnabled` from a module-scoped config set once
in `initMonitoring` and have tests import fresh modules.

**N2 — `navigator.doNotTrack` is deprecated and Safari doesn't send it at all** (removed in
Safari 12.1) — so the honored promise is best-effort: Chrome/Firefox users with DNT get the
gate; Safari users never can. That's still the right call versus deleting published privacy
copy (§2.3's reasoning holds), but (a) the /privacy sentence stays honest only as "we honor it
where the browser sends it," and (b) consider also honoring **Global Privacy Control**
(`navigator.globalPrivacyControl`, ~2 LOC in the same resolver input) — it's the signal with
actual legal weight (CCPA) and is what a 2026 privacy reviewer will ask about. Cheap now,
awkward later.

**N3 — The `window.addEventListener("error")` tripwire will ingest third-party noise.**
Cross-origin script errors arrive as bare `"Script error."` (no `e.error`), and a failed
gtag.js load can itself fire the error listener — the 10-cap absorbs runaways but a steady
drip of extension/third-party noise is exactly what the reversed proposal's N6 `ignoreErrors`
list existed to filter. Port a minimal filter (skip `"Script error."`, skip extension-scheme
filenames via `e.filename`) so the counter John watches measures SendMo, not the ecosystem.

**N4 — §2.4 calls Enhanced Measurement "property-level" — it's configured per web data
stream.** §6 step 2 already looks in the right place ("stream settings"), so this is only a
prose fix, but a future agent reading §2.4 alone would look in the wrong Admin screen.

**N5 — Idle-loading gtag skews the *first* page_view's attribution edge case:** if a user
lands and client-navigates before the script loads, the queued `config` page_view is processed
against the *current* URL, so the landing page can be misattributed. At launch traffic this is
noise; worth one line in §2.4's known-failure-modes so a future "why is / undercounted"
investigation doesn't start from zero.

### Nits

- `CrashScreen.test.tsx` currently imports `@sentry/react` (the boundary-degradation test) —
  §3's "retarget" covers it, but note it's a **tsc-breaking** import post-dep-removal, i.e. it
  must land in the same commit, not a follow-up.
- §3's `MonitoringEnv.doNotTrack` doc comment should note the `window.doNotTrack` legacy
  variant if N2's broader read is adopted.
- The Rule 19 variants block says "no exception event attempted" for the unset variant — good;
  add "listeners not registered" to make the assertion mechanically checkable in DevTools.
- `interface Window { dataLayer: unknown[] }` in `vite-env.d.ts` works (the file is ambient —
  verified no top-level imports at origin/main), but type it `unknown[] | undefined`-safe or
  the B2 fix's early assignment is the only thing keeping runtime and types honest.

### Execution-plan assessment (per John's ask)

**§3 (file-by-file):** concrete and mostly complete — every named file verified to exist at
origin/main with the claimed content, line refs exact, and the `__APP_RELEASE__`/`__APP_ENV__`
"Sentry-only consumers" claim grep-verified (monitoring.ts is the sole reader). Gaps an
implementer would hit: the two missed files (B3), the gtag mechanics they'd have to re-derive
from the hedge (B1/B2 — the sketch is the one part of §3 that cannot be followed as written),
and the unset `gaEnabled` state (N1). **§4 (tests):** right shape, Rule 19 block committed at
proposal time (the exact lesson from the prior review's B3 — good), but it doesn't say *how*
the "thrown test error" is produced in browser-verify — the LabelTest button is the intended
vehicle and should be named (it's also B3's retarget target). Module-state reset strategy
unstated (N1). **§6 (verification):** correctly sequenced (merge inert → John creates property
→ flip var → verify Realtime/DebugView → Search Console after the sibling proposal), correctly
splits 🤖/👤, and correctly defers the Search Console link as a soft dependency. Missing: the
custom-dimension registration (B4) and an explicit "exception event visible in DebugView with
description param" check. **Net:** with B1–B4 folded in, an implementer can execute without
improvising; today the code sketch is the weak link, not the plan structure.

### Predicted pitfalls (required)

1. **Weeks of silently empty analytics (Rule 20 class + the auth-email precedent).** The
   Production-only env var (OQ3, correct call) means the GA code path first *truly* runs in
   prod, post-flip. Combine with B1's array-push bug or a var typo'd in Vercel, and "analytics
   is installed" while the property collects nothing — no error, no alert, discovered only
   when someone opens GA expecting data. This project just lived the shape: the auth-email
   hook returned 500 on every OTP for **six weeks** (LOG/PRE-LAUNCH 2026-07-06) because the
   failure was invisible to the people not using that path. Mitigation: B1's pinned unit
   contract + treating §6 steps 3–4 as blocking, same-day, not "when John gets to it."
2. **Red `main` from `tsc`, not tests (Rule 18 / 2026-05-21 incident class).** This PR is the
   2026-05-21 shape *in reverse*: two deps removed, two ambient globals deleted, one `.d.ts`
   edited, and a test file (`CrashScreen.test.tsx`) that imports the removed `@sentry/react`.
   Vitest can pass while `tsc -b`/Vercel fails on a stale import or a leftover
   `__APP_RELEASE__` reference. §4 already names this — the addition is the test-file import
   (nit 1), which is the likeliest actual miss. Mitigation: `git grep -i sentry src tests`
   must return zero before push, plus Rule 18 + Rule 21 deploy-watch.
3. **The tripwire cries wolf and burns the decision, not the quota.** Without N3's noise
   filter and B4's description dimension, launch week produces a nonzero exception count from
   extensions/third-party scripts that John can't diagnose — which *is* the named escalation
   trigger ("a spike that can't be reproduced"), so the process would immediately demand the
   Sentry account the whole proposal exists to avoid, or worse, teach John to ignore the
   counter (alarm fatigue — the T2-3 lesson that public surfaces attract garbage applies to
   error listeners too). Mitigation: N3 filter + B4 dimension + a one-line §1 note on expected
   baseline noise.
4. **Vercel-dashboard config drift (2026-05-10/11 class).** `VITE_GA_MEASUREMENT_ID`
   Production-only is a dashboard setting invisible to the repo. Two drift paths: a future
   debugging session sets it on Preview "temporarily" and preview traffic pollutes the single
   property (no environment dimension to filter it out afterward — GA4 history is
   append-only); or the var silently vanishes in a project migration and pitfall 1 recurs with
   no code change to blame. Mitigation: the PLAYBOOK env-var entry (§3's edit) should state
   the scope **and the why** ("Production only — preview traffic pollutes the property"), the
   same documentation convention (N4 lineage) that got the Sentry vars scoped right.

### What the proposal got right

- **Every checkable claim checked out** against origin/main: App.tsx lines 32/66/116 exact;
  `vite-env.d.ts`, `monitoring.test.ts`, `CrashScreen.test.tsx`, Privacy.tsx's
  Sentry/PostHog + DNT sentences, `.env.example` vars, WISHLIST's source-map and
  funnel-events lines all present as described; "release/environment tagging existed only for
  Sentry" grep-verified. This is what makes the review cheap and the plan trustworthy.
- **The reconciliation section is honest.** Read against the reversed proposal in full
  (including its Decision addendum): the survives-list (plain CrashScreen boundary per B2,
  pure-resolver ships-inert pattern, N3 privacy discipline, N5 idle-load posture, untouched
  server half) matches what that addendum actually says, and the drift framing follows the
  protocol. No re-deciding of decided things.
- **"What honestly gets worse" is the best section in the file.** Naming the visibility
  regression, what the tripwire does NOT give (stacks, alerts, same-day data), and a concrete
  escalation trigger is exactly the lead-with-the-honest-win house style — John decided with
  the tradeoff in view, not buried.
- **Refusing the bespoke browser→server error endpoint** with the T2-3 spam/quota citation is
  the correct application of institutional memory — that endpoint is the tempting wrong move.
- **No new dependencies, no GTM, no consent theater** — Rule 6 discipline throughout; the GTM
  rejection ("an indirection layer for one tag") is exactly right.
- **Keeping the DNT promise implemented rather than quietly editing published privacy copy**
  (§2.3/OQ5) — right instinct on legal-adjacent text, and the ~3 LOC cost estimate is accurate.
- **Committing the Rule 19 Browser-verified block at proposal time** — the prior review had to
  demand this (its B3); this proposal internalized the lesson unprompted.

## Author response

*(author session, 2026-07-06 — same session as the draft; all four blockers and all
non-blocking concerns accepted; the implementation spec = §§1–7 as amended below)*

**B1 — array-push vs `arguments` object. ✅ Accept — this would have shipped a
silently-dead GA integration.** The sketch is corrected to the canonical form:
`function gtag(){ window.dataLayer.push(arguments); }` — a real `function`
declaration at module scope, with `trackException` routing through it. Adopting the
suggested §4 unit case verbatim: assert the pushed entry is an `arguments` object,
not an `Array`, so the contract is pinned in a test rather than remembered.

**B2 — dataLayer created after the listeners that depend on it. ✅ Accept.**
Corrected ordering in the enabled branch: `window.dataLayer = window.dataLayer ?? []`
plus the queued `gtag("js", …)` / `gtag("config", …)` run **synchronously**; only the
`<script>` injection stays inside `idle()`. That is the standard gtag pattern (queue
immediately, load the processor lazily) and it makes §2.7's "early errors aren't
lost" claim actually true. §4 gains a case: `trackException` before script load
lands the event in the queue.

**B3 — SPEC.md and LabelTest.tsx missed by the removal plan. ✅ Accept.** §3 gains:
SPEC.md's two Sentry/PostHog rows (line 103 tech-stack, line 1028 integration note)
updated to the GA4-only wording, satisfying global rule 5; LabelTest.tsx keeps the
throw-test-error button **and its DEV-or-admin gate** with comments retargeted
(boundary + GA tripwire, not Sentry capture) — and per the execution-plan
assessment, that button is now named in §4 as the vehicle for every "thrown test
error" browser-verify variant. The PLAYBOOK edit is widened to all four
Sentry/PostHog locations (tech-stack row, env-var block ~99–100, Vercel env list
~362–363), not just the tech-stack row.

**B4 — the exception `description` is invisible without a custom-dimension
registration. ✅ Accept — decision-relevant, as the reviewer says.** §6 step 2 gains
a 👤 sub-step: GA4 Admin → Custom definitions → create **event-scoped** dimensions
for `description` (and `fatal`), noting the ~48 h populate lag. §6 step 4 gains:
confirm the `description` param arrives in DebugView. §1's framing is tempered to
"a crash counter with a location, and — after a one-time custom-dimension
registration — the error name."

**N1 (unset `gaEnabled` / module state in tests) ✅** — `gaEnabled` becomes a
module-scoped config set exactly once in `initMonitoring`; §4 names
`vi.resetModules()` as the isolation mechanism for the truth-table + cap tests.
**N2 (DNT deprecated; Safari never sends it; GPC has the legal weight) ✅** — the
resolver input widens to `doNotTrack || globalPrivacyControl` (~2 LOC, reading
`navigator.globalPrivacyControl` and the `window.doNotTrack` legacy variant); the
/privacy sentence gets "where your browser sends such a signal" phrasing so the
promise stays exactly honest.
**N3 (error-listener noise) ✅** — minimal filter ported from the reversed
proposal's N6 discipline: skip bare cross-origin `"Script error."` events and
extension-scheme `e.filename`s; §1 gains one line setting John's expectation of
nonzero baseline noise.
**N4 (Enhanced Measurement is stream-level, not property-level) ✅** — §2.4 prose
corrected.
**N5 (idle-load first-page_view attribution edge) ✅** — noted in §2.4's known
failure modes. B2's fix also shrinks this window (config queues synchronously; only
script load is deferred).
**Nits: all four taken** — `CrashScreen.test.tsx`'s `@sentry/react` import is
flagged in §3 as a **same-commit, tsc-breaking** retarget; the legacy
`window.doNotTrack` variant is documented; the Rule 19 unset-variant wording gains
"listeners not registered"; `vite-env.d.ts` types `dataLayer` optional-safe.

**Predicted pitfalls — adopted as implementation checklist items:** pitfall 1 → §6
steps 3–4 are blocking and same-day (not "when John gets to it"); pitfall 2 →
`git grep -i -e sentry -e posthog src tests` must return zero hits before push, on
top of Rule 18; pitfall 3 → resolved by N3+B4 above; pitfall 4 → the PLAYBOOK
env-var entry documents the Production-only scope **with the why** ("preview
traffic pollutes the property — GA4 history is append-only").

No rejections, no unresolved points; nothing needs a Tradeoffs-for-John section.
OQ1/OQ2 were resolved by John in-session (see §7); OQ3–OQ5 stand as recommended and
were not contested by the review. Ready for John's decision.

## Decision

**Approved (approve-with-changes accepted in full) — John, 2026-07-06.** Review and
author response converged with zero unresolved points; OQ1 (no Sentry, GA exception
tripwire) and OQ2 (GA4 yes, PostHog no) were John's explicit in-session calls, and
OQ3–OQ5 close per the recommendations (Production-only var; Enhanced Measurement
with the manual fallback named; DNT/GPC promise kept and implemented). Spec =
sections 1–7 **as amended by the Author response** (B1 canonical `gtag` function +
pinned arguments-object test, B2 synchronous dataLayer queue, B3 SPEC.md +
LabelTest.tsx additions, B4 custom-dimension 👤 step, N1–N5 + nits). The 👤 half
(GA4 property, Vercel var, custom dimensions, Search Console link per §6) remains
John's; same-day verification of §6 steps 3–4 is blocking per the review's pitfall 1.
Nothing in the merge is irreversible (env var unset = fully inert; the removal half
restores nothing that was ever active).
