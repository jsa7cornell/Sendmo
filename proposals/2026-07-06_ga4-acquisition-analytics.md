---
title: GA4 as the only analytics tool + removal of the inert Sentry/PostHog layer
slug: ga4-acquisition-analytics
project: sendmo
status: in-review
created: 2026-07-06
last_updated: 2026-07-06 (rewritten same day — John reversed the Sentry/PostHog decision; v1 of this proposal assumed PostHog existed)
reviewed: null
decided: null
author: Claude session "SendMo — SEO + GA4 discovery research — 2026-07-06"
reviewer: null
outcome: null
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

**What honestly gets worse, and is NOT replaced here:** frontend error visibility.
Dropping Sentry re-opens the gap the T1-3 frontend half existed to close — if a
customer's browser throws (render crash, failed Stripe Elements mount), nobody finds
out unless they email support. GA4 is **not** an error monitor: it has an
`exception` event type but no stack traces, no grouping, no alerting — it is not a
substitute and this proposal doesn't pretend otherwise. The mitigations that remain:
CrashScreen keeps crashed users off white pages and shows a support mailto (a weak
but real signal channel), and server-side money-path failures still email John.
Whether to accept this gap for launch is the top question for John — **OQ1** — with
the realistic later options listed there. This proposal recommends accepting it for
now rather than building a bespoke error-reporting endpoint (a public
browser→server report path is exactly the unauthenticated-endpoint spam/quota class
T2-3 exists for).

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
                                       ▼
                                   <ErrorBoundary fallback={<CrashScreen/>}>   ← NEW plain
                                     <App/>          boundary replaces Sentry.ErrorBoundary;
                                   </ErrorBoundary>  CrashScreen behavior identical
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
}
```
All Sentry/PostHog imports, config, `IGNORE_ERRORS`/`DENY_URLS`, and the
`__APP_RELEASE__`/`__APP_ENV__` reads go (release/environment tagging existed only
for Sentry).

**New: `src/components/ErrorBoundary.tsx`** (~20 LOC) — plain class boundary
(`componentDidCatch` → render `fallback`), replacing `Sentry.ErrorBoundary` in
main.tsx. `CrashScreen.tsx` itself is unchanged except its header comment (which
currently says errors go to Sentry — after this, they go nowhere; the comment must
say so honestly).

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
  ships-inert contract and the DNT gate.
- **`tests/unit/CrashScreen.test.tsx`** — throwing child → CrashScreen renders via
  the new plain boundary (proves the removal didn't regress the B2 improvement).
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
        or google-analytics.com; thrown test error → CrashScreen renders (plain boundary)},
      {var set (local test id) → gtag.js loads after idle; /g/collect page_view fires on
        load AND on a client-side route change},
      {var set + browser DNT enabled → no gtag script, no GA network calls},
      {prod property + Search Console link → deferred to §6 steps 2–5, post-flip}
    ]
  ```

## 5. Out of scope (explicit non-goals)

- **Any frontend error-monitoring replacement** — accepted gap per OQ1; options
  recorded there for a later, separate decision. No bespoke browser→server error
  endpoint (T2-3 spam/quota class).
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

- **OQ1 — accept the frontend-error blind spot for launch?** Dropping Sentry means
  browser-side crashes are invisible again (server money-path alerts unaffected;
  CrashScreen + support mailto remain). Recommended: **accept for now** — closed-beta
  traffic is small, and every alternative is either a vendor account (the thing
  being reversed) or new public attack surface. If it bites, the later options in
  rough order of cost: (a) GlitchTip or another self-hosted/Sentry-compatible
  backend behind the same inert pattern; (b) a tiny authed error-report edge
  function reusing `sendAdminAlert` with T2-3-style rate limiting; (c) revisit
  Sentry. Nothing is foreclosed — the boundary and CrashScreen stay regardless.
- **OQ2 — GA4 at all, or nothing?** Sharper than v1 now that PostHog is gone: with
  no GA4, SendMo launches with **zero** analytics — no pageview counts, no channel
  data, no way to see whether the growth strategy's channels do anything.
  Recommended: yes, and pre-launch, since attribution history only accrues from
  install day. If John also declines GA4, the removal half of this proposal should
  proceed alone (the dead Sentry/PostHog layer shouldn't sit in the bundle either
  way) — that split is trivial: skip the §3 monitoring.ts GA branch and ship the rest.
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
