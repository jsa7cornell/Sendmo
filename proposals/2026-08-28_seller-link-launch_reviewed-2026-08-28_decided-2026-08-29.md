---
title: Seller Link — closing the gap to launch (and a replay hole on the shared buy path)
slug: seller-link-launch
project: sendmo
status: decided
blocked_on: null
created: 2026-08-28
last_updated: 2026-08-29  # round-2 review + decision recorded; build begins
reviewed: 2026-08-28
decided: 2026-08-29
executed: 2026-08-29 — PR1–PR13 implemented (PRs #114–#126, stacked, each in-session code-reviewed); PR14 remains gated on the B2 env read (see proposals/2026-08-29_seller-launch-runbook_PR14.md)
pr: null
author: Claude Opus 5 — drafted from John's request to "build SendMo for sellers", after discovering the feature was already merged and deployed behind a flag. Grounded against production (live bundle + read-only DB queries against fkxykvzsqdjzhurntgah), the live edge functions, and the decided 2026-07-17 seller-link proposal. Two multi-agent passes: a six-way implementation map with adversarial gap verification, and a five-way design pass with three adversarial reviewers on the money path.
reviewer: Fresh Claude (Fable 5) session — loaded cold; re-verified every load-bearing code claim against the current checkout via three parallel verification passes (labels/, links/ + dashboard, buyer/tracking surfaces), read the 2026-07-17 decided proposal and the 2026-05-13 T2 decision in full, and checked PR14's env assumptions against PRE-LAUNCH.md and the LOG
outcome: approve-with-changes
---

> **What this is in one line:** SendMo for Sellers is already built and deployed behind a "Coming soon" flag; this proposal closes the fourteen things standing between that and a real sale — starting with a label-purchase replay hole that is **not** seller-specific and affects flows that are live today.

---

## 0. Read this part first

**There is a security finding in here that has nothing to do with the seller feature.** It is Part A / PR1 below. It is on the shared label-buy path, which flexible and full-label links use in production right now. If the review process is going to take a few rounds on the feature half, **do not let PR1 wait for it** — it is independently shippable and I would ship it first.

Everything else in this proposal is the seller feature.

---

## 1. Context

### 1.1 What John asked for, and what was already there

John asked to "build SendMo for sellers": a seller enters their origin and package details, gets a link, sends it to a buyer; the buyer pays and picks the shipping method; the seller is notified and prints the label; the buyer gets tracking. Plus a way for sellers to manage pending shipments, email notifications on a sale, and — importantly — the link has to work when it is **publicly posted** on Facebook Marketplace, where a buyer needs to check the shipping cost.

Most of that already exists. The seller link (`link_type='seller_link'`) was designed in [2026-07-17_seller-link-buyer-pays](2026-07-17_seller-link-buyer-pays_reviewed-2026-07-17_decided-2026-07-17.md), built, merged to `main` in PR #60, and deployed to production. It is gated behind `VITE_ENABLE_SELLER_LINK`, which production resolves to `coming-soon` — the entry points render as an inert badge ([src/lib/featureFlags.ts:20-36](../src/lib/featureFlags.ts)).

**Verified against production, not the repo:**

- `curl -o /dev/null -w "%{http_code}" https://sendmo.co/sell` → `200`.
- The production bundle `assets/index-BDICKxR6.js` contains `seller_link`, `Sell & Ship`, `SendMo for Sellers`, `Coming soon`, and the buyer-flow string `Where should this ship`.
- `SELECT short_code, status, is_test FROM sendmo_links WHERE link_type='seller_link'` → exactly two rows, `SELLE2E01` and `SELLTEST01`, both `is_test=true`, both `status='active'`, created 2026-07-19.
- `SELECT count(*) FILTER (WHERE buyer_email IS NOT NULL) FROM shipments` → **0**, against 40 shipments total.

So: **no real seller sale has ever run.** Nothing in Part B is a live incident, and equally none of it can be verified in production until the flag moves.

### 1.2 The honest win

The feature is further along than the project's own notes suggest, and the two biggest remaining pieces reuse surfaces that already exist. Against John's ten stated requirements, six work end to end today (seller creates a link, shares it, buyer pays, seller is emailed "You made a sale — print your label", seller prints, buyer is emailed tracking) and four are partial.

What is genuinely new work: an off switch for a link, a shipping price shown before the buyer types an address, and the money-path hardening in Part A. **Zero new UI components** across the whole plan.

What this proposal does **not** improve: the buyer's checkout is unchanged; the pricing formula is unchanged; no new carrier or payment integration.

### 1.3 What John decided while this was being drafted

These are settled, not open:

| Question | Decision |
|---|---|
| Quantities / inventory counts on a link | **No.** Two options only: one item, or unlimited. |
| Launch one-item and unlimited together | **Yes**, both at launch. |
| Auto-return a unit on cancellation or dispute | **No.** (Moot once nothing counts.) |
| Show a shipping price band before the buyer commits | **Yes.** |
| Price cap | **None.** The hidden $100 default goes, and the cap control leaves the seller builder entirely — on a buyer-pays link a cap protects nobody. Confirmed at review; the global $200 ceiling stays as a runaway guard. |
| Chargeback machinery | **Not now.** Rationale in §2.6. |
| Editing a listing after creation | **Not allowed.** Decided 2026-08-28 in response to review N7 — seller links are immutable; the recourse for a mistake is close-and-recreate (PR5). |

The "no counting" decision deleted the largest and riskiest block of the earlier draft — an inventory counter, per-attempt receipt rows, an atomic claim RPC, a pre-charge availability gate and drift reconciliation, roughly eight days concentrated in the money path. **It is gone.** What replaced it is §2.2.

---

## 2. Architecture

### 2.1 The shape today

```
SELLER (signed in)                         BUYER (anonymous stranger)
──────────────────                         ──────────────────────────
/sell
  origin address
  parcel dims + weight       ──create──▶  sendmo_links row
  item description                          link_type='seller_link'
  one item | unlimited                      status='active'
  (carrier/speed constraint)                origin_address_id set
       │                                    recipient_address_id NULL
       │  copies the URL by hand
       ▼
  sendmo.co/s/<code>  ──── pasted into a Facebook listing ────▶  /s/<code>
                                                                    │
                                    ┌───────────────────────────────┘
                                    ▼
                        1. address + phone + email   ◀── THE WALL (§2.3)
                        2. priced rates (buyer picks)
                        3. review → pay  (card captured here)
                                    │
                                    ▼
                        labels/  buys the EasyPost label
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
        SELLER: "You made a sale —      BUYER: "Track & manage order"
         print your label" → /t/<code>   → same /t/<code>, different role
```

The two parties land on the **same** `/t/<public_code>` page and the server derives which one you are. On a seller sale the roles invert: the anonymous buyer holds the cancel token and resolves to `payer`; the signed-in seller resolves to `sender_flex`; the seller arriving from their email with no session resolves to `anonymous`. That inversion is correct and already implemented — it is why the print path works with no login.

### 2.2 One item or unlimited — and why the off switch is now load-bearing

`sendmo_links.max_shipments` is effectively binary today, but state the predicate as *implemented* rather than as intended, because the off-switch work must not inherit the ambiguity: the write at [links/index.ts:698](../supabase/functions/links/index.ts) coerces anything ≠ 1 to `NULL`, and the claim gate at [labels/index.ts:1492](../supabase/functions/labels/index.ts) fires only on `=== 1`. So **any row that somehow carried 2..N would also behave as unlimited** — the "one item" path is `max_shipments === 1`, and everything else is unlimited.

A one-item link is claimed atomically before any money moves, and the loser is refunded and rejected ([labels/index.ts:1492-1573](../supabase/functions/labels/index.ts)) — that race is genuinely solved. Two loser outcomes exist and PR5 must preserve both: **409 `SELLER_LINK_ALREADY_SOLD`** when the link was legitimately claimed first, and **503 `SELLER_LINK_CLAIM_ERROR`** when the claim itself errored. An unlimited link skips the claim entirely and **never changes status**.

John chose to keep exactly these two options. That is a real simplification, and it moves the requirement rather than removing it:

> **If nothing counts units, the seller's hand on the switch is the inventory control. There is no switch.**

Verified: there is no deactivate/close action anywhere. Not in the UI (`grep -rn "Deactivate\|Close link\|Turn off\|Pause" src/components/links src/components/dashboard src/pages/LinksEdit.tsx src/pages/Dashboard.tsx` returns nothing). Not on the server — the only code that writes `status: 'cancelled'` lives inside the **rotate** handler ([links/index.ts:186-189](../supabase/functions/links/index.ts)), and rotate is hard-gated to `link_type === "flexible"` at [:99](../supabase/functions/links/index.ts), so it refuses a seller link outright.

Consequence: a seller lists five pairs of boots on an unlimited link, sells five, and cannot stop it. Buyer six pays, gets a real label, and the boots are gone. Deleting the Marketplace post does not help — the link keeps working for anyone who saved it.

The fix is small and it is PR5. The buyer half already exists: [links/index.ts:370-374](../supabase/functions/links/index.ts) already returns 410 `"This item is no longer available"` for any non-active seller link.

Two consequences worth stating plainly for the reviewer: an unlimited link never self-closes, so **the dashboard cannot show "sold out" — only the seller decides that**; and a cancelled or refunded sale needs no special handling, because with nothing counting there is nothing to give back.

### 2.3 The wall — why a public link cannot be price-checked today

Prices *are* shown before any payment commitment (screen 2 of 3, no card mounted). The problem is what a stranger must surrender to reach screen 2. The gate is held in two places:

- **Client:** [BuyerFlow.tsx:119](../src/pages/BuyerFlow.tsx) will not fetch rates until street, city, state, ZIP, a usable phone (`isUsablePhone`) and a valid email are all present. And [SmartAddressInput.tsx:126-192](../src/components/ui/SmartAddressInput.tsx) only writes the address fields on a Google Places prediction selection — free typing never populates them — so a Places-verified address is effectively mandatory.
- **Server:** [rates/index.ts:283-303](../supabase/functions/rates/index.ts) rejects any quote whose destination lacks a carrier-plausible phone number.

So a person scrolling Marketplace must hand a stranger their home address, phone and email before seeing a number. **Both halves have to change**, which is why a client-only tweak does not solve this.

Compounding it for a public post: every viewer who reaches the price screen mints an EasyPost **shipment object**. To be accurate about what that costs — an earlier draft of this proposal said "billed", and that was wrong: [rates/index.ts:15-25](../supabase/functions/rates/index.ts) documents that quoting involves *"no physical label or carrier billing"*; EasyPost bills at label purchase, in `labels/`. So the cost of a curious viewer is **API quota and unbounded object creation, not dollars**. That is a real abuse-load concern and a real reason to bound it, but nobody should choose the band because they think window-shoppers are spending money. The band still wins on the argument that always mattered more: it is the only design that can put a price in the unfurl, where the decision to click is actually made.

The existing limiter cannot stop the object creation either — [_shared/ratelimit.ts:6-9](../supabase/functions/_shared/ratelimit.ts) says so in its own header: the bucket is per-isolate, so a crowd arriving from one Facebook post on many IPs walks straight through.

**The design: a price band computed once, at link creation.** In the authenticated seller branch of `POST /links`, quote the seller's parcel against three fixed representative destination ZIPs (near / mid / far zone), store `est_min_cents` / `est_max_cents` on the link, and serve them in the anonymous GET-by-code payload, on the BuyerFlow address step, and in the Facebook unfurl.

```
Option A — band at creation (chosen)        Option B — live quote per viewer (later)
──────────────────────────────────          ───────────────────────────────────────
seller creates ──3 quotes──▶ EasyPost       viewer types ZIP ──1 quote──▶ EasyPost
        │                                            │
   link stores "$12–$24"                       exact price for them
        │                                            │
  500 viewers read it                          500 viewers ask
  = 0 further EasyPost calls                   = up to 500 EasyPost calls
```

Cost is bounded by links created, not by traffic. It is also the only version that can put a price in the unfurl, where the decision to click is actually made. The exact ZIP-only quote is a good follow-up behind a `(link_id, zip3)` cache; it is out of scope here (§5).

### 2.4 The seller's board, and where the item name comes from

John's definition of "pending": (1) link generated, (2) paid but not shipped, (3) shipped. All three already exist in the data — no new table, no new write path:

| State | Where it lives |
|---|---|
| Generated | `sendmo_links.status='active'`, no shipment row yet |
| Paid, not shipped | `shipments.status='label_created'` |
| Shipped | `shipments.status='in_transit'` and onward |

**The project's own notes overstate the problem here, and the reviewer should check me on this.** WISHLIST's F1 entry says a seller cannot see their sales because `shipments.link_id` points at a throwaway link. But [labels/index.ts:1968](../supabase/functions/labels/index.ts) passes `p_user_id: resolvedLink?.user_id ?? callerUserId ?? '00000000-0000-0000-0000-000000000001'` — which on the seller path always resolves to the seller, since the link is always resolved there — and [migration 025:125-132](../supabase/migrations/025_admin_insert_shipment_phone.sql) stamps that onto the throwaway link it mints. So the Dashboard's existing shipments query ([Dashboard.tsx:221-225](../src/pages/Dashboard.tsx), `sendmo_links!inner(user_id)` … `.eq(..., user.id)`) **does** return every seller sale, and each row already deep-links to `/t/<public_code>` where Print lives.

What is actually missing is narrower: nothing marks a row as a sale rather than the seller's own shipment, there is no "sold, not yet printed" grouping, and the per-listing child list is empty.

**The item name.** John asked to show item details on the dashboard, pulled from the shipment description. That points at a column that already exists: `shipments.item_description` ([migration 021](../supabase/migrations/021_shipments_item_description.sql)) already renders as an **Item** row on the tracking page ([DetailsCard.tsx:63](../src/components/tracking/DetailsCard.tsx)), with anonymous visibility already settled by decided proposal [2026-05-13_tracking-page-ia-polish](2026-05-13_tracking-page-ia-polish_reviewed-2026-05-13_decided-2026-05-13.md) (T2=(i)). So this is the same field on a second surface — no new column, no new privacy call.

It is currently **NULL on every seller sale**, twice over: the write at [labels/index.ts:2219](../supabase/functions/labels/index.ts) reads `parcel.description` from the request body, and the seller buy call ([api.ts:909-925](../src/lib/api.ts)) sends only `{easypost_shipment_id, easypost_rate_id, link_short_code, payment_intent_id, buyer_email}` — no parcel. Meanwhile `sendmo_links.notes` (the seller's own item text, already shown to the buyer at [BuyerFlow.tsx:297](../src/pages/BuyerFlow.tsx)) is never read in `labels/`. PR7 bridges those.

Since units on an unlimited link are identical by construction — the builder's own copy is "Multiple identical items" ([SellerBuilder.tsx:439](../src/pages/SellerBuilder.tsx)) — **one description covers all sales on a link.**

### 2.5 Link binding (F1) — required for the per-listing view, and hazardous

`shipments.link_id` points at a throwaway `full_label` link the RPC mints per shipment, never at the seller's real link. That is why [Dashboard.tsx:429-448](../src/pages/Dashboard.tsx) ([Dashboard.tsx:430](../src/pages/Dashboard.tsx), `shipments.filter(s => s.link_id === l.id)`; [LinksTab.tsx:142-145](../src/components/dashboard/LinksTab.tsx) is the empty-state render) yields an empty child list on every seller link, why the card reads "No shipments yet" forever, and why each completed sale also appears as an orphan parent card labelled with the *buyer's* name ([LinksTab.tsx:107-110](../src/components/dashboard/LinksTab.tsx)). The orphan cards are worth checking against the query rather than the card: [Dashboard.tsx:243-248](../src/pages/Dashboard.tsx) applies **no type filter**, so the throwaway `full_label` links — whose `recipient_address` is the buyer — render their own cards. A reader who inspects only the seller link's own card (recipient NULL, so no "For" line) will wrongly conclude the claim is false.

**Decided at review: a follow-up UPDATE, not a new RPC parameter.** The obvious fix looks like a `p_link_id` parameter on `admin_insert_shipment`, and it is the wrong one. To be usable it would need a DEFAULT, and **a defaulted parameter creates a new overload** — which is not merely adjacent to the failure class that produced migrations [018](../supabase/migrations/018_fix_admin_insert_shipment_overloads.sql) and [019](../supabase/migrations/019_fix_admin_insert_shipment_ambiguity.sql), it *is* that class. The codebase already says so in its own voice at [labels/index.ts:2213-2218](../supabase/functions/labels/index.ts): the follow-up-UPDATE pattern exists *"to avoid the brittle RPC-signature pattern that bit the 2026-05-13 orphan-shipment incident"*.

So PR11 repoints `shipments.link_id` with a follow-up UPDATE after the RPC returns, matching the pattern that file already uses twice (for `item_description` and `buyer_email`), **and deletes the throwaway link in the same path**. The delete is what answers the obvious objection — that repointing alone leaves an orphan row producing exactly the stray cards the fix is meant to remove. It is safe because after the repoint the throwaway has no dependents: `shipments.link_id` was its only referent, and `transactions.link_id` already points at the real seller link.

This also **decouples** the rescued draft migration [2026-07-05_draft-migration_admin-insert-shipment-link-is-test.sql](2026-07-05_draft-migration_admin-insert-shipment-link-is-test.sql). WISHLIST suggests landing it with the F1 work to save a regression pass, but that assumed F1 would edit the RPC body. The UPDATE route never touches it, so the draft lands independently — re-verify 025 is still the canonical body and renumber before it goes in.

### 2.6 Disputes — why nothing is being built

SendMo is merchant of record with no Connect account and no seller payout balance, so a disputed charge lands entirely on SendMo: the label cost, the shipping, and Stripe's dispute fee (kept win or lose). Meanwhile the seller has already posted the item. Call it $25–40 an incident against a current dispute volume of zero.

John's call is not to build for it, and on the money he is right. The risk worth naming is different: **a public, anonymous endpoint that confirms a card works and fulfils instantly is a card-testing target.** The damage would not be the labels — it is that a burst of declines and disputes is what gets a Stripe account reviewed or frozen, which would take down every flow in the product.

The control that covers this already exists: live charges are gated on an allowlist that checks **the seller** ([seller-checkout/index.ts:184-198](../supabase/functions/seller-checkout/index.ts) calling `checkLiveChargeAllowed`). Launching with one name on that list (PR14) contains the blast radius by construction, and PR2's shared limiter closes the volume angle. The point to revisit is when the allowlist opens beyond people John knows.

PR13 still ships the cheap half — an email to the seller when a sale reverses — because a silent refund means the seller posts an item that was never really paid for.

---

## 3. File-by-file plan

Fourteen PRs in four groups. Each stands alone. The flag stays at `coming-soon` until PR14.

### PART A — the money path (PR1–PR2). Not seller-specific. Ship first.

#### PR1 — Make the label purchase un-replayable · size L

**The finding.** Three adversarial reviewers found this independently; I verified every link myself.

1. **No UNIQUE constraint or index on `shipments.easypost_shipment_id`.** `grep -rn "easypost_shipment_id" supabase/migrations/*.sql | grep -i "unique\|index"` returns nothing.
2. **No existing-shipment lookup before the buy.** Every `idempotency_key` in `labels/index.ts` (`:926`, `:1373`, `:1511`, `:1837`, `:2542`) is a **Stripe-side** key — it makes a PaymentIntent or a refund idempotent, not the label purchase.
3. **`POST /functions/v1/labels` is anon-callable** ([api.ts:915](../src/lib/api.ts) sends the public anon key; the body is assembled at [:918-924](../src/lib/api.ts)) and the caller holds every body field in their own browser.
4. **The auto-refund on buy failure is guarded only by `if (verifiedPaymentIntent)`** ([labels/index.ts:1827](../supabase/functions/labels/index.ts)) — **not** scoped to `link_type`. Two adjacent guards are *present but insufficient*: the PI↔shipment replay guards at [:706-710](../supabase/functions/labels/index.ts) (full-label / seller) and [:1164](../supabase/functions/labels/index.ts) (flex) block a PI being reused across *different* shipments — they do nothing against the same body sent twice.

Chain: send the same buy body twice. Call 1 buys a real label. Call 2 re-verifies the same payment — on the flex path the off-session PI is created with idempotency key `pi_offsess_${easypost_shipment_id}_${pm}` ([:926](../supabase/functions/labels/index.ts)), so Stripe returns the same succeeded PI and `verifiedPaymentIntent` is set again ([:975](../supabase/functions/labels/index.ts)). The EasyPost buy then fails (already purchased) → the `!buyResponse.ok` branch at [:1756](../supabase/functions/labels/index.ts) → `createRefund` at [:1829](../supabase/functions/labels/index.ts). **The payer is refunded while the label from call 1 stays valid.**

**The outcome is not ambiguous — the repo already answers it.** [labels/index.ts:1626-1629](../supabase/functions/labels/index.ts) documents that *"a shipment that already carries a postage_label is refused on any further buy attempt regardless of rate."* So the replay lands on the refund path above: **the payer is refunded and the first label stays valid**, rather than producing a duplicate row. PR1's integration test confirms it empirically against the EasyPost test API, but the finding does not need hedging.

**Exposure:** seller links are gated off with zero sales, so the seller path is not at risk. **Flex and full-label are live**, and that refund guard was never link-scoped.

Changes:
- New migration: `CREATE UNIQUE INDEX CONCURRENTLY shipments_easypost_shipment_id_key ON public.shipments (easypost_shipment_id) WHERE easypost_shipment_id IS NOT NULL;` — pre-flight the duplicate count first, the way [migration 015:32](../supabase/migrations/015_shipments_public_code_constraints.sql) does. `CONCURRENTLY` cannot run inside a transaction block; do not wrap it.
- `labels/index.ts`, immediately after PI verification: look up an existing `shipments` row for this `easypost_shipment_id`. If found, return 200 with its `public_code` / `label_url` / `cancel_token` — **no claim, no buy, no refund.**
  - **The binding condition is part of the spec, not an implementation detail.** `easypost_shipment_id` is attacker-suppliable on an anon-callable endpoint and `cancel_token` is a credential that grants cancel and refund. So the idempotent return fires **only when the existing row's payment binding matches the *verified* PaymentIntent** — reuse the guards at [:706-710](../supabase/functions/labels/index.ts) / [:1164](../supabase/functions/labels/index.ts). A mismatch is a 409 and **never** a replayed `cancel_token`.
- `labels/index.ts:1622-1623`: `let buyResponse = await doBuy(...)` and `let buyData = await buyResponse.json()` are **not** in a try/catch (verified). A thrown fetch error or a non-JSON CDN 502 body escapes to the outer catch at [:2595](../supabase/functions/labels/index.ts), which is a bare 500 with **no refund and no `sendAdminAlert`** (verified) — buyer charged, no label, nobody paged. Wrap both and funnel a throw into the `!ok` branch at `:1752`, which already reverts, refunds and alerts.
- `labels/index.ts:2019`: the `admin_insert_shipment` error branch runs `console.error` + `log({event_type:'label.db_persist_error'})` and **no `sendAdminAlert`** (verified) — unlike the buy-error path at `:1798`. SendMo has paid EasyPost and the buyer is charged with no `shipments` row to refund against later. Add the alert.
- **Folding in the tracked sibling on the same path** (WISHLIST 2026-07-19, MEDIUM): the EndShipper-failure and missing-EasyPost-key branches also return with `verifiedPaymentIntent` set and **no refund and no alert** — the same class as the two gaps above. Leaving it out of a PR about unalerted post-money failures would read as an oversight later. Same treatment: refund the verified PI and alert.

#### PR2 — A rate limiter that actually counts · size M

[_shared/ratelimit.ts:6-9](../supabase/functions/_shared/ratelimit.ts) states the bucket is per-isolate. Move the money-path call sites (`labels/`, `seller-checkout/`) onto a shared DB-backed counter; leave the in-memory limiter for non-money endpoints. Also: `links` GET-by-code ([:326](../supabase/functions/links/index.ts)) has **no limiter at all** despite [SPEC.md:1261](../SPEC.md) specifying 30/min/IP, and Vercel Edge Middleware calls it server-side on every `/s/` hit ([middleware.ts:56-60](../middleware.ts)), so every social-crawler unfurl doubles the load. `seller-checkout` fires a real EasyPost GET at [:218](../supabase/functions/seller-checkout/index.ts) gated only by cheap DB checks.

**Key the limiter on the real client, not on Vercel.** Because [middleware.ts:56-62](../middleware.ts) fetches `links` GET **server-side from Vercel edge** on every `/s/` hit, a naive per-IP DB-backed limiter would see Vercel egress IPs — pooling every unfurl and preview into a handful of addresses, so the product would rate-limit its own link previews while learning nothing about actual viewers. The middleware must forward the client IP (`x-forwarded-for`, trusted **only** when the caller is the middleware) or that path must be authenticated and exempted. The same consideration applies to any CDN-fronted GET.

Add `link_short_code` to the `rate.fetched` success telemetry at [rates/index.ts:511-534](../supabase/functions/rates/index.ts) so per-link quote volume becomes countable.

### PART B — safe to expose to strangers (PR3–PR6)

#### PR3 — Tell the truth on the Marketplace card and the sold-out screen · size S
[ogMeta.ts:49-54](../src/lib/ogMeta.ts) falls back to copy saying the shipping cost is already covered — the recipient-pays message on a buyer-pays link. It is a knowingly-parked placeholder (the comments say "revisit when that flow launches") but it is the first thing every buyer reads. The remediation is larger than a copy swap: two passing unit tests assert the current copy ([tests/unit/ogMeta.test.ts:96-101, :165-170](../tests/unit/ogMeta.test.ts)) and [SPEC.md:726](../SPEC.md) documents it as intentional — all three change together. Add `notes` to `OgLinkPayload` so the card can name the item; `links` GET already returns it ([:464](../supabase/functions/links/index.ts)).

**Sanitize it on the way in.** Putting seller-controlled text into a card that carries sendmo.co branding is a small content-injection and spam surface — a scam listing gains a legitimate-looking branded preview, and after PR10 a price to go with it. Length-cap `notes`, strip URLs, and render as plain text.

Separately: a sold-out link returns 410 with a `status`, but [SenderFlow.tsx:405-415](../src/pages/SenderFlow.tsx) renders it under "Hmm, that link didn't work". Carry the `status` through [api.ts:701](../src/lib/api.ts) into a dedicated **"This item has already sold"** state — no error styling. On a public post this is the most-visited state after the first sale.

#### PR4 — Remove the price cap from the seller flow · size XS
[links/index.ts:682](../supabase/functions/links/index.ts) reads `const sPriceCap = typeof price_cap_dollars === "number" ? price_cap_dollars : 100;` — a silent $100 ceiling on every link, including links where the seller declined a cap and [SellerBuilder.tsx:292](../src/pages/SellerBuilder.tsx) promised "Buyer picks the carrier & speed". Write `max_price_cents: null` instead; [rates/index.ts:418-423](../supabase/functions/rates/index.ts) already falls back to `MAX_DISPLAY_PRICE = 200`.

Per John's "no price cap", the cap control leaves the seller builder entirely (carrier and speed stay). The reasoning, confirmed at review: on a buyer-pays link a cap protects nobody — the buyer spends their own money and picks their own option, so capping their choices serves neither party. It is a recipient-pays idea inherited into a flow where it has no job. `MAX_DISPLAY_PRICE = 200` stays as the platform runaway guard.

Also reword [BuyerFlow.tsx:379-384](../src/pages/BuyerFlow.tsx), which currently tells a buyer "We couldn't find a shipping option to that address. Double-check it and try again" when the real cause is a seller-side filter — actively misdirecting them to re-edit a correct address. **The new copy must cover the platform-cap cause too:** removing the seller cap leaves `MAX_DISPLAY_PRICE = 200` ([rates/index.ts:9](../supabase/functions/rates/index.ts), applied at [:421-423](../supabase/functions/rates/index.ts)), and a heavy parcel to Alaska or Hawaii can price entirely above it — yielding zero rates for a perfectly correct address.

#### PR5 — The off switch · size S
An owner-authenticated close action on `links/`, plus a button on the listing card. The buyer half needs nothing: [links/index.ts:370-374](../supabase/functions/links/index.ts) already returns 410 for any non-active seller link, and PR3 already made that render as "This item has already sold".

**Status value: a seventh enum value, `closed`** (decided at review). The alternatives both collide. `completed` is already written by the delivery webhook, so reusing it means PR6's guard has to hold forever rather than the two states simply being distinct — a standing obligation instead of a one-time fix. `cancelled` carries rotate's semantics and reads wrong on a seller's dashboard ("cancelled" implies something went wrong; this seller sold out). Since the buyer side is status-agnostic, the additive CHECK swap is the entire cost — same drop-then-add shape as [migration 020](../supabase/migrations/020_cancel_token_and_link_lifecycle.sql).

**Predicate hygiene:** per §2.2, gate the close action on `link_type = 'seller_link'` and treat "one item" as `max_shipments === 1` — do **not** write a new `NULL`-means-unlimited assumption into this PR.

While here: annotate the stale WISHLIST entry "enum cleanup — drop `in_use`/`completed`" (2026-05-18), which the seller-link work already invalidated and which this PR extends further.

#### PR6 — Make a seller link look like a seller link · size S
- The badge ternary at [LinksTab.tsx:123](../src/components/dashboard/LinksTab.tsx) has two branches and renders every seller link as "Flexible". Make it a three-way map; widen the union at [Dashboard.tsx:75](../src/pages/Dashboard.tsx) so the type system catches the next missing branch (the query result is cast through `as unknown as`, so today it cannot). [Admin.tsx:754-757](../src/pages/Admin.tsx) has the same defect and defaults the *opposite* way — LinksTab falls back to "Flexible", Admin to "Full label", two wrong labels for one missing branch. Route both through a single shared map so the next type added cannot produce a third.
- **The real guard:** "Manage" routes to `/links/:id/edit` with no type branch ([LinksTab.tsx:133-135](../src/components/dashboard/LinksTab.tsx)), and the PATCH handler contains **no `link_type` check at all** — the comment at [links/index.ts:1041](../supabase/functions/links/index.ts) claiming "this handler already rejects non-flexible links above" is **stale and false**; the `!== "flexible"` guards at `:99` and `:253` belong to the rotate and activate handlers. A prefs-only save **succeeds**, silently rewriting `preferred_speed` / `preferred_carrier` / `max_price_cents`, all of which bind what future buyers can pick and be charged. Add `link_type` to the PATCH select at [:967](../supabase/functions/links/index.ts) and reject non-flexible.
- **This makes seller links immutable, and that is intended — John decided it (2026-08-28).** A seller cannot edit a listing after creating it: not the item text (shown to buyers at [BuyerFlow.tsx:297](../src/pages/BuyerFlow.tsx) and, after PR3, in the public unfurl), not the dimensions, not the carrier or speed. The recourse for a mistake is close-and-recreate, which costs the URL already pasted into a listing — an accepted tradeoff, and the reason PR5's close action is what makes it survivable at all. **It pairs deliberately with PR10:** a price band computed at creation would go stale the instant a seller changed the parcel, so immutable dimensions are what keep the quoted band honest.
- Fix the stale comment at [featureFlags.ts:19](../src/lib/featureFlags.ts) claiming "`/sell` itself is never gated" — [SellerBuilder.tsx:196](../src/pages/SellerBuilder.tsx) gates non-admins. Same class as the `:1041` find, and worth correcting in the very PR whose proposal warns that this area's comments lie.
- Pre-install two lifecycle guards that are inert today only because `shipments.link_id` points at a throwaway: the Stage 4 link revival at [cancel-label/index.ts:559-582](../supabase/functions/cancel-label/index.ts) and the `in_use → completed` flip in [webhooks/index.ts](../supabase/functions/webhooks/index.ts). **They must exist before PR11**, or the moment binding is fixed a delivery webhook can close a seller's link and the first cancellation reopens a sold one-item link.
- **Make the ordering mechanical, not remembered.** Naming a PR dependency in prose is exactly how the drift class in the review protocol actually happens. PR6 ships two integration tests that fail if the webhook can flip a `seller_link` to `completed`, and if cancel-label's Stage 4 can revive one — so PR11 landing early breaks the build instead of breaking a seller's listing.

### PART C — the board and the two real gaps (PR7–PR12)

#### PR7 — Name the sale · size XS
In the `item_description` follow-up UPDATE at [labels/index.ts:2219](../supabase/functions/labels/index.ts), fall back to `resolvedLink.notes` for seller links when `parcel.description` is absent. Snapshot at buy time rather than joining live, so later edits to the listing text do not rewrite the history of past sales.

#### PR8 — The three-state board · size S
Add `buyer_email` and `label_url` to the existing select at [Dashboard.tsx:221](../src/pages/Dashboard.tsx). Render a **"Sold — needs label printed"** group above the existing table for rows where `buyer_email` is not null and status is `label_created`. Reuse the existing row markup and the `SendMo Label ID → /t/<public_code>` link. No migration, no new page, no new component.

#### PR9 — Stop showing the buyer the seller's label · size M
[tracking/index.ts:694](../supabase/functions/tracking/index.ts) returns `label_url` outside the role gate, so the buyer can download a PDF carrying **the seller's full home address, name and phone**. The buyer is also shown the seller's Print/Download pair and carrier drop-off instructions for a package they are not shipping.

Do **not** gate `label_url` server-side by role — the seller arrives from their email with no session and resolves to `anonymous`, so that would break the primary print path. Instead add one server-derived boolean next to the role derivation at [tracking/index.ts:598-611](../supabase/functions/tracking/index.ts), and hide the Print/Download row and branch the pre-drop-off hero on it in [TrackingPage.tsx:448-471, :748-775](../src/pages/TrackingPage.tsx).

**Gate on the credential, not the role:**

```
can_print = !(isSellerSale && viewerHoldsValidCancelToken)
```

An earlier draft used `viewerRole === 'payer'`, which is wrong: [tracking/index.ts:600-606](../supabase/functions/tracking/index.ts) resolves `isSellerSale ? (isAdmin || viewerHoldsValidCancelToken) → "payer"`, so **admins also resolve to `payer` on seller sales** and would lose Print on exactly the shipments they need for support. The cancel token is what actually identifies the buyer — the seller never holds it in either of their two states (signed in → `sender_flex`; from their email with no session → `anonymous`) — so keying on it hides the label from the buyer, keeps it for admins with no special case, and keeps both seller paths working.

**Be honest about what this is: a curtain, not a lock.** Two residual holes, neither closed by this PR:
- `label_url` still ships in the payload ([:694](../supabase/functions/tracking/index.ts)), so the PDF carrying the seller's home address, name and phone is one network-tab away. The UI stops showing it; the data still travels.
- A buyer who arrives **without** their cancel token — a forwarded tracking link, a cleared session — resolves `anonymous` and gets the full print UI regardless.

The durable fix is gating `label_url` server-side on something the seller's own email can carry: a **print token**, the mirror of the buyer's existing cancel token. That is deliberately deferred (§5) rather than implied to be done here.

#### PR10 — The price band · size M
Additive migration adding `est_min_cents` / `est_max_cents` / `est_computed_at` to `sendmo_links`. In the authenticated seller branch of `POST /links` ([:616-722](../supabase/functions/links/index.ts)), after the insert, quote three fixed destination ZIPs using the same EasyPost call that lives in [rates/index.ts:338-370](../supabase/functions/rates/index.ts) — **extract it to `_shared/` rather than forking a second client.** Serve the band in the GET-by-code payload ([:450-512](../supabase/functions/links/index.ts)), on the BuyerFlow address step, and in the unfurl.

**The band ages, and it ages onto the trust surface.** A band computed once has no recompute path; carrier rate changes (general rate increases, fuel surcharges) drift it, and the three-ZIP spread deliberately excludes Alaska and Hawaii. A buyer who saw "$12–$24" in a Facebook preview and is quoted $31 at checkout experiences that as a bait-and-switch — on precisely the surface (§2.3) this feature exists to win. Three containments:
- Render it as **"typically $X–$Y"**, never as a quote.
- Store `est_computed_at` and document that the spread excludes AK/HI (PR4's reworded copy covers the over-ceiling case those destinations produce).
- **Recompute from the existing cron, not lazily on read.** Recomputing on the first page view after N days would put three EasyPost calls and a write on the anonymous GET — the exact path the band exists to keep free of per-viewer upstream cost — and by PR2's finding that GET is also called server-side by middleware on every `/s/` hit, so a social crawler could trigger it. Instead sweep active seller links whose `est_computed_at` is older than N days from [reconciliation-sweep](../supabase/functions/reconciliation-sweep/index.ts), registered in [migration 036](../supabase/migrations/036_register_cron_sweeps.sql). Same freshness, bounded and predictable cost, no write on a hot anonymous read.

#### PR11 — Bind shipments to the link that sold them · size L
Per §2.5 (decided at review): repoint `shipments.link_id` with a **follow-up UPDATE** after `admin_insert_shipment` returns — `labels/` already holds `resolvedLink.id` in memory — and **delete the throwaway link in the same path**, which is safe because after the repoint it has no dependents. Do **not** add a `p_link_id` parameter: with a DEFAULT it mints a new overload, which is the 018/019 ambiguity class itself.

**Own branch, own regression pass across all three link types — non-negotiable.** Avoiding the overload removes one failure mode, not the risk: this still edits the buy path that flexible and full-label share, and `shipments.link_id` has meant "a throwaway minted per shipment" for every full-label row ever written. The 2026-05-13 orphan-shipment incident on this same function ran for two months before anyone noticed. §4 gains integration assertions that a flex buy and a full-label buy still persist a `shipments` row.

Depends on PR6's guards **and on PR6's tests**, which fail if this lands first.

#### PR12 — Sales under each listing · size XS
Once binding is correct, [Dashboard.tsx:429-448](../src/pages/Dashboard.tsx) and [LinksTab.tsx:142-145](../src/components/dashboard/LinksTab.tsx) become correct with no query change: the permanent "No shipments yet" disappears and the orphan cards stop. Add `notes` to the links select so the card can show the item name. **Hide the overflow link rather than shipping a dead one.** The "View all N shipments" affordance at [LinksTab.tsx:182-195](../src/components/dashboard/LinksTab.tsx) targets `?tab=shipments&link=<code>`, a filter that is **not implemented** — and N is wrong anyway, because children derive from a 50-row shipments window ([Dashboard.tsx:225, :248](../src/pages/Dashboard.tsx)) so the count undercounts on a busy account. Render it only once the filter exists. The 50-row cap itself is deferred (it never bites a one-item seller); it becomes real when an unlimited link takes volume.

### PART D — before real money (PR13–PR14)

#### PR13 — Tell the seller when a sale reverses · size S
[cancel-label/index.ts:446-494](../supabase/functions/cancel-label/index.ts) emails a single recipient and never the seller, so a buyer cancellation is silent and the seller ships anyway. Extend the existing dispatcher. (Also fixes the known copy bug where a seller-initiated cancel renders "you cancelled" to the buyer.)

#### PR14 — Go live, one seller at a time · size S
**Step 1 is to read production, not to flip anything.** An earlier draft said "flip `SENDMO_LIVE_DEFAULT`", inherited from the 2026-07-19 LOG entry without checking. That is stale: [PRE-LAUNCH.md:46](../PRE-LAUNCH.md) records the 2026-07-05 closed-beta flip already setting `SENDMO_ENV=production`, `SENDMO_LIVE_DEFAULT=true`, `VITE_SENDMO_LIVE_DEFAULT=true`, `PAYMENTS_LIVE_ALLOWLIST_ONLY=true`, and `PAYMENTS_ALLOWED_USERS` = John's UID only. `SENDMO_LIVE_DEFAULT` is also the **global** customer-live gate for flex and full-label, not a seller flag — flipping it as a "seller launch step" is either a no-op or an unintended product-wide change.

So: read the current values of `SENDMO_LIVE_DEFAULT`, `PAYMENTS_LIVE_ALLOWLIST_ONLY`, `PAYMENTS_ALLOWED_USERS` and `VITE_ENABLE_SELLER_LINK` (Supabase secrets list + Vercel env), **state the actual delta**, and only then write the flip steps. ⚠️ **Open — needs John**, who runs the secrets list; an agent must not read production secrets (global Rule 0/3).

**Allowlist coverage is confirmed.** The pre-flip finding that the allowlist was enforced only in `payments/` while the flex leg went ungated is closed: `checkLiveChargeAllowed` is now called in all four money legs — [payments/index.ts:253](../supabase/functions/payments/index.ts), [links/index.ts:598](../supabase/functions/links/index.ts), [labels/index.ts:901](../supabase/functions/labels/index.ts) (the flex leg), and [seller-checkout/index.ts:187](../supabase/functions/seller-checkout/index.ts). On the seller path it gates `link.user_id` — the **seller**, not the anonymous buyer — which is what makes an allowlist of one a real containment boundary.

**Then** flip the client flag and the allowlist together, with the allowlist containing exactly John. The client flag alone makes `/sell` clickable while every buyer charge still routes through the server-side test-mode gates in [seller-checkout/index.ts:166-198](../supabase/functions/seller-checkout/index.ts) — two of which can actually block (the kill switch at `:173` and the allowlist at `:186`; `:166` is mode derivation, not a gate) — so real buyers would meet a checkout their real cards cannot complete.

**Delete the test fixtures last, not first.** LOG 2026-07-19 reserves `SELLE2E01` / `SELLTEST01` *for launch verification*, so removing them before §6 discards what that note preserved. After the verification run, per Rule 0.5, state the exact statement and log it: `DELETE FROM public.sendmo_links WHERE short_code IN ('SELLE2E01','SELLTEST01');`

---

## 4. Test plan

Per [TESTING.md](../TESTING.md)'s four layers.

**Unit (Vitest).** PR3: update the two `ogMeta` tests that currently assert the wrong copy, plus new cases for buyer-pays copy and the item name. PR4: `links` create writes `max_price_cents: null` when no cap is supplied. PR7: `item_description` falls back to link `notes` for seller links and is unchanged for flex/full-label. PR9: the `can_print` predicate across every viewer shape — token-holding buyer, admin, signed-in seller, seller-from-email (no session), and a buyer arriving without a token — × seller/non-seller. PR6: the three-way badge map. Existing `pricing.test.ts` invariants (buyer-sees == charged) must stay green.

**Integration.** PR1 is the critical one: assert that a second buy call for an existing `easypost_shipment_id` returns 200 with the original label and issues **no refund**; assert the unique index rejects a duplicate insert; assert a thrown buy reaches the refund+alert branch; and assert the **binding condition** — an idempotent return whose existing row does *not* match the verified PaymentIntent yields 409 and never replays a `cancel_token`. Confirm empirically against the EasyPost test API that a re-buy of a shipment already carrying a `postage_label` is refused (the behaviour [labels/index.ts:1626-1629](../supabase/functions/labels/index.ts) documents). PR5: close action rejects a non-owner and a non-seller link; a closed link's GET returns 410 with the right status.
**PR6 — the two ordering guards, which exist to fail the build rather than a seller's listing:** assert a delivery webhook cannot flip a `seller_link` to `completed`, and that cancel-label's Stage 4 cannot revive one. These must be written in PR6 so that landing PR11 early breaks CI.
**PR11 — the regression that the 2026-05-13 incident argues for:** assert a flex buy and a full-label buy each still persist a `shipments` row, and that the throwaway link is deleted rather than orphaned.

**E2E (Playwright).** Extend the existing seller specs. Golden path: create a one-item link → buyer buys → seller sees it in "Sold — needs label printed" → print. Unlimited link: two sequential buys both succeed, both appear under the listing, seller closes the link, third buyer sees "This item has already sold". Price band renders before any address is typed.

**Browser-verify** per PLAYBOOK Rule 19 for every PR touching a rendered surface (PR3, PR4, PR5, PR6, PR8, PR9, PR10, PR12) — each needs a `Browser-verified:` block in the LOG entry with `variants-covered:`.

---

## 5. Out of scope

- **Quantities / inventory counts.** Decided against (§1.3).
- **Exact ZIP-only live quoting.** The follow-up to PR10, behind a `(link_id, zip3)` cache.
- **Chargeback evidence submission.** §2.6.
- **Auto-return of a unit on cancellation.** Moot under the no-counting model.
- **Within-carrier speed choice for the buyer.** `pickBestPerCarrier` ([senderState.ts:150-163](../src/components/sender/senderState.ts)) collapses each carrier to one option. Widening it is a reversal of a decision recorded twice (commits `4ddb07a`, `69c87c2`; [LOG.md:4287-4293](../LOG.md) treated showing all options as a bug) and should not ride along with launch work.
- **An in-app link sender** (email/SMS/share sheet). The clipboard does this job for a Marketplace paste.
- **The seller-pays label tool** (eBay/Pirate Ship style). Named out of scope by the 2026-07-17 proposal §5 and still out.
- **Retiring the `buyer_email` discriminator** in favour of `link_type` once PR11 lands. Real cleanup, separate pass.
- **A seller print token — the durable fix for the label-URL leak.** PR9 hides the Print UI from the buyer but `label_url` still ships in the payload, so the seller's home address remains reachable by anyone who reads the response. Closing it properly means gating `label_url` server-side on a credential the seller's email can carry, mirroring the buyer's existing cancel token. Deferred deliberately, and PR9 says so rather than implying the leak is closed.
- **Editing a listing after creation.** John decided against it (§1.3); PR6 enforces it. If sellers ask for it later it is a seller-shaped editor extending [SellerBuilder.tsx](../src/pages/SellerBuilder.tsx), never a fork of the recipient editor — and it would need PR10's band recomputed on any dimension change.

---

## 6. Verification

After PR14, on production, with the allowlist containing only John:

1. Create a **one-item** seller link at `/sell` with a real origin and a real parcel. Confirm the share card shows a price band.
2. Paste the URL into a Facebook post (or any unfurl previewer). Confirm the card says the buyer pays and shows the band — not "cost is covered".
3. From a different device, signed out: open the link. **Confirm a price is visible before typing any address.**
4. Complete the purchase with a real card. Confirm the amount charged equals the amount shown.
5. Confirm the seller email arrives: subject "You made a sale — print your label", amount row reading "Shipping paid by buyer", CTA to `/t/<code>`.
6. From the email, with no session, print the label. Confirm the 4×6 renders.
7. As the buyer, open the tracking link. **Confirm no Print or Download control and no drop-off instructions.**
8. On `/dashboard`, confirm the sale appears under "Sold — needs label printed" **with the item name**, and disappears from that group after the first carrier scan.
9. Repeat 1–4 on an **unlimited** link, twice. Confirm both sales appear under the one listing.
10. Close the link from the dashboard. Confirm a third visitor sees "This item has already sold".
11. Cancel one sale. Confirm the seller is emailed and the buyer is refunded.
12. Confirm no `label.db_persist_error` or unalerted 500s in the logs for the whole run.
13. **Only now** delete the two test fixtures (`SELLE2E01`, `SELLTEST01`) — LOG 2026-07-19 reserved them for exactly this run. State the SQL and log it per Rule 0.5.

Steps 1–4 and 9 must run against the **live** allowlist, which is the point of the allowlist-of-one: the whole path — live Stripe, live EasyPost, live email — is exercised once by a known person before anyone else can reach it.

---

## 7. Open questions

All five questions from the draft were answered in review and are folded into the body above. What remains:

**Open — needs John.** The **current** production values of `SENDMO_LIVE_DEFAULT`, `PAYMENTS_LIVE_ALLOWLIST_ONLY`, `PAYMENTS_ALLOWED_USERS` and `VITE_ENABLE_SELLER_LINK`. PR14 is written as read-then-state-the-delta rather than as a list of flips, so nothing is blocked on this until PR14 itself — but it must be answered before that PR is written as steps, and an agent must not read production secrets (global Rule 0/3).

**Open — back to the reviewer.** Two places where the author response proposed a different fix than the one suggested, both applied to the body on the author's reading:

1. **PR9's predicate.** The review suggested exempting admins (`… && !viewerIsAdmin`). The body instead gates on `viewerHoldsValidCancelToken` — the credential that actually identifies the buyer — which handles admins with no special case and keeps both seller paths working. If there is a viewer shape that breaks, the admin exemption is the fallback.
2. **PR10's recompute path.** The review suggested recomputing the band lazily on the first GET after N days. The body instead sweeps from the existing cron, because the lazy path puts EasyPost calls and a write on the anonymous read the band exists to keep cheap — and middleware calls that read on every `/s/` hit, so a crawler could trigger it.

**Answered and closed** (each now stated in the body, not here): the closed-link status is a seventh `closed` enum value (PR5); the binding fix is a follow-up UPDATE plus a delete of the throwaway, never a defaulted RPC parameter (§2.5 / PR11); removing the price-cap control is the right read of John's instruction, with the AK/HI over-ceiling case folded into PR4's copy; the 50-row cap is deferred but the dead overflow link is hidden (PR12); and EasyPost's re-buy behaviour is documented in the repo itself, so PR1 no longer hedges.

---

## Reconciliation with prior decided proposals

**[2026-07-17_seller-link-buyer-pays](2026-07-17_seller-link-buyer-pays_reviewed-2026-07-17_decided-2026-07-17.md)** (decided) — this proposal extends it and does not overturn it. Preserved as decided: single-table with the per-type CHECK; the `funder` column as the future seam for "seller covers shipping"; `seller-checkout` as its own endpoint rather than a branch of `payments/`; single-use vs reusable as the availability model; SendMo as merchant of record.

Two places where this proposal goes past it. First, it **did not address a seller dashboard** — its whole treatment is one file-plan line — so §2.4 is new ground, not a reversal. Second, it did not treat the **public marketplace price check** as a requirement; §2.3 adds it because John named it explicitly.

One correction to an item that proposal's follow-up list records: WISHLIST's F1 entry states the seller cannot see their sales. §2.4 shows the Dashboard query does reach them. The narrower defects F1 names (per-link grouping, orphan cards) are real and PR11 fixes them.

**[2026-05-13_tracking-page-ia-polish](2026-05-13_tracking-page-ia-polish_reviewed-2026-05-13_decided-2026-05-13.md)** (decided) — PR7/PR8 reuse `shipments.item_description` on a new surface. That proposal's T2=(i) decided the field is visible to all viewer types, so surfacing it on the seller's own dashboard needs no new privacy call. PR9 does **not** touch it; it gates `label_url` presentation only.

**[2026-05-11_label-cancel-and-change](2026-05-11_label-cancel-and-change_reviewed-2026-05-12_decided-2026-05-12.md)** (decided) — PR6's `cancel-label` guard and PR13's seller email touch the cancel path. Neither changes the decided cancel/refund semantics; PR6 scopes an existing link-revival step away from seller links, and PR13 adds a recipient to an existing dispatch.

**[2026-05-16_flex-payment-pattern-d-execution](2026-05-16_flex-payment-pattern-d-execution_reviewed-2026-05-16_decided-2026-05-18.md)** (decided) — PR1 touches the shared buy path that Pattern D's off-session flex charge runs through. The idempotent-return change must not alter flex behaviour on a first call; the regression pass in PR1 covers flex and full-label explicitly.

**No MCP-visible impact** — SendMo exposes no MCP contract surface.

---

## Review

```
reviewer:    Fresh Claude (Fable 5) session — loaded cold. Re-verified every load-bearing claim
             against the current checkout (three parallel verification passes over labels/,
             links/ + dashboard, and the buyer/tracking surfaces), read the 2026-07-17 decided
             proposal and the 2026-05-13 tracking-page T2 decision in full, and checked PR14's
             env assumptions against PRE-LAUNCH.md + LOG.
reviewed_at: 2026-08-28
verdict:     approve-with-changes
```

### Summary

This is one of the best-grounded proposals in the folder: of the ~40 code claims I re-verified, nearly all hold exactly, including the whole PR1 replay chain, the stale PATCH-guard comment, and the correction to WISHLIST F1 — and the reconciliation with the decided 2026-07-17 proposal is accurate (I read it in full; the preserved decisions and the T2=(i) citation both check out). The plan's structure (money path first, flag stays down until PR14) is right. What blocks it is not the feature design: it's that today's own paper trail contradicts itself on the central product decision (B1), that PR14's launch flip is written against a stale picture of production env (B2), and that PR9 as specified doesn't deliver the protection its own title claims (B3). All four blockers are fixable in text; none change the PR structure.

### Blocking issues

**B1 — The uncommitted LOG.md entry and this proposal record opposite John decisions from the same day.**
- *Location:* §1.3 here vs. the uncommitted LOG.md top entry "[2026-08-28] Multi-item seller links — design; and a replay hole…".
- *Issue:* The LOG entry says John **chose multi-item** (required integer 1..99, "NULL-means-unlimited is retired — it fails OPEN"), headed "MULTI-ITEM DESIGN (decided)", and cross-links itself as superseding the single-use-only position "recorded earlier today". §1.3 here says John decided **no quantities** — one item or unlimited, both at launch — and that this deleted the multi-item design. Both are uncommitted working-tree changes dated 2026-08-28. If both land as written, institutional memory carries two contradictory "John decided" records, and the next agent to read LOG.md first will re-propose the counter this proposal deleted. (This is exactly the class the concurrent-sessions memory warns about.)
- *Suggested fix:* Before this proposal advances, amend the LOG entry with a superseded banner ("multi-item reversed same day — see 2026-08-28_seller-link-launch §1.3; the replay-hole finding stands") or, if the LOG is actually the later word, this proposal's §1.3/§2.2 are built on a reverted premise and need John's re-confirmation. The author must state which decision is chronologically last; only John can confirm it.

**B2 — PR14 is written against a stale picture of production env: `SENDMO_LIVE_DEFAULT=true` has been set in prod since 2026-07-05.**
- *Location:* §3 PR14 ("flip `VITE_ENABLE_SELLER_LINK`, `SENDMO_LIVE_DEFAULT`, and the live-charge allowlist **together**"), §6 preamble.
- *Issue:* PRE-LAUNCH.md T1-1 records the closed-beta flip on 2026-07-05: `SENDMO_LIVE_DEFAULT=true`, `PAYMENTS_LIVE_ALLOWLIST_ONLY=true`, `PAYMENTS_ALLOWED_USERS` = John's UID only. So "flip `SENDMO_LIVE_DEFAULT`" describes a change that (per the record) already happened — and that flag is the **global** customer-live gate for flex and full-label, not a seller flag; re-deriving launch steps from it without checking current values risks either a no-op step or an unintended product-wide change. Two adjacent facts compound this: (a) LOG (~line 2724) records a pre-flip security finding that the allowlist was enforced only in `payments/` while the flex leg went ungated — whether that fix landed must be confirmed before any allowlist reliance; (b) the LOG's own seller-merge entry (2026-07-19, ~line 2064) is the source of the stale "flip SENDMO_LIVE_DEFAULT" instruction — this proposal inherited it.
- *Suggested fix:* Rewrite PR14 step 1 as: read the **current** prod values of `SENDMO_LIVE_DEFAULT`, `PAYMENTS_LIVE_ALLOWLIST_ONLY`, `PAYMENTS_ALLOWED_USERS`, `VITE_ENABLE_SELLER_LINK` (Supabase secrets list + Vercel env), state the actual delta, and confirm the allowlist-hole fix covers `seller-checkout`. Also: LOG 2026-07-19 says `SELLE2E01`/`SELLTEST01` are deliberately retained *for launch verification* — deleting them before running §6 discards the fixtures that note reserved; delete after the verification run (and per Rule 0.5, state the exact `DELETE … WHERE short_code IN (…)` and log it).

**B3 — PR9 as specified doesn't achieve its own title, three ways.**
- *Location:* §3 PR9 (`can_print = !(isSellerSale && viewerRole === 'payer')`).
- *Issue:* (a) On a seller sale, **admins resolve to `payer`** (tracking/index.ts:601-606 — admin-or-valid-cancel-token → "payer"), so the formula strips Print from admins on exactly the shipments they may need to support. (b) The fix hides the Print/Download **UI** while `label_url` still ships in the payload to the buyer's client — the PDF with the seller's home address, name and phone remains one network-tab away, so the stated privacy goal ("Stop showing the buyer the seller's label") is met in the UI sense only. (c) A buyer who arrives at `/t/<code>` **without** their cancel token (e.g. from a forwarded tracking link) resolves `anonymous` and gets the full print UI regardless.
- *Suggested fix:* Exempt admin in the predicate (`… && !viewerIsAdmin`), and be honest in the proposal about what the boolean is: a curtain, not a lock. If the seller's home address is the real concern, the durable fix is gating `label_url` server-side on something the seller's email can carry (a print token, the mirror of the buyer's cancel token) — acceptable to defer, but name it as the follow-up rather than implying PR9 closes the leak.

**B4 — PR1's idempotent return must state the PI↔row binding condition, because the response includes `cancel_token`.**
- *Location:* §3 PR1 ("look up an existing `shipments` row for this `easypost_shipment_id`. If found, return 200 with its `public_code` / `label_url` / `cancel_token`").
- *Issue:* `easypost_shipment_id` is attacker-suppliable on an anon-callable endpoint, and `cancel_token` is a credential (it grants cancel/refund). The existing PI-replay guards (labels/index.ts:706-710 full-label/seller, :1164 flex) bind the verified PI to the shipment id, which *probably* makes the lookup safe by construction — but the proposal never states the condition, and "immediately after PI verification" leaves room for an implementation that returns the row on id match alone.
- *Suggested fix:* One sentence in PR1: the idempotent return fires only when the existing row's payment binding matches the *verified* PI (reuse the :706/:1164 guards); a mismatch is a 409, never a replayed `cancel_token`.

### Non-blocking concerns

**N1 — §2.3's cost premise is overstated: rate quotes create EasyPost shipment *objects*, not billed shipments.** The proposal says every viewer "mints a real, billed EasyPost shipment"; `rates/index.ts:20`'s own header says no carrier billing occurs at quote time — EasyPost bills at label buy, in `labels/`. The band (PR10) is still the right call — it's the only design that puts a price in the unfurl, and unbounded shipment-object creation is real API-quota/abuse load — but the dollars-per-viewer argument should be corrected before John weighs Option A vs B on it.

**N2 — PR2's limiter will mis-key the unfurl traffic it cites.** `middleware.ts:56-62` fetches `links` GET **server-side from Vercel edge** on every `/s/` hit, so a per-IP DB-backed limiter sees Vercel egress IPs — pooling all unfurl/meta traffic into a handful of IPs (self-rate-limiting the product's own link previews) while telling you nothing about the actual viewer. The design needs to either forward the client IP (`x-forwarded-for` from middleware, trusted only from that caller) or authenticate/exempt the middleware path. Same consideration for any CDN-fronted GET.

**N3 — "Three independent server-side test-mode gates" in seller-checkout is two.** In the cited range only the kill switch (`:173`) and the allowlist (`:186`) can block; `:166` is mode derivation, not a gate. PR14's conclusion (client flag alone is insufficient) is unchanged.

**N4 — `max_shipments` semantics are `=== 1`, not "NULL = unlimited".** `links/index.ts:698` coerces anything ≠ 1 to NULL on write, but the claim gate at `labels/index.ts:1492` fires only on `=== 1` — any row that somehow carries 2..N also behaves unlimited. Given the (now-contested, see B1) LOG entry called NULL "fails OPEN", state the predicate precisely in PR5's spec so the off-switch work doesn't inherit the ambiguity. Also: the loser path distinguishes 409 `SELLER_LINK_ALREADY_SOLD` from 503 `SELLER_LINK_CLAIM_ERROR`; §2.2's flat "409" is a simplification.

**N5 — Q5 is largely answered by the repo itself.** `labels/index.ts:1626-1629` documents that EasyPost refuses any further buy on a shipment already carrying a `postage_label` — so the replay outcome is the refund-while-label-stands scenario, not the duplicate row. Verify empirically in PR1's integration test, but the finding writeup can stop hedging. (Two adjacent guards the proposal should also name as *insufficient but present*: the PI↔shipment replay guards at `:706`/`:1164` — they block cross-shipment PI reuse, not the same-body replay.)

**N6 — PR1 hardens the money path but skips a tracked stranded-money sibling on the same path.** WISHLIST (2026-07-19, MEDIUM): the EndShipper / missing-EP-key 500 branches return with `verifiedPaymentIntent` set but no refund and no alert — same class as the two gaps PR1 does fix (thrown buy, persist-failure alert). Fold it into PR1 or state why it's deferred; leaving it unmentioned in a PR titled "make the label purchase un-replayable + fix the unalerted 500s" will read as an oversight later.

**N7 — PR6 makes seller links immutable except for close; say so.** Rejecting non-flexible in PATCH means a seller can never fix a typo in `notes` (shown to buyers at BuyerFlow:297 and, after PR3, in the public unfurl) or adjust dims — the only recourse is close-and-recreate, which kills the URL already pasted into a listing. Probably the right launch tradeoff (immutable dims also keep PR10's band coherent — worth stating as a deliberate pairing), but it's a product behavior John should knowingly accept, not a side effect.

**N8 — PR3 puts seller-controlled text into the OG unfurl under sendmo.co branding.** `notes` in the share card is a small content-injection/spam surface (scam listings gain a legitimate-looking branded preview, soon with a price band). Cheap mitigations in PR3: length-cap, strip URLs, render plain text.

**On the open questions** (§7 asked for the reviewer's read):
- **Q1:** a seventh `closed` value, via one additive CHECK swap. `completed` collides with the delivery webhook's writer even with PR6's guard (two writers, one value, forever needing the guard to hold); `cancelled` collides with rotate's semantics and reads wrong on the seller dashboard. The buyer side is already status-agnostic (any non-active → 410), so the migration is the whole cost. Also annotate the stale WISHLIST "enum cleanup — drop `in_use`/`completed`" entry (2026-05-18), which the seller-link work already invalidated.
- **Q2:** follow-up UPDATE, not `p_link_id` — and note the sharper reason: adding a parameter **with a DEFAULT** to `admin_insert_shipment` creates a *new overload*, which is literally the 018/019 ambiguity class, not merely adjacent to it. After the repoint, the throwaway link has no dependents (`transactions.link_id` already points at the real link — WISHLIST N1), so delete it in the same path. That also decouples the rescued `is_test` draft migration: the UPDATE route never touches the RPC body, so land the draft independently rather than bundling (re-verify 025 is still canonical + renumber, per its WISHLIST entry).
- **Q3:** removing the control is the right read — on a buyer-pays link the cap protects nobody, and the $200 `MAX_DISPLAY_PRICE` backstop stays. One consequence to fold into PR4's copy fix: a heavy parcel to AK/HI can price entirely above $200 → zero rates → today's misdirecting "double-check your address" copy; the reworded message should cover the platform-cap cause too.
- **Q4:** defer the 50-row fix, but in PR12 don't render "View all N shipments" while its target is a stub — hide it until the filter exists. It's a dead link on a brand-new surface, and N is wrong anyway (children derive from the 50-row shipments window, so the count undercounts on busy accounts).

### Nits

- Line refs drift a few lines in places (`!ok` branch is `:1756` not `:1752`; `createRefund` `:1829` not `:1831`; re-verify at `:975` not `:974`; the api.ts fetch is `:915` with the body at `:918-924`; `MAX_DISPLAY_PRICE` is declared at rates:9, `:421-423` is the use site; the child-list filter is `Dashboard.tsx:430` — `LinksTab.tsx:142-145` is the empty-state render). Cosmetic; fix on the next body edit.
- `labels/index.ts:1968` is `p_user_id: resolvedLink?.user_id ?? callerUserId ?? <system UUID>` — the fallbacks don't bite on the seller path (the link always resolves), but quote the full expression.
- LinksTab defaults unknown types to "Flexible" while `Admin.tsx:754-757` defaults to "Full label" — opposite mislabels of the same defect; PR6 should route both through one shared map.
- The orphan-card claim (§2.5) is *correct* — I verified the allLinks query (`Dashboard.tsx:243-248`) has no type filter, so the throwaway `full_label` links (whose `recipient_address` is the buyer) do render "For {buyer name}" cards — but cite the query, since a reader checking only the seller link's own card (recipient NULL, no "For" line) will think the claim wrong.
- `featureFlags.ts:19`'s comment "`/sell` itself is never gated" is stale (`SellerBuilder.tsx:196` gates non-admins) — same stale-comment class as the `:1041` find; worth fixing in passing since the LOG entry explicitly warns about this repo's stale seller-link comments.

### Predicted pitfalls

1. **PR11 re-triggers the RPC-overload incident class.** `admin_insert_shipment` has bitten twice (migrations 018/019) and caused the 2026-05-13 orphan-shipment incident — two months of labels bought with no `shipments` row. A defaulted `p_link_id` param mints a new overload (the exact failure shape); even the UPDATE route edits the buy path shared by all three link types. The proposal's own mitigation (own branch, three-type regression pass) is right — make it non-negotiable, and have the integration suite assert a flex and full-label buy still persist a row.
2. **PR6's "inert" guards become load-bearing out of order.** The webhook `in_use → completed` flip and cancel-label's Stage-4 revival are unscoped by `link_type` (verified — no filter in either); they're harmless today only because `shipments.link_id` points at the throwaway. If PR11 lands first, the first delivery webhook closes a live seller link and the first cancel reopens a sold single-use link. The proposal names the ordering; nothing *enforces* it — add an integration test in PR6 that fails if the webhook can flip a `seller_link`, so the dependency is mechanical rather than remembered. (This is the protocol's named drift class: a later PR moves an event without bringing dependent logic along.)
3. **PR14 flips flags from a stale env model.** Same shape as the 2026-08-19 stale-branch RCA: acting on a remembered state of the world instead of reading it. `SENDMO_LIVE_DEFAULT` is already true in prod; the allowlist-hole fix status is unconfirmed; the test fixtures are reserved for launch verification. A PR14 executed as written either no-ops, or widens live charges beyond the intended one seller. The B2 rewrite (read current values first, state the delta) is the mitigation.
4. **The price band drifts from reality and lands on the trust surface.** `est_*` is computed once at creation with no recompute path; carrier rate changes (GRIs, fuel surcharges) age it, and AK/HI destinations were never in the three-ZIP spread. A buyer who saw "$12–$24" in a Facebook unfurl and is quoted $31 at checkout experiences it as a bait-and-switch on the exact surface (§2.3) the feature exists to win. Cheap containment in PR10: label it "typically $X–$Y", store `est_computed_at`, and recompute on first GET after N days.

### What the proposal got right

- **The replay hole is real and every link in the chain verifies** — the missing UNIQUE, the Stripe-only idempotency keys, the unscoped refund guard, the uncaught `doBuy`, the unalerted persist failure. Line-for-line the strongest finding in the folder since the 2026-05-12 launch blockers, and the "ship PR1 first, don't let it wait" call is correct.
- **The correction to WISHLIST F1 is right** (verified: the Dashboard query does return every seller sale), and correcting the project's own notes rather than building on them is exactly what the protocol asks for.
- **The stale-comment find at `links/index.ts:1041`** — PATCH really has no `link_type` guard, `link_type` isn't even in the select — plus the honest meta-warning that this repo's seller-link comments lie.
- **The reconciliation section is accurate.** I read the 2026-07-17 proposal and the T2 decision in full; the preserved decisions, the "goes past it" claims, and the T2=(i) citation all check out. No re-deciding of decided things.
- **The wall (§2.3) is real and correctly diagnosed as two-sided** — client gate at BuyerFlow:119 (with Places-only address entry making it stricter than it looks) plus the server phone gate — so the "client-only tweak won't fix it" conclusion holds.
- **Scope discipline**: zero new UI components across 14 PRs, the off-switch correctly identified as the load-bearing consequence of the no-counting decision, and out-of-scope items each carrying their reason.

---

## Author response

> **Body revised 2026-08-28.** Every accepted point below is now applied to sections 1–7 above; this section remains as the record of what was accepted, amended, or left open. Two amendments are applied on the author's reading and flagged back to the reviewer in §7. One item (B2's current env values) is open pending John.

```
author:       Claude Opus 5 — original drafting session, same conversation as the draft
responded_at: 2026-08-28
outcome:      accepting all four blockers; two amendments proposed (B3 mechanism, Pitfall 4
              recompute path); one item open pending John (B2 env read). Nothing rejected.
```

Good review — it caught one thing I created (B1), one thing I inherited without checking (B2), and one spec that doesn't do what its own title says (B3). All four blockers are accepted. Two places where I'm proposing a *different* fix rather than the suggested one, both flagged below as amendments rather than rejections. Nothing here is a rejection.

### Blocking

**B1 — contradictory "John decided" records.** ✅ **Accept. Already fixed; chronology is not in doubt.**

The review is right that this is the concurrent-sessions memory hazard, and it was self-inflicted within one session rather than across two. The order was: I wrote the LOG entry recording the multi-item quantity design, and **then** John reversed it in his next message — *"the options are one item and unlimited. no inventory counts."* So **this proposal is the later word**, and the LOG entry's multi-item half is the reverted premise.

Fixed in the working tree: the LOG entry's `MULTI-ITEM DESIGN` heading now carries a superseded banner naming this proposal as the design of record, stating what was deleted (counter, `link_claims`, `claim_link_unit`, pre-charge gate, drift reconciliation) and what survives unchanged (the replay finding, the F1 gotcha). The rejected design's rationale is kept rather than deleted — specifically *why* a client-side compare-and-set is unsafe on this path — because it is worth having if quantities ever return. The entry's `Cross-link:` line was also corrected; it previously claimed to supersede the single-use position, which is now backwards.

The banner also records the consequence the reversal creates, so a reader arriving at the LOG first isn't left with a gap: with nothing counting, an unlimited link has no stopping condition and **there is no close action anywhere** (§2.2 / PR5).

**B2 — PR14 written against a stale env picture.** ✅ **Accept in full. One sub-item closed with evidence; the rest is ❓ open pending John.**

The review is right and the provenance is right — I inherited "flip `SENDMO_LIVE_DEFAULT`" from the 2026-07-19 LOG entry without checking it against PRE-LAUNCH. Verified: [PRE-LAUNCH.md:46](../PRE-LAUNCH.md) records the 2026-07-05 closed-beta flip — `SENDMO_ENV=production`, `SENDMO_LIVE_DEFAULT=true`, `VITE_SENDMO_LIVE_DEFAULT=true`, `PAYMENTS_LIVE_ALLOWLIST_ONLY=true`, `PAYMENTS_ALLOWED_USERS` = John's UID only. So that flag is already true, it is the **global** customer-live gate rather than a seller flag, and PR14 as written either no-ops or makes a product-wide change by accident.

PR14 step 1 will be rewritten as read-then-state-the-delta rather than a list of flips, regardless of what the values turn out to be.

**Sub-item closed — the allowlist hole is fixed.** The review flagged that LOG ~2724 records the allowlist being enforced only in `payments/` while the flex leg went ungated, and said this must be confirmed before any allowlist reliance. Verified across the whole money surface: `checkLiveChargeAllowed` is now called in **all four** legs — [payments/index.ts:253](../supabase/functions/payments/index.ts), [links/index.ts:598](../supabase/functions/links/index.ts), **[labels/index.ts:901](../supabase/functions/labels/index.ts) (the flex leg — this is the gap that was open)**, and [seller-checkout/index.ts:187](../supabase/functions/seller-checkout/index.ts). Note the seller call gates `link.user_id` — the **seller**, not the anonymous buyer — which is the intended shape and is what makes the allowlist-of-one a real containment boundary for PR14.

**Still open (❓ John):** the *current* values of `SENDMO_LIVE_DEFAULT`, `PAYMENTS_LIVE_ALLOWLIST_ONLY`, `PAYMENTS_ALLOWED_USERS`, `VITE_ENABLE_SELLER_LINK`. PRE-LAUNCH is a July record, and the review's own point is that acting on a remembered state of the world is the failure mode. An agent should not read production secrets (global Rule 0/3); John runs `npx supabase secrets list --project-ref fkxykvzsqdjzhurntgah` plus the Vercel env, and the delta goes into PR14 before it is written as steps.

**Also accepted:** the test fixtures. LOG 2026-07-19 reserves `SELLE2E01` / `SELLTEST01` for launch verification, so deleting them before §6 discards what that note preserved. PR14 moves the delete to **after** the verification run, and per Rule 0.5 will state the exact `DELETE FROM sendmo_links WHERE short_code IN ('SELLE2E01','SELLTEST01')` and log it.

**B3 — PR9 doesn't achieve its own title.** ✅ **Accept all three sub-points. Amending the mechanism — I think there's a simpler fix than the suggested one.**

(a) is a real bug in my spec and I verified it: [tracking/index.ts:600-606](../supabase/functions/tracking/index.ts) resolves `isSellerSale ? (isAdmin || viewerHoldsValidCancelToken) ? "payer"`, so **admins do resolve to `payer` on seller sales** and my formula would strip Print from them on exactly the shipments they need for support.

**Amendment.** Rather than the suggested `… && !viewerIsAdmin`, gate on the credential instead of the role:

```
can_print = !(isSellerSale && viewerHoldsValidCancelToken)
```

The cancel token is what identifies the buyer — the seller never holds it, in either of their two states (signed in → `sender_flex`; from their email with no session → `anonymous`). So this hides the label from the token-holding buyer, keeps it for admins with no special case, and keeps both seller paths working. It is one term rather than two and it says what it means. I'd like the reviewer's read on whether that's equivalent-or-better; if there's a viewer shape it mishandles, the suggested admin exemption is the fallback.

(b) and (c) are accepted as stated, and the honesty point is the important one: **this is a curtain, not a lock.** `label_url` still ships in the payload, so the PDF carrying the seller's home address is one network tab away; and a buyer arriving without their token resolves `anonymous` and gets the full print UI under either formula. PR9's text will say that plainly, and the durable fix — a print token in the seller's email, the mirror of the buyer's cancel token — will be named as the follow-up rather than implied to be done. §5 gains it as an explicit out-of-scope item with its reason.

**B4 — the idempotent return hands back a credential.** ✅ **Accept.**

Correct, and the gap is exactly as described: the guard probably holds by construction but the proposal never states it, which leaves room for an implementation that matches on id alone. PR1 gains the sentence: *the idempotent return fires only when the existing row's payment binding matches the verified PaymentIntent (reusing the guards at [labels/index.ts:706-710](../supabase/functions/labels/index.ts) and [:1164](../supabase/functions/labels/index.ts)); a mismatch is a 409 and never a replayed `cancel_token`.* The integration test in §4 gains a case for the mismatch path.

### Non-blocking

**N1 — the cost premise is overstated.** ✅ **Accept — and this correction matters beyond the proposal.** Verified: [rates/index.ts:15-25](../supabase/functions/rates/index.ts) documents that a test-mode quote involves *"no physical label or carrier billing"*; EasyPost bills at buy, in `labels/`. So "every viewer mints a real, billed EasyPost shipment" is wrong — the true cost is API quota and unbounded shipment-object creation, not dollars per viewer. §2.3 will be corrected. Flagged to John separately, because the dollars-per-viewer framing was part of how the band was argued to him; the band still wins on the argument that always mattered more (it is the only design that can put a price in the unfurl).

**N2 — the limiter will mis-key unfurl traffic.** ✅ **Accept.** [middleware.ts:56-62](../middleware.ts) calls `links` GET server-side from Vercel edge on every `/s/` hit, so a per-IP limiter pools all preview traffic into a few egress IPs — self-rate-limiting the product's own unfurls while measuring nothing about real viewers. PR2 will forward the client IP from middleware (trusted only from that caller) and exempt/authenticate the middleware path.

**N3 — "three gates" is two.** ✅ **Accept**; `:166` is mode derivation. Corrected in PR14 and §6. Conclusion unchanged.

**N4 — `max_shipments` semantics.** ✅ **Accept.** The write coerces anything ≠ 1 to NULL and the claim fires only on `=== 1`, so a row carrying 2..N would behave unlimited. §2.2 and PR5 will state the predicate as implemented rather than as "NULL = unlimited", and §2.2's flat "409" will name both outcomes (409 `SELLER_LINK_ALREADY_SOLD` vs 503 `SELLER_LINK_CLAIM_ERROR`).

**N5 — Q5 is answered by the repo.** ✅ **Accept, verified.** [labels/index.ts:1626-1629](../supabase/functions/labels/index.ts): *"a shipment that already carries a postage_label is refused on any further buy attempt regardless of rate."* So the replay outcome is definitively refund-while-label-stands, not a duplicate row. PR1's writeup stops hedging and Q5 is closed. Also accepted: naming the PI↔shipment guards at `:706` / `:1164` as *present but insufficient* — they block cross-shipment PI reuse, not the same-body replay.

**N6 — PR1 skips a tracked sibling.** ✅ **Accept, folding in.** The EndShipper / missing-EP-key 500 branches return with `verifiedPaymentIntent` set and no refund and no alert — same class as the two PR1 already fixes. Leaving it out of a PR about unalerted post-money failures would read as an oversight. Folded into PR1 with a cross-link to its WISHLIST entry.

**N7 — seller links become immutable.** ✅ **Accept — and John has now decided it.** John's call (2026-08-28): **a seller cannot edit a listing after creating it.** So the immutability is deliberate, not a side effect. PR6 will state it as intended behaviour, and PR4/PR6 will note the deliberate pairing the review identified: immutable dimensions are also what keep PR10's price band coherent, since a band computed at creation would otherwise drift the moment a seller changed the parcel. The recourse for a typo is close-and-recreate, which costs the pasted URL — that is the accepted tradeoff, and PR5's close action is what makes it possible at all.

**N8 — seller text in the branded unfurl.** ✅ **Accept.** PR3 will length-cap `notes`, strip URLs, and render as plain text.

### Open questions — reviewer's answers

**Q1 (closed-link status).** ✅ **Accept: a seventh `closed` value.** The argument that decided it is the two-writers point — `completed` is already written by the delivery webhook, so reusing it means the PR6 guard has to hold forever rather than the states simply being distinct. Since the buyer side is status-agnostic (any non-active → 410), the migration is the entire cost. Also accepted: annotate the stale WISHLIST "enum cleanup — drop `in_use`/`completed`" entry (2026-05-18), which the seller-link work already invalidated.

**Q2 (binding mechanism).** ✅ **Accept: follow-up UPDATE.** The reviewer's reason is sharper than mine and changes the risk assessment: a `p_link_id` **with a DEFAULT creates a new overload**, which *is* the 018/019 ambiguity class rather than merely adjacent to it. Also accepted: after the repoint the throwaway link has no dependents (`transactions.link_id` already points at the real link), so delete it in the same path — which resolves the orphan-row objection §2.5 raised against this route. And the decoupling follows: the UPDATE route never touches the RPC body, so the rescued `is_test` draft migration lands independently (re-verify 025 is still canonical, renumber) rather than being bundled.

**Q3 (price cap).** ✅ **Accept**, and the AK/HI case is a good catch — a heavy parcel can price entirely above the $200 platform ceiling, yielding zero rates. PR4's reworded message will cover the platform-cap cause alongside the seller-filter cause, so neither one blames the buyer's address.

**Q4 (50-row cap).** ✅ **Accept: defer the cap, hide the dead link.** Rendering "View all N shipments" against a stubbed filter on a brand-new surface is worse than omitting it, and N undercounts anyway since children derive from the 50-row window.

**Q5.** Closed by N5 above.

### Predicted pitfalls

**1 (PR11 re-triggers the overload class).** ✅ **Accept.** The Q2 amendment removes the overload risk specifically, but the UPDATE route still edits the buy path shared by all three link types. The three-type regression pass becomes non-negotiable, and §4 gains integration assertions that a flex buy and a full-label buy still persist a `shipments` row.

**2 (PR6 guards become load-bearing out of order).** ✅ **Accept — best finding in this section.** The proposal states the ordering but nothing enforces it, and "remembered" ordering is precisely how the drift class the protocol names actually happens. PR6 gains an integration test that fails if the webhook can flip a `seller_link` to `completed`, and one for the cancel-label revival — so the PR11 dependency is mechanical rather than a note.

**3 (PR14 flips from a stale model).** ✅ **Accept** — same as B2; the rewrite is the mitigation.

**4 (the band ages into a bait-and-switch).** ✅ **Accept the risk. Amending the mitigation.**

The staleness label is accepted as-is: PR10 will render "typically $X–$Y", store `est_computed_at`, and the three-ZIP spread will be documented as excluding AK/HI (with the buyer-facing copy from Q3 covering the over-ceiling case).

**Amendment on the recompute path.** The suggested "recompute on first GET after N days" puts three EasyPost calls and a write on the anonymous GET — which is the exact path the band exists to keep free of per-viewer upstream cost, and by N2's own finding that GET is also called server-side by middleware on every `/s/` hit, so a social crawler could trigger the recompute. Proposing instead: recompute from the existing cron infrastructure ([reconciliation-sweep](../supabase/functions/reconciliation-sweep/index.ts), registered in [migration 036](../supabase/migrations/036_register_cron_sweeps.sql)), sweeping active seller links whose `est_computed_at` is older than N days. Same freshness guarantee, bounded and predictable cost, no write on a hot anonymous read. If the reviewer sees a reason the sweep can't cover it, the lazy path is the fallback.

### Nits

✅ **All accepted**, applied on the next body edit: the drifted line refs (`:1756`, `:1829`, `:975`, `api.ts:915`/`:918-924`, `rates:9` declaration vs `:421-423` use, `Dashboard.tsx:430` for the filter); quoting `p_user_id` in full with its fallbacks; routing LinksTab and Admin through one shared label map (they default to *opposite* wrong labels, which is a nice illustration of why the map should be shared); citing the `allLinks` query when making the orphan-card claim so a reader can check it; and the stale `featureFlags.ts:19` comment — same class as the `:1041` find, and worth fixing precisely because this proposal warns about stale comments in this area.

### What remains open

One item: **B2's current production env values**, which need John. Everything else is accepted or amended above and will be applied to the body in a single revision pass, after which status moves to `revised`.

Two amendments are proposed back to the reviewer rather than settled: **B3's mechanism** (gate on the cancel token rather than exempting admin) and **Pitfall 4's recompute path** (cron sweep rather than lazy-on-GET). Neither blocks the body revision; both change a handful of lines if the reviewer disagrees.

## Review — Round 2

```
reviewer:    same reviewer session as Round 1
reviewed_at: 2026-08-29
verdict:     approve (both amendments accepted; convergence reached)
```

Both amendments are accepted as **better than the suggested fixes**, not merely equivalent:

- **B3 mechanism — accepted.** `can_print = !(isSellerSale && viewerHoldsValidCancelToken)` gates on the credential that actually identifies the buyer. Checked against every viewer shape: buyer-with-token → hidden (goal); buyer-without-token → `anonymous` → visible (the already-accepted curtain limitation, same under either formula); seller signed-in (`sender_flex`) and seller-from-email (`anonymous`) → visible; admin-without-token → visible (fixes the Round-1 (a) defect with no special case). The only shape that differs from my suggestion is an admin who *also* presents the buyer's cancel token — a vanishing edge that behaves acceptably (they can use their admin session without the token). One term, says what it means.
- **Pitfall 4 recompute — accepted.** The lazy-on-GET suggestion was wrong by the proposal's own N2 finding: it puts three EasyPost calls and a write on the anonymous GET that middleware calls server-side on every `/s/` hit, so crawlers could trigger recomputes. The cron-sweep route has the same freshness bound at predictable cost. One implementation note: sweep only `status='active'` seller links (a closed/sold link needs no fresh band), and reuse the sweep's existing cursor/idempotency conventions rather than inventing new state.

No open disagreements remain between author and reviewer. The single open item is **B2's env read (John)**, which gates only PR14 — the last PR — so implementation of PR1–PR13 can proceed.

## Decision

```
decided_by:  John
decided_at:  2026-08-29
outcome:     approved — build
```

John directed implementation on 2026-08-29 ("review updates to the proposal, then plan then build this feature") after the author response and Round-2 convergence. All review findings and both author amendments are folded in as the design of record. **PR14 remains gated on John supplying the current production env values** (`SENDMO_LIVE_DEFAULT`, `PAYMENTS_LIVE_ALLOWLIST_ONLY`, `PAYMENTS_ALLOWED_USERS`, `VITE_ENABLE_SELLER_LINK` — `npx supabase secrets list --project-ref fkxykvzsqdjzhurntgah` + the Vercel env) before it is written as steps; PR1–PR13 proceed without it.
