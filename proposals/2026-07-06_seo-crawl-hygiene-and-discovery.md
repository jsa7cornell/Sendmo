---
title: SEO crawl hygiene + per-route meta — make sendmo.co discoverable
slug: seo-crawl-hygiene-and-discovery
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

# SEO crawl hygiene + per-route meta — make sendmo.co discoverable

## 1. Context

SendMo is days from opening live payments to strangers (T1-1 is live in closed beta),
and the growth strategy is built on owning a search category — the **"prepaid shipping
link"** (SendMo_Growth_Strategy_v2 §3.1). But the site has **zero crawl
infrastructure** today:

- **No `robots.txt`, no `sitemap.xml`, no canonical URL, no structured data.**
  A request for `https://sendmo.co/robots.txt` currently returns `index.html` (the
  SPA catch-all rewrite in [vercel.json](../vercel.json) swallows it) — Google gets
  HTML where it expects a text file.
- **Every route serves the identical title and description.** The SPA serves one
  static `index.html` for `/`, `/faq`, `/dashboard`, `/admin` — Google sees
  "SendMo — Prepaid Shipping Made Easy" on all of them, and nothing distinguishes
  the four public marketing pages from the ~10 private app/admin routes.
- **Share links are indexable.** `/s/:shortCode` pages are the viral surface — they
  get pasted into Facebook comments, Reddit threads, and group chats by design
  ("every link sent is a distribution event", growth strategy §Executive Summary).
  Nothing stops Google from indexing thousands of them: personalised, semi-private,
  duplicate-content pages that would dilute the domain and leak recipient
  first-name/city strings into search results.
- **The FAQ page is a 7-line stub** ([src/pages/FAQ.tsx](../src/pages/FAQ.tsx) —
  literally `<h1>FAQ</h1>`). It's linked from the app but has no content, which is
  both a UX gap and the cheapest content-SEO surface we're not using.

**What honestly gets better:** Google can crawl and correctly index the four public
pages with distinct titles/descriptions/canonicals; private and share-link pages are
kept out of the index the correct way; the FAQ becomes a real page targeting the
growth strategy's actual queries, with FAQPage structured data; and John gets Search
Console query data (the single most valuable free SEO instrument). **What does NOT
get better:** rankings and traffic — this is plumbing plus one content page, not a
content-marketing program (use-case landing pages are explicitly out of scope, §5).
For a 4-page site there is no crawl-budget problem being solved; the real wins are
correct titles in results, the share-link privacy/index fix, and the Search Console
feedback loop.

**One rider:** [api/s/[shortCode].ts](../api/s/[shortCode].ts) is dead code — its
`/s/:shortCode → /api/s/:shortCode` rewrite was dropped from vercel.json when
[middleware.ts](../middleware.ts) superseded it (commits `7db5109` → `9db0768`; the
middleware header comment explains why: the CDN cached the catch-all before the
function could run). This proposal deletes it while we're in these files.

## 2. Architecture

The public surface is exactly four URLs. Everything else must carry an explicit
"stay out of the index" signal. The flow, per crawler:

```
Googlebot
  ├─ /robots.txt          → NEW static file (public/)  — allow all, Disallow /admin + /api,
  │                          Sitemap: pointer
  ├─ /sitemap.xml         → NEW static file (public/)  — the 4 public URLs
  ├─ / /faq /privacy /terms
  │        → static index.html (unchanged fallback meta)
  │        → Googlebot renders JS → usePageMeta() sets per-route
  │          <title> / <meta description> / <link canonical>
  ├─ /dashboard /admin /login /onboarding/* /links/* /label-test /t/* ...
  │        → SPA catch-all, PLUS  X-Robots-Tag: noindex  header (vercel.json)
  └─ /s/:shortCode
           → middleware.ts response, PLUS <meta name="robots" content="noindex">
             in the injected tag block + X-Robots-Tag header on the response

Social crawlers (iMessage/Slack/FB — no JS)
  ├─ /            → static OG tags in index.html (unchanged)
  └─ /s/:code     → middleware-injected personalised OG tags (unchanged) — they
                    ignore robots meta, so link previews keep working
```

### Index policy — the one decision that needs care

| Route class | Policy | Mechanism | Why |
|---|---|---|---|
| `/`, `/faq`, `/privacy`, `/terms` | **index** | sitemap + per-route canonical | the marketing surface |
| `/s/:shortCode`, `/t/:code`, `/track/*` | **noindex, crawl allowed** | robots meta (middleware) + `X-Robots-Tag` | these get externally linked at scale; `Disallow` would leave "indexed without content" URL stubs in results (Google can't see a noindex it isn't allowed to crawl). Noindex requires crawlability. |
| `/dashboard`, `/login`, `/onboarding/*`, `/links/*`, `/label-test`, `/*-preview` | **noindex** | `X-Robots-Tag` header | private app chrome; near-zero external links, but the header is free |
| `/admin/*`, `/api/*` | **Disallow** in robots.txt (+ header) | robots.txt | pure crawl waste; we actively don't want bots probing these |

### Per-route meta: a small hook, not react-helmet and not React-19 native tags

Design decision (invitation to push back — OQ1): a ~40-LOC `usePageMeta` hook that
mutates `document.title` and upserts the description/canonical tags on route mount.

- **Why not react-helmet:** a dependency for what is four pages of head tags (Rule 6).
- **Why not React 19's native `<title>`/`<meta>` hoisting** (we're on React 19.2, it
  exists): the static tags in [index.html](../index.html) must stay — they're what
  social crawlers (no JS) and the middleware injection path see. React-rendered
  metadata *adds* tags; it doesn't replace the static ones, so every page would carry
  two titles/two descriptions and we'd be trusting crawlers to pick the right one.
  Mutating the existing tags has exactly one of each, deterministically.
- The only crawler that executes JS is Google (and Bing), and both read the
  post-render DOM — which is precisely what the hook shapes. Social crawlers never
  needed per-route meta on public pages (they only share `/` and `/s/*`, both already
  covered statically).

### Structured data

- **`Organization` + `WebSite` JSON-LD** — one static `<script type="application/ld+json">`
  block in index.html. Static because it's site-wide and JSON-LD duplicated across
  routes is harmless.
- **`FAQPage` JSON-LD** — rendered in FAQ.tsx from the same `FAQS` array that renders
  the visible Q&As (single source, can't drift). Eligible for FAQ rich results.

## 3. File-by-file plan

**New: `public/robots.txt`**
```
User-agent: *
Disallow: /admin
Disallow: /api
Sitemap: https://sendmo.co/sitemap.xml
```
(Everything else stays crawlable so the noindex signals are visible — see §2 table.)

**New: `public/sitemap.xml`** — static, four `<url>` entries (`/`, `/faq`,
`/privacy`, `/terms`), no `lastmod` (we won't maintain it honestly; omitting is
better than lying). Static files in `public/` are served by Vercel before the
catch-all rewrite, so no vercel.json change is needed for these two.

**Edit: `vercel.json`** — add `X-Robots-Tag: noindex` headers entries for:
`/dashboard(.*)`, `/login`, `/onboarding(.*)`, `/links/(.*)`, `/label-test`,
`/sender-preview`, `/header-preview`, `/link-share-preview`, `/t/(.*)`,
`/track/(.*)`, `/s/(.*)`, `/admin(.*)`, `/api/(.*)`. Headers match on the incoming
request path before rewrites, so they apply to SPA routes. Caveat: a response
produced by Edge Middleware may bypass these headers — which is why `/s/` also gets
the signal inside middleware.ts (belt and braces).

**Edit: `middleware.ts`** (~4 LOC) — add `<meta name="robots" content="noindex" />`
to the injected tag block in `injectOgTags()`, and `"X-Robots-Tag": "noindex"` to the
response headers. Social crawlers ignore robots meta, so personalised link previews
are unaffected.

**New: `src/hooks/usePageMeta.ts`** (~40 LOC)
```ts
export interface PageMeta {
  title: string;
  description?: string;   // upserts <meta name="description">
  canonicalPath?: string; // upserts <link rel="canonical" href="https://sendmo.co{path}">
}
export function usePageMeta(meta: PageMeta): void { /* useEffect: document.title = …; upsert tags */ }
```
Pure DOM upsert helpers (`upsertMeta`, `upsertLink`) exported for unit testing.
No cleanup-on-unmount: every routed page calls the hook, so the next page always
overwrites (and a stale title for a tick is harmless).

**Edit: public pages** — `Index.tsx`, `FAQ.tsx`, `Privacy.tsx`, `Terms.tsx` each get
a `usePageMeta` call with title + description + canonicalPath. Proposed titles
(OQ2 — John's brand call, especially the landing one):
- `/` — `SendMo — Prepaid Shipping Links. They Ship, You Pay.` (works the category
  term from growth strategy §3.1 into the title)
- `/faq` — `FAQ — How Prepaid Shipping Links Work | SendMo`
- `/privacy` — `Privacy Policy | SendMo` · `/terms` — `Terms of Service | SendMo`

**Edit: app pages** (Dashboard, Login, onboarding layout, links manager, tracking
page) — title-only `usePageMeta` calls (`Dashboard | SendMo`, etc.). Not an SEO need
(they're noindexed); it's the tab-title UX fix that rides along for ~1 LOC per page.

**Edit: `index.html`** — add the `Organization` + `WebSite` JSON-LD block. Existing
static tags unchanged.

**Rewrite: `src/pages/FAQ.tsx`** (~150 LOC) — a real FAQ from a `FAQS: {q, a}[]`
array, rendered as accessible disclosure sections styled with existing design tokens
(`bg-card rounded-2xl border border-border shadow-sm` — no new UI pattern), plus the
`FAQPage` JSON-LD script rendered from the same array. Draft content (~11 Q&As,
final copy is OQ3; answers must be re-verified against SPEC.md product behavior at
implementation time):

1. *What is a prepaid shipping link?* — the category definition, "like Venmo for shipping costs"
2. *How does SendMo work?* — create link → share → they enter package details and print → you pay
3. *Who pays for shipping?* — the person who created the link (recipient); the sender pays nothing
4. *Does the sender need an account?* — no; click, fill, print
5. *What does it cost?* — real USPS/UPS rates plus a small service fee, shown before payment (qualitative — no hardcoded numbers to go stale)
6. *Which carriers do you support?* — USPS and UPS, live rates
7. *When is my card charged?* — full label: at purchase; flexible link: hold now, final amount captured at actual cost
8. *Can I cancel a label and get a refund?* — yes, before shipping, from the tracking page; refund lands after the carrier confirms the void
9. *Is my address private?* — not shared during the back-and-forth; it appears only on the printed label
10. *Is SendMo safe to use with strangers?* — payments via Stripe, card numbers never touch SendMo
11. *Where does SendMo help most?* — marketplace deals (Facebook Marketplace, eBay, Mercari, Poshmark off-platform, Reddit swaps), gifts, offices

**Delete: `api/s/[shortCode].ts`** — dead code rider (see §1).

**No edge-function changes. No schema changes. No changes to any payment path.**

## 4. Test plan

- **`tests/unit/usePageMeta.test.ts`** — jsdom: title set; description/canonical
  upserted (created when absent, replaced not duplicated when present); second page's
  call overwrites the first's.
- **`tests/unit/faq.test.tsx`** — FAQ renders every `FAQS` entry; JSON-LD script
  parses as valid JSON and its question count equals `FAQS.length`.
- Full suite + `npx tsc -b --noEmit` green before push (Rule 18).
- **Rule 19 Browser-verified block** (committed now, lands in the LOG entry):
  ```
  Browser-verified:
    mcp-session: <dev-server pass>
    variants-covered: [
      {/ → title "SendMo — Prepaid Shipping Links…", canonical https://sendmo.co/},
      {/faq → FAQ content renders, distinct title, FAQPage JSON-LD present in DOM},
      {/dashboard → tab title updates; noindex header deferred to post-deploy §6
        (headers are a Vercel-layer behavior, not reproducible on the Vite dev server)},
      {/s/<code> via vercel dev or preview deploy → response HTML contains both the
        personalised OG tags AND the robots-noindex meta}
    ]
  ```

## 5. Out of scope (explicit non-goals)

- **Use-case landing pages** (`/for/facebook-marketplace`, `/for/poshmark`,
  `/for/reddit-swaps` — the growth strategy's long-tail play) and any blog/content
  program. That's a content effort with its own proposal when John wants it; this
  proposal builds the plumbing those pages will inherit.
- **Prerendering / SSR / framework migration.** Stack is non-negotiable (PLAYBOOK);
  Google renders client-side React fine at this site size. Revisit only if Search
  Console shows the four public pages failing to index (§6 step 5 checks exactly this).
- **OG image / favicon redesign** — tracked as PRE-LAUNCH T3-3, not re-decided here.
- **Google Analytics** — sibling proposal
  [2026-07-06_ga4-acquisition-analytics.md](2026-07-06_ga4-acquisition-analytics.md).
- **Bing beyond registration** (John may add Bing Webmaster Tools in §6; imports from
  Search Console in one click).

## 6. Verification (end-to-end, after deploy)

1. Merge → CI green → Vercel deploy green (Rule 21).
2. `curl -s https://sendmo.co/robots.txt` → text file, not HTML. Same for
   `/sitemap.xml`.
3. `curl -sI https://sendmo.co/dashboard | grep -i x-robots-tag` → `noindex`. Repeat
   for `/admin`, `/t/x`. `curl -s https://sendmo.co/s/<real-code> | grep -i robots` →
   noindex meta present AND personalised OG title still present.
4. Paste a real `/s/` link into iMessage/Slack → personalised preview unchanged.
5. 👤 **John — Search Console runbook (~15 min):** add property for `sendmo.co`
   (Domain property, DNS TXT verification at the registrar) → submit
   `https://sendmo.co/sitemap.xml` → URL-inspect `/` and `/faq`, request indexing →
   over the following week, confirm all four public pages report "Indexed" and no
   private URL appears under "Indexed, though blocked" / "Duplicate" warnings.
6. Rich-results test (search.google.com/test/rich-results) on `/faq` → FAQPage
   detected.

## 7. Open questions

- **OQ1 — hook vs React-19 native metadata?** Proposed: the mutation hook (§2
  reasoning: the static fallback tags must stay for no-JS crawlers, and native tags
  would duplicate them). If the reviewer knows React 19's hoisting to reliably
  dedupe against server-served static tags, native is fewer lines — but I couldn't
  convince myself it does.
- **OQ2 — the landing title.** `SendMo — Prepaid Shipping Links. They Ship, You Pay.`
  plants the category keyword but changes the public brand line from "Prepaid
  Shipping Made Easy". John's call; the plumbing is identical either way.
- **OQ3 — FAQ copy sign-off.** Draft in §3 is written from the growth strategy +
  SPEC; John should red-pen it at decision time (it's public product voice, and a
  couple of answers state refund/hold behavior that must match what actually ships).
- **OQ4 — noindex `/t/` tracking pages?** Proposed yes (semi-private shipment state,
  addressed to two parties). Counterargument: they're the shareable "where's my
  package" surface and harmless if indexed. I lean yes — they're per-shipment
  ephemera with zero search value and recipient city/name strings.

## Reconciliation with prior decided proposals

Scanned `proposals/` 2026-07-06. No prior proposal covers SEO/crawl surface — this is
greenfield, not drift. Adjacent work honored: the `/s/` OG middleware (commits
`7db5109`/`7aaec91`, predates the protocol's reach into that code) is **extended, not
redesigned** — the personalised-preview behavior it exists for is explicitly preserved
(§6 step 4); [2026-07-06_sentry-posthog-frontend-monitoring](2026-07-06_sentry-posthog-frontend-monitoring_reviewed-2026-07-06_decided-2026-07-06.md)
touches `main.tsx`/`monitoring.ts`, which this proposal doesn't touch (no file
overlap); PRE-LAUNCH **T3-3** (public-facing polish: logo, icons, OG image) is cited
as the home of the OG-image work, not duplicated here. The sibling GA4 proposal
depends on §6 step 5 (Search Console verification) for its Search-Console-link step
and says so.
