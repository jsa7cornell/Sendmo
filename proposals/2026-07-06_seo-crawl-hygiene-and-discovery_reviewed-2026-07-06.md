---
title: SEO crawl hygiene + per-route meta — make sendmo.co discoverable
slug: seo-crawl-hygiene-and-discovery
project: sendmo
status: revised
created: 2026-07-06
last_updated: 2026-07-06 (Author response appended — B1–B4 + N1–N6 + nits all accepted, zero unresolved; awaiting John's decision, incl. the OQ2/OQ3 brand calls)
reviewed: 2026-07-06
decided: null
author: Claude session "SendMo — SEO + GA4 discovery research — 2026-07-06"
reviewer: Claude (Fable 5) — fresh-eyes review session 2026-07-06; verified every file/commit claim against origin/main and fact-checked the FAQ draft against SPEC/PLAYBOOK/shipped code
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
overlap) — and its same-day **reversal by John** (see that file's Decision addendum)
changes nothing here, since this proposal never depended on any monitoring tool;
PRE-LAUNCH **T3-3** (public-facing polish: logo, icons, OG image) is cited
as the home of the OG-image work, not duplicated here. The sibling GA4 proposal
depends on §6 step 5 (Search Console verification) for its Search-Console-link step
and says so.

## Review

```
reviewer: Claude (Fable 5) — fresh-eyes session 2026-07-06; verified every code/commit
          claim against origin/main; fact-checked §3 FAQ draft against SPEC.md,
          PLAYBOOK.md, PAYMENTS-adjacent LOG entries, and shipped code
reviewed_at: 2026-07-06
verdict: approve-with-changes
```

### Summary

The plumbing is right: every crawl-infrastructure claim I checked against origin/main
holds (robots.txt swallowed by the catch-all, headers-before-rewrites, `public/`
served before rewrites, the middleware-bypass caveat, the dead-code history of
`api/s/[shortCode].ts`), the noindex-vs-Disallow reasoning in the §2 table is
correct, and OQ1's React-19 analysis is right. What's not right is the **FAQ draft
copy**: three of the eleven answers misstate payment/carrier behavior on a payments
product days from opening to strangers — and one of them is wrong *because* the
proposal's own instruction ("re-verify against SPEC.md") points at a SPEC section
that is itself stale. Fix the copy and the verification pointer and this ships.

### Blocking issues

**B1 — §3 FAQ Q7: the flexible-link "hold" description contradicts shipped Pattern D.**
- **Location:** §3, FAQ draft Q7 ("flexible link: hold now, final amount captured at actual cost").
- **Issue:** There is no hold. SPEC §13 "Flexible Link Flow (Pattern D — Phase F, decided 2026-05-18)" is explicit: card saved via SetupIntent, "**No persistent hold is created**," then a *fresh off-session PaymentIntent* is created and auto-captured when the sender buys the label. The draft describes the pre-Pattern-D architecture that PLAYBOOK's intro paragraph still (stale-ly) carries ("Stripe hold released after actual shipping cost captured") — the author appears to have cribbed from the stale doc. "Captured at actual cost" is also wrong on the amount: the customer is charged the server-derived display price (rate × margin, capped at `max_price_cents`), not the carrier's actual cost. Telling a customer their card has a "hold" when it's actually saved-and-charged-later is materially wrong consent language on a money product.
- **Suggested fix:** Rewrite to the Pattern D truth, e.g. *"Flexible link: your card is securely saved when you create the link (no charge, no hold); it's charged only when your sender actually buys a label, and never more than the price cap you set."* Also ride a one-line PLAYBOOK fix for the stale "Stripe hold" sentences (intro + Payment Flows) so the next agent doesn't repeat this.

**B2 — §3 FAQ Q8 + the re-verification instruction: SPEC §13.1 is stale and would "correct" true copy into false copy.**
- **Location:** §3, Q8, and the instruction "answers must be re-verified against SPEC.md product behavior at implementation time."
- **Issue:** Q8 as drafted (cancel from the tracking page, refund after carrier confirms the void) actually matches **shipped** behavior — user-facing cancel via cancel-token exists on `/t/` (`TrackingPage.tsx` + `CancelLabelDialog`, live cancel→refund verified 2026-07-05 per LOG/PRE-LAUNCH T2-2a), and the refund goes to the **original card via Stripe** (H3/H5). But SPEC §13.1 still says refunds are "credited to SendMo account balance (not original payment method in Phase 1)" and that user-facing void is "Post-MVP." An implementer who obeys the proposal's verification instruction would rewrite Q8 to the stale SPEC and ship *wrong* public copy about where refund money lands. This is the trap the instruction was meant to prevent, inverted.
- **Suggested fix:** (a) Change the verification pointer to "verify against PAYMENTS.md + the shipped edge functions + the 2026-07-05/06 LOG cancel→refund entries; where SPEC §13.1 disagrees, SPEC is stale." (b) File the SPEC §13.1 reconciliation as its own small drift fix (per protocol: *restoring the decided refund-system spec*, cite 2026-05-21_refund-system-implementation), either riding this PR or preceding it. (c) In Q8, keep the copy qualitative on timing or use the carrier-aware windows the Email A template already uses (USPS 2–4w / UPS+FedEx 1–2w) — don't invent a third timeline.

**B3 — §3 FAQ Q6 (and Q5's "USPS/UPS"): the carrier list is contradicted by live rate behavior.**
- **Location:** §3, Q6 "Which carriers do you support? — USPS and UPS, live rates"; same claim embedded in Q5.
- **Issue:** FedEx is live in the rate path: `rates/index.ts`'s `SERVICE_DENYLIST` was added 2026-05-23 *because a real shipment (GC37EXG) was quoted FedEx Smart Post at $9.61* — it suppresses that one service, leaving other FedEx services offered; `utils.ts` carries full FedEx display mappings and tracking URLs; the refund-eligibility table and Email A both carry FedEx windows. Public copy saying "USPS and UPS" understates what customers will actually see on the rates screen.
- **Suggested fix:** Confirm the enabled EasyPost carrier accounts (one dashboard look), then either "USPS, UPS, and FedEx" or the safer generic "major national carriers (USPS, UPS, and more), live rates."

**B4 — §3 FAQ Q5: fee disclosure re-decides SPEC §3's display strategy without naming it.**
- **Location:** §3, Q5 "real USPS/UPS rates plus a small service fee, shown before payment."
- **Issue:** SPEC §3 Display Strategy: "Do NOT show SendMo fee separately. Show single 'Shipping' price that includes margin" (PLAYBOOK agrees). The draft publicly declares a separate service fee that the product deliberately never itemizes — and "shown before payment" reads as a promise that the fee is shown, which it isn't (only the single total is). Disclosing the fee's existence in an FAQ may well be the *right* trust/legal call, but it's a pricing-disclosure decision that contradicts a documented spec — that makes it John's call to make explicitly, not copy that slides through inside an SEO proposal (automatic-blocker rule for spec contradictions).
- **Suggested fix:** Either rewrite to match the display strategy (*"You see the total shipping price up front, before any payment — no surprises at checkout"*) or promote the fee-disclosure question into OQ3 as a named decision for John with the SPEC §3 conflict cited.

### Non-blocking concerns

1. **FAQPage rich results are overclaimed.** Since Google's October 2023 change, FAQ rich results are shown only for well-known, authoritative government and health sites — sendmo.co will not get the SERP treatment in 2026. §2 says "Eligible for FAQ rich results" and §6 step 6 implies a payoff. Keep the JSON-LD (cheap, harmless, still machine-readable context, and Bing still uses it in places), but correct the stated expectation and reframe §6 step 6 as "markup validates" rather than "feature appears."
2. **The `*` NotFound route is missing from the §2 route-class table.** Any arbitrary URL (e.g. `/asdf`) returns HTTP 200 with `index.html` — an indexable soft-404 carrying the homepage title. Google mostly copes, but the fix is ~1 LOC: a `usePageMeta`-style noindex (robots meta) on `NotFound.tsx`, and a row in the table. Worth doing while you're in these files.
3. **File overlap with the decided GA4 proposal is unnamed.** The same-day decided GA4 proposal edits `index.html` (gtag snippet in `<head>`) and `Privacy.tsx` (Sentry/PostHog disclosure → GA disclosure); this proposal edits both files too (JSON-LD block; `usePageMeta`). The reconciliation section only notes the Search-Console dependency. Name the overlap and sequence the PRs (GA4 first, this rebases) — the 2026-07-06 duplicate-arc incident is exactly the failure mode of two same-day arcs touching the same surface without coordination.
4. **The route classification is a one-shot enumerated list with an unsafe default for private routes.** A future private route (say `/wallet`) added to App.tsx gets no `X-Robots-Tag` unless someone remembers this proposal. New *public* pages defaulting to indexable is the right default; new *private* pages defaulting to indexable is the wrong direction. Cheap mitigation: a comment block in `vercel.json` (and/or next to the App.tsx route list) stating the index policy and "new private routes must be added to the headers list."
5. **`Disallow: /api` + deleting the only file in `api/`** means `/api/*` requests will fall through to the SPA catch-all and return 200 `index.html`. Harmless (robots.txt keeps crawlers out, and no code references `sendmo.co/api/*` — verified via grep), but worth knowing the behavior changes from "serverless function" to "homepage HTML" for that path family.
6. **PLAYBOOK staleness actively caused B1 — ride the doc fix.** PLAYBOOK's intro/Payment Flows still describe the flex hold, and both PLAYBOOK and SPEC §4 say "React 18" while `package.json` at origin/main is `react ^19.2.0` (the proposal is right; the docs are wrong). PRE-LAUNCH already has a "stale-doc cleanup" note for a different PLAYBOOK section — add these to it or fix inline with this PR.

### Nits

- §5's sibling link `2026-07-06_ga4-acquisition-analytics.md` is a dead relative link — the file was renamed `..._reviewed-2026-07-06_decided-2026-07-06.md` the same day.
- "(Rule 6)" in §2 is ambiguous: PLAYBOOK Rule 6 is "ALWAYS use Stripe Elements"; the intended citation is the global CLAUDE.md rule 6 (prefer extending over new constructs). Cite it as "global rule 6" to save the next reader the same double-take.
- Q1's "like Venmo for shipping costs" — third-party trademark in public product copy; fine if John wants it, but it's a brand call, fold into OQ3.
- Q11 names "Poshmark off-platform" deals — most marketplaces' ToS prohibit off-platform transactions; publicly courting that segment by name is a small brand/partner-risk call for John.
- FAQ.tsx today renders no `AppHeader`; the rewrite should presumably adopt the standard page shell (Privacy/Terms use a bare `<main>`, Index uses `AppHeader`) — say which, so the implementer doesn't guess.

### Execution-plan assessment

§3/§4/§6 are executable in the stated order by a fresh implementer with four guess-points:

- **Verified complete:** the §2 route-class table covers every route in origin/main's `App.tsx` except the `*` NotFound catch-all (concern 2). The vercel.json header list names all 13 private/semi-private path families correctly, including all three `/*-preview` routes and both `/admin` sub-route families (covered by `/admin(.*)`).
- **Guess-point 1 (the big one):** the FAQ copy's source of truth (B2) — as written, an obedient implementer produces wrong refund copy. Must be fixed in the proposal text, not left to implementation judgment.
- **Guess-point 2:** FAQ page shell (nit 5).
- **Guess-point 3:** NotFound classification (concern 2).
- **Guess-point 4:** PR sequencing vs the GA4 implementation (concern 3).
- §4's test plan is right-sized (jsdom unit tests for the hook's upsert semantics + FAQ/JSON-LD consistency) and the Rule 19 block correctly names the dev-server boundary — headers/middleware genuinely aren't reproducible on Vite, and deferring those axes to §6 post-deploy curls with the deferral *named in the LOG block* is the honest shape. §6 is correctly sequenced (deploy-green per Rule 21 → curl checks → social-preview regression check → John's Search Console runbook → week-later index confirmation) and correctly tags the Search Console step 👤.

### Predicted pitfalls (what most likely goes wrong if shipped as written)

1. **Stale-doc copy propagation onto a public payments surface.** Q7/Q8 were drafted from PLAYBOOK's pre-Pattern-D language; PRE-LAUNCH's 2026-07-04 review already caught this exact mechanism once (PLAYBOOK's "stub" labels misleading agents for weeks — the "Formerly-stub surfaces" correction). Same failure shape, but this time the stale text would land in customer-facing FAQ copy days before strangers transact. B1/B2 close it; the PLAYBOOK ride-along fix prevents the third recurrence.
2. **Silent post-deploy failure with a weeks-long feedback loop.** Headers, rewrites, and middleware behavior only exist at the Vercel layer, so the entire §6 curl battery is the *first* real verification — and SEO failures are invisible in the product (nothing breaks; Google just quietly keeps serving "SendMo — Prepaid Shipping Made Easy" on every result, or keeps robots.txt as HTML). This is the Rule 21 2026-05-21 incident shape (red state sat 18h because nobody verified after push) stretched to weeks. Mitigation: treat §6 steps 2–4 as same-session mandatory, not "later"; the LOG entry's Browser-verified block should cite the curls.
3. **The noindex matrix rots as routes are added.** The enumerated vercel.json list is correct today and wrong the day someone adds a private route without reading this proposal — the same "incidental drift" mechanism as the 2026-05-20 e2e locator rot (a reworded heading silently broke a text match). The `/for/*` landing pages named in §5 are the near-certain next route additions; they're public (safe default), but the first private addition leaks. Concern 4's policy comment is the cheap fence.
4. **Same-day PR collision on `index.html`/`Privacy.tsx` with the GA4 implementation.** Two decided/in-review proposals from the same author-day both edit the same `<head>` and the same privacy-disclosure paragraph. The 2026-07-06 T2-1 duplicate-arc incident (two sessions independently running the same item, discovered mid-execution) shows this failure mode is live in this project's current working style. Sequence explicitly (concern 3).
5. **Google's rendered-DOM title vs. static-title mismatch window.** Until JS executes, every public page serves the identical static title; Google's two-wave indexing usually resolves this, but if rendering fails intermittently (a JS error on a crawl, a timeout), Search Console will show duplicate titles across `/faq`/`/privacy`/`/terms` — which looks like the hook "not working" and could trigger a wild-goose debugging chase. Expect some duplicate-title noise in week one and judge by the §6 step 5 week-later check, not day-one results (the proposal's own "revisit only if pages fail to index" framing is right — hold that line).

### What the proposal got right

- **The §2 index-policy table is the hard part and it's correct** — specifically the noindex-requires-crawlability reasoning for `/s/` (Disallow would strand URL-stub results), which is the mistake most SEO plumbing gets wrong, and the belt-and-braces acknowledgment that middleware responses may bypass vercel.json headers.
- **Every infrastructure claim verified true against origin/main:** no robots.txt/sitemap in `public/` (so the catch-all does swallow them); headers match pre-rewrite paths; `public/` files beat the rewrite; `api/s/[shortCode].ts` history exactly as stated (7db5109 added file + `/s/→/api/s/` rewrite; 9db0768 dropped the rewrite; middleware superseded in 7aaec91; zero live references — clean dead-code rider).
- **OQ1's React-19 analysis is correct** — React 19 hoists component-rendered `<title>`/`<meta>` but does not dedupe against pre-existing static tags in the served HTML, so native metadata would double the tags; the 40-LOC mutation hook is the right minimal construct, and skipping react-helmet is the right global-rule-6 call. (Bonus: the proposal correctly says React 19.2 where both PLAYBOOK and SPEC stale-ly say 18.)
- **Honest-win framing** — explicitly deflating the traffic expectation and the crawl-budget non-problem is exactly the house style, and correctly scoping out prerendering/SSR for a 4-page public surface is the right engineering call.
- **OQ4's lean (noindex `/t/`) is right** — the tracking-IA-polish decided proposal establishes that any URL-holder sees the item description and names; per-shipment ephemera with PII strings has zero search value. No decided proposal requires `/t/` indexability (verified).
- **The `/s/` social-preview behavior is treated as load-bearing** and re-verified end-to-end (§6 step 4) rather than assumed — that's the one thing this change could silently break that would actually hurt growth.

## Author response

*(author session, 2026-07-06 — all four blockers and all concerns accepted; the
implementation spec = §§1–7 as amended below. The reviewer's core finding — that the
FAQ draft was cribbed from stale docs on a payments product — is exactly the failure
class the fact-check step existed to catch, and it caught it before the copy went
public rather than after.)*

**B1 — Q7 describes a hold that doesn't exist. ✅ Accept.** Q7 is rewritten to the
Pattern D truth, adopting the suggested copy: *"Flexible link: your card is securely
saved when you create the link (no charge, no hold); it's charged only when your
sender actually buys a label, and never more than the price cap you set."* The
PLAYBOOK stale-hold sentences (intro + Payment Flows) get the one-line ride-along fix
so this can't recur a third time.

**B2 — the verification pointer would corrupt Q8. ✅ Accept, all three parts.**
(a) The §3 instruction becomes: *"verify FAQ answers against PAYMENTS.md, the shipped
edge functions, and the 2026-07-05/06 LOG cancel→refund entries; where SPEC §13.1
disagrees, SPEC is stale."* (b) The SPEC §13.1 reconciliation (refund destination =
original card via Stripe per the decided 2026-05-21 refund-system proposal;
user-facing void = shipped, not post-MVP) rides this PR as a named drift-restoration.
(c) Q8's timing language uses the carrier-aware windows the Email A template already
carries — no third timeline invented.

**B3 — carrier list contradicted by live rates. ✅ Accept.** Q5/Q6 copy becomes the
safe generic (*"live rates from major carriers — USPS, UPS, and more"*), and §6 gains
a 30-second 👤/implementation check of the enabled EasyPost carrier accounts before
final copy; if FedEx is confirmed intentionally enabled, name it.

**B4 — fee disclosure re-decides SPEC §3's display strategy. ✅ Accept — the
reviewer is right that this was sliding a pricing-disclosure decision through an SEO
proposal.** Q5 is rewritten to conform to the *decided* display strategy: *"You see
the total shipping price up front, before any payment — no surprises at checkout."*
No fee itemization, no re-decision. If John ever wants explicit fee disclosure
(a defensible trust posture), that's its own decision citing SPEC §3 — flagged to
him in-session alongside the other copy calls.

**Non-blocking, all accepted:**
**N1 (FAQ rich results overclaimed) ✅** — §2 expectation corrected (Google restricts
FAQ rich results to gov/health since Oct 2023); JSON-LD kept as cheap machine-readable
context; §6 step 6 reframed to "markup validates," not "feature appears."
**N2 (NotFound soft-404) ✅** — `NotFound.tsx` gets a `usePageMeta` call with a
robots-noindex meta; the §2 table gains the `*` row. (~2 LOC.)
**N3 (unnamed file overlap with the decided GA4 proposal) ✅** — sequencing is now
explicit: **the GA4 implementation PR lands first; this PR is authored after it
merges and rebases on it** (both touch `index.html` `<head>` and `Privacy.tsx`).
The reconciliation section carries the note.
**N4 (route-matrix rot) ✅** — a policy comment lands in `vercel.json` next to the
headers block ("index policy: new private routes MUST be added here; see this
proposal") and a matching one-liner beside the App.tsx route list.
**N5 (`/api/*` falls through to the SPA post-deletion) ✅** — accepted as documented
behavior; robots.txt keeps crawlers out and zero references exist (grep-verified by
the review).
**N6 (PLAYBOOK/SPEC staleness: flex-hold language, "React 18") ✅** — both ride this
PR's doc pass (B1's PLAYBOOK fix; React 18→19.2 in PLAYBOOK + SPEC §4), logged under
PRE-LAUNCH's existing stale-doc cleanup note.

**Nits: all taken** — the sibling link updated to the decided filename; "(Rule 6)"
cited as "global rule 6"; the FAQ page adopts the `AppHeader` shell (matching Index —
it's a public marketing page, not a bare legal page); the two brand-voice items
(Q1's "like Venmo for shipping costs" trademark use; Q11 naming "Poshmark
off-platform" — a segment most marketplace ToS prohibit) are folded into OQ3 as
named calls for John at copy sign-off.

**Predicted pitfalls — adopted:** pitfall 2 → §6 steps 2–4 (the curl battery + social
preview re-check) are same-session mandatory and cited in the LOG Browser-verified
block; pitfall 4 → resolved by N3's sequencing; pitfall 5 → week-one duplicate-title
noise is expected and judged at the §6 step-5 week-later check ("hold that line" —
held).

No rejections, no unresolved points; nothing needs a Tradeoffs-for-John section
beyond the OQ2/OQ3 brand calls already assigned to John. Ready for John's decision.
