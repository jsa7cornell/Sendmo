---
title: GA4 acquisition analytics — extend the decided monitoring pattern
slug: ga4-acquisition-analytics
project: sendmo
status: in-review
created: 2026-07-06
last_updated: 2026-07-06
reviewed: null
decided: null
author: Claude session "SendMo — SEO + GA4 discovery research — 2026-07-06"
reviewer: null
outcome: null
---

# GA4 acquisition analytics — extend the decided monitoring pattern

## 1. Context

This morning's decided proposal
([2026-07-06_sentry-posthog-frontend-monitoring](2026-07-06_sentry-posthog-frontend-monitoring_reviewed-2026-07-06_decided-2026-07-06.md),
merged to main as `364462a`) gave SendMo **product** analytics: PostHog, deliberately
pageview-only, with explicit funnel events as a fast-follow. What SendMo still lacks
is **acquisition** analytics — the "where do visitors come from and which channel
converts" layer that launch marketing will immediately ask about.

**What GA4 specifically adds that PostHog doesn't:**

1. **The Search Console integration** — GA4 links to Search Console (being set up in
   the sibling SEO proposal) and puts *Google query → landing page → onboarding
   behavior* in one report. This is the feedback loop for the growth strategy's
   "own the prepaid-shipping-link category" bet, and no PostHog feature replaces it.
2. **Google's channel attribution** — default channel grouping (organic / direct /
   referral / social / paid) with cross-session attribution. PostHog captures
   referrers and UTMs on pageviews, but its acquisition reporting is what you build
   yourself; GA4's is the industry-standard one marketers and future collaborators
   already read.
3. **Google Ads readiness** — if the growth strategy's channel experiments include
   any paid search, GA4 key events are what Ads imports for conversion bidding.
   Retrofitting is possible but the attribution history is not: **analytics only
   counts from the day it's installed**, which is the main argument for landing this
   pre-launch rather than "when we need it."

**What honestly does NOT get better:** no new product insight (PostHog owns funnels
and the fast-follow events); ad-blockers will drop ~25–40% of GA traffic (same
accepted limitation already logged for PostHog/Sentry — directional data, not truth);
and **no money number in GA is ever authoritative** — the append-only `transactions`
ledger and admin report remain the only truth for revenue (Rule 16 culture; GA gets
no revenue values at all in this pass).

**The honest alternative** is to skip GA4 and live on Search Console + PostHog UTMs.
That's viable if SendMo never runs Google Ads and John never wants standard channel
reporting. The cost of adding it now is ~35 LOC inside an existing pattern plus one
👤 dashboard trip, so I recommend adding it — but this is a genuine judgment call and
is flagged as OQ1 rather than assumed.

**Scope discipline:** this lands at exact parity with the PostHog decision —
**pageviews only, nothing custom** — so the two tools stay comparable and the
funnel-events fast-follow instruments both through one helper (§5).

## 2. Architecture

Everything reuses the decided T1-3 machinery. One new env var, one new resolver
block, one new init branch:

```
BUILD TIME (Vercel)                RUN TIME (browser)
──────────────────                 ──────────────────
VITE_GA_MEASUREMENT_ID             src/main.tsx → initMonitoring()   src/lib/monitoring.ts
  (Vercel env var,                     │
   Production only — OQ2)              ├─ VITE_SENTRY_DSN?    … unchanged (decided T1-3)
        │                              ├─ VITE_POSTHOG_KEY?   … unchanged (decided T1-3)
        └─────────────────────────►    └─ VITE_GA_MEASUREMENT_ID set?
                                            no  → skip entirely (today's prod, dev, CI —
                                                  ships inert: no script, no network calls)
                                            yes → requestIdleCallback (same N5 idle path
                                                  PostHog uses — never on the checkout-
                                                  critical bundle):
                                                    inject gtag.js <script async>
                                                    gtag('config', id, {
                                                      allow_google_signals: false,
                                                      allow_ad_personalization_signals: false,
                                                    })
                                                  → initial page_view
                                                  → SPA route changes: GA4 Enhanced
                                                    Measurement history-change detection
                                                    (property-level, default ON — §6
                                                    verifies rather than assumes)
```

### Design decisions (each an invitation to push back)

1. **Gate on env-var presence — the T1-1/T1-3 ships-inert contract, verbatim.**
   Inert = no script tag injected, no network calls, zero data leaves the browser.
   With `VITE_GA_MEASUREMENT_ID` unset the new branch is dead code. There are no
   pre-flip visible changes at all this time (no bundle growth: gtag.js loads from
   Google's CDN only when enabled, and only after idle).
2. **PII/ads posture matching the decided PostHog stance:** `allow_google_signals:
   false` and `allow_ad_personalization_signals: false` at init — no demographics
   collection, no remarketing pools, until John deliberately flips them (that flip
   belongs with an actual Ads decision, not here). GA4 does not log or store IP
   addresses. No `user_id`, no custom events, no ecommerce/revenue values. The
   `/privacy` disclosure line that T1-3's review N3 added (Privacy.tsx:33 on main)
   gains "Google Analytics" in its tool list.
3. **SPA pageviews via Enhanced Measurement, not hand-rolled listeners.** GA4's
   history-change detection is the supported path for SPAs and needs zero code. The
   known failure mode is stale/racing `document.title` on route change — acceptable
   because paths, not titles, are what the reports key on. If DebugView shows broken
   attribution (§6 step 4), the fallback is a ~10-LOC manual `page_view` on router
   location change — named now so the implementer doesn't improvise.
4. **Production only (OQ2).** GA4 has no free environment dimension the way Sentry
   does; preview-deploy traffic would pollute the one property. Recommended Vercel
   scoping: Production, not Preview, not Development.
5. **US-only launch → no consent banner in this pass.** GA4 with ads signals off and
   no stored IPs is fine for a US audience without a consent layer. If EEA/UK
   marketing ever becomes real, **Consent Mode v2 becomes mandatory** — that lands as
   a WISHLIST line so the constraint isn't rediscovered the hard way.

## 3. File-by-file plan

**Edit: `src/lib/monitoring.ts`** (~35 LOC) — extend the existing decided pattern:
```ts
export interface MonitoringConfig {
  sentry: { … };                                            // unchanged
  posthog: { … };                                           // unchanged
  ga: { enabled: boolean; measurementId: string };          // NEW
}
export interface MonitoringEnv {
  …;
  gaMeasurementId?: string;                                 // NEW
}
// resolver: ga: { enabled: !!env.gaMeasurementId, measurementId: env.gaMeasurementId ?? "" }
```
In `initMonitoring()`, a third branch inside the **same** `idle()` helper PostHog
uses:
```ts
if (cfg.ga.enabled) {
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
(`dataLayer` works even if the script later fails to load — analytics stays
best-effort, same posture as the PostHog `.catch`.)

**Edit: `src/vite-env.d.ts`** (+2 LOC) — `interface Window { dataLayer: unknown[] }`
(the file exists on main since T1-3; this is an Edit, not a New — learned from that
review's N1).

**Edit: `tests/unit/monitoring.test.ts`** — extend the existing truth table:
`{gaMeasurementId set/unset}` → `ga.enabled`, id fallback to `""`. This pins the
ships-inert contract for the new branch the same way it's pinned for the other two.

**Edit: `src/pages/Privacy.tsx`** (+~1 LOC) — add Google Analytics to the existing
third-party tools sentence (line 33).

**Edit: `.env.example` + PLAYBOOK env sections** — `VITE_GA_MEASUREMENT_ID=`
documented alongside the two T1-3 vars (that review's N4 precedent).

**Edit: `WISHLIST.md`** — two lines: "Consent Mode v2 before any EEA/UK marketing"
and cross-link to the funnel-events fast-follow (§5).

**No new dependencies. No edge-function changes. No schema changes. No changes to
main.tsx, App.tsx, or any payment path.**

## 4. Test plan

- **`tests/unit/monitoring.test.ts`** — truth-table extension (§3). No DOM-level
  unit test of the script injection: it's four lines of DOM API inside the
  already-idle-gated branch, and jsdom can't meaningfully verify gtag; the browser
  pass covers it.
- Full suite + `npx tsc -b --noEmit` green before push (Rule 18).
- **Rule 19 Browser-verified block** (committed now):
  ```
  Browser-verified:
    mcp-session: <dev-server pass>
    variants-covered: [
      {VITE_GA_MEASUREMENT_ID unset → app boots, zero requests to googletagmanager.com
        or google-analytics.com in the network tab},
      {var set (local test id) → gtag.js loads after idle, /g/collect page_view fires
        on load AND on a client-side route change},
      {prod property + Search Console link + channel data → deferred to §6 steps 2–5,
        post-flip (T1-1 §5-step-4 pattern)}
    ]
  ```

## 5. Out of scope (explicit non-goals)

- **Custom events / funnels / key events.** The decided funnel-events fast-follow
  (T1-3 proposal §5) instruments *both* sinks when it lands — through one helper so
  the two tools can never drift:
  ```ts
  // future shape, reserved here so the fast-follow converges — NOT built now:
  export function track(event: string, props?: Record<string, unknown>): void
  // → posthog.capture(event, props) + gtag('event', event, props), each behind its enabled flag
  ```
  Marking `link_created` / `label_purchased` as GA4 key events is a 👤 UI step in
  that fast-follow, not code here.
- **Google Ads linkage, remarketing, demographics** — deliberately off (§2.2) until
  an Ads decision exists.
- **Consent banner / Consent Mode v2** — not needed US-only; WISHLIST-gated for EEA.
- **Revenue/ecommerce values in GA** — never in this pass; the ledger is truth.
- **Google Tag Manager** — a whole indirection layer for one tag is Rule 6 bait.

## 6. Verification (end-to-end, after John's 👤 steps)

1. Merge (inert) → CI green → deploy green (Rule 21) → confirm prod makes **no**
   requests to `googletagmanager.com` / `google-analytics.com` (var unset).
2. 👤 **John (~10 min):** GA4 → create property "SendMo" (US timezone) → Web data
   stream for `https://sendmo.co` → copy the `G-XXXXXXXXXX` measurement ID → set
   `VITE_GA_MEASUREMENT_ID` in Vercel (**Production only**, per OQ2) → redeploy.
   While in the stream settings: confirm Enhanced Measurement is ON and its
   "Page changes based on browser history events" toggle is enabled (§2.3 assumption,
   verified not assumed — the T1-3 review's N2 lesson).
3. Visit sendmo.co → GA4 Realtime shows the visit within ~1 min.
4. Navigate `/` → `/faq` → `/privacy` client-side → DebugView/Realtime shows 3
   `page_view` events with correct `page_path` values.
5. 👤 After the SEO proposal's Search Console verification exists: GA4 Admin →
   Product links → Search Console → link. Queries surface in Reports within ~48 h.
6. Confirm **no** Google-signals/advertising features show as active in property
   settings.

## 7. Open questions

- **OQ1 — add GA4 now, or defer until an actual ads/marketing push?** Recommended:
  now — attribution history only accrues from install day, launch is the moment
  acquisition data starts mattering, and the marginal code is ~35 LOC inside an
  existing decided pattern. But "PostHog + Search Console is enough until we buy
  ads" is a defensible position; if John holds it, this proposal parks as `blocked`
  rather than dying, and the SEO proposal proceeds independently.
- **OQ2 — Production-only env var, or Production + Preview?** Recommended
  Production-only (§2.4: one property, no env dimension, preview pollution). The
  alternative is a second "SendMo Dev" property for Preview — more fidelity, one
  more thing to maintain; I don't think launch-scale traffic justifies it.
- **OQ3 — Enhanced Measurement vs manual `page_view` events?** Recommended: Enhanced
  Measurement, verified in §6 step 4, with the manual listener as the named fallback.
  Pushback welcome if the reviewer has seen GA4 EM misattribute React Router 7
  specifically.
- **OQ4 — should the PostHog `capture_pageview: 'history_change'` and GA EM ever
  disagree,** which is truth? Proposal: neither — they're both directional;
  discrepancies under ~15% are expected (different blockers block differently) and
  not worth chasing. Stating this now avoids a future debugging rabbit hole.

## Reconciliation with prior decided proposals

Built directly on
[2026-07-06_sentry-posthog-frontend-monitoring (decided 2026-07-06)](2026-07-06_sentry-posthog-frontend-monitoring_reviewed-2026-07-06_decided-2026-07-06.md)
— verified against `src/lib/monitoring.ts` at origin/main `364462a`. This proposal
**adopts** its decided postures rather than re-deciding: ships-inert env gating
(T1-1 pattern), the B4 "truly pageview-only" scope, the N5 off-critical-path idle
loading, the N3 privacy-disclosure line (extended, not duplicated), and the N4
env-var documentation convention. The pure-resolver truth-table pattern
(`resolveMonitoringConfig`, mode.ts lineage) is extended in place — no new construct
(Rule 6). The funnel-events fast-follow that proposal reserved is honored: §5 keeps
this at pageview parity and reserves the single `track()` fan-out shape for that
follow-up. Sibling dependency:
[2026-07-06_seo-crawl-hygiene-and-discovery.md](2026-07-06_seo-crawl-hygiene-and-discovery.md)
supplies the Search Console verification that §6 step 5 links to — soft dependency
(GA works without it; the query reports don't). No external contract (MCP or
otherwise) is affected.
