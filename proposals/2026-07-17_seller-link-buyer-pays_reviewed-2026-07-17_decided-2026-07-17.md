---
title: Seller Link — a buyer-pays shipping link (the third shipment type)
slug: seller-link-buyer-pays
project: sendmo
status: decided
blocked_on: null
created: 2026-07-17
last_updated: 2026-07-18
reviewed: 2026-07-17
decided: 2026-07-17
executed: null
pr: null
author: Claude Opus 4.8 — drafted from John's request (a third option on /onboarding) plus forwarded eBay-seller feedback. Grounded against the live schema (migrations 001, 020) and three decided proposals (account-creation-timing, sender-flow-wizard, flex pattern-d).
reviewer: Fresh Claude Opus 4.8 review session — verified against live migrations (001/017/020/025), the four cited edge functions (rates/labels/payments/stripe-webhook + cancel-label/tracking), and all four cited decided proposals
outcome: approve-with-changes
---

> **What this is in one line:** a third kind of SendMo shipment where the **seller** creates a link with the package already specced, and the **buyer** clicks it, enters their address, picks a speed, and **pays** — the mirror of today's recipient-pays flex link. This is the first time in SendMo that someone other than the account holder pays.

## 1. Context

### 1.1 What John is asking for

An eBay seller's feedback (forwarded 2026-07-17) argued SendMo is "incredibly buyer-focused" and that sellers — who ship constantly and are price-conscious — are the bigger, stickier audience. John's concrete instruction: add **a third option on the `/onboarding` fork** (today two cards: "Flexible Prepaid Shipping Link" and "Completed Prepaid Label") that lets a **seller** create a link the **buyer** pays for. And he asked me to think hard about whether one card can cover both a private 1:1 sale and a public marketplace listing.

The seller's stated needs, in their words: **cost**, **making sure the right item goes with the right label**, and **easy payment / card on file**.

### 1.2 The two things the seller's feedback conflated — and which one this is

The feedback actually described **two different products**, split by *who pays*:

| | Who pays | When | This proposal? |
|---|---|---|---|
| **Buyer-pays seller link** | Buyer | At/before the sale (no platform collected shipping) | **✅ Yes — this doc** |
| **Seller-pays label tool** (eBay/Pirate Ship style: import the sold order, print a cheap label + packing slip, card on file) | Seller | After the sale (buyer already paid eBay) | ❌ No — separate future proposal |

They serve different moments. The buyer-pays link wins the **off-platform social seller** — Facebook Marketplace, Craigslist, Instagram/TikTok "DM to buy" — where no platform collected shipping and the buyer genuinely needs to pay it at a link. The seller-pays tool wins the **established eBay seller**, whose buyer already paid shipping through eBay and whose address eBay already has; sending that buyer to an external link to pay again makes no sense. **This proposal is the first one only.** The seller-pays tool (with marketplace-API order import) is real and worth doing, but it's a bigger, separate bet and is out of scope here (§5).

### 1.3 What exists today (verified against the schema + decided proposals)

SendMo has two shipment types, and **both are recipient-pays**:

- **Full Prepaid Label** — the recipient knows everything, pays immediately, gets a finished label. `link_type='full_label'`.
- **Flexible Link** — the recipient sets preferences + saves a card, shares `sendmo.co/s/<code>`, and anonymous senders fill in the details later; the recipient's saved card is charged **off-session** per shipment (Pattern D, decided 2026-05-16). `link_type='flexible'`.

Key facts that shape this design (all verified, not assumed):

- **The link table assumes the creator is the recipient.** `sendmo_links.recipient_address_id` is `NOT NULL` ([001_initial_schema.sql:57](../supabase/migrations/001_initial_schema.sql)) — the destination is known at creation because the recipient made the link. A seller link inverts this: the **origin** is known, the destination isn't. This is the single biggest schema consequence (§2.4).
- **`link_type` only allows two values today** — `CHECK (link_type IN ('full_label','flexible'))` ([001:53](../supabase/migrations/001_initial_schema.sql)), never altered since. A third value needs a migration.
- **All money moves off-session** against a saved recipient card. There is **no on-session, cardholder-present checkout** anywhere in the live code (confirmed via the pattern-d proposal and the payments/labels functions). The buyer paying live at a link is a genuinely new payment surface.
- **The buyer's email is not stored on a shipment today.** `shipments` has no `recipient_email` column; it's resolved server-side from the link owner's profile. A stranger-buyer's email is new data we'd capture and persist.
- **Anonymous parties are already a supported, decided pattern.** Senders on flex links never have accounts (SPEC §17; sender-flow-wizard decided 2026-05-11). The `/s/:shortCode` wizard ([src/pages/SenderFlow.tsx](../src/pages/SenderFlow.tsx)) and the stable per-label page `/t/:public_code` already exist.

### 1.4 The honest win (and the one hard part)

**Most of this assembles from parts that already exist:** the Guesstimator, the origin/package form, `FlexPreferencesForm` (carrier/speed), the rate picker, the EasyPost buy path in [labels/index.ts](../supabase/functions/labels/index.ts), the 15%+$1 markup engine in [rates/index.ts](../supabase/functions/rates/index.ts), the `/s/:shortCode` wizard shell, the `/t/:public_code` tracking/return page, tracking, refunds/void, and the confirmation emails.

**The one genuinely new build is an on-session buyer checkout** (Stripe Payment Element, cardholder present, no saved card). Everything else is inverting who-creates / who-pays and wiring a new `link_type` through paths that already branch on it. I'm not going to oversell it as trivial — the checkout, the origin-on-link schema change, and the money-attribution question (§2.5) are real work — but there is no new carrier integration, no new marketplace API, and no new label pipeline.

## 2. Architecture

### 2.1 The core inversion

Everything follows from flipping two things at once: **who creates the link** and **who pays**.

| | Flexible link (today) | **Seller link (new)** |
|---|---|---|
| Creator = account holder | Recipient (receives package) | **Seller (ships package)** |
| Knows at creation | Destination + preferences | **Origin + full package** |
| Filled in later, by whom | Origin + package, by the sender | **Destination, by the buyer** |
| Who pays | Recipient, **off-session** saved card | **Buyer, on-session** at checkout |
| Counterparty account | Sender: none (anonymous) | **Buyer: none (anonymous)** |

Note the buyer maps onto the existing **anonymous sender** role, not the recipient role — they're a one-off, accountless party. That single observation resolves most of the account/payment questions below.

```
SELLER (has an account, has the box)                 BUYER (stranger, has the address)
┌──────────────────────────────────┐                ┌────────────────────────────────────┐
│ /onboarding → "Sell & Ship" card │                │ opens sendmo.co/s/<code>            │
│ • enters origin address           │   share link   │ • enters destination address        │
│ • Guesstimator → size/weight      │ ─────────────▶ │ • sees LIVE rates (origin+box+dest) │
│ • (advanced) limit carriers       │  in a listing  │ • picks speed                        │
│ • single-use or reusable?         │  or 1:1 to     │ • PAYS on-session (Payment Element) │
└──────────────────────────────────┘  the buyer     └───────────────┬────────────────────┘
                                                                     │ payment succeeds
                    ┌────────────────────────────────────────────────▼─────────────────┐
                    │ EasyPost buy (reuses labels/) → label to SELLER (email+dashboard) │
                    │ buyer → receipt + tracking email + /t/<public_code> page          │
                    │ transactions.charge ledger row (attribution: §2.5)                │
                    └────────────────────────────────────────────────────────────────────┘
```

The rate math works because rates need origin + package + destination: the seller supplies the first two at creation, the buyer supplies the third, and rates are shopped **after** the buyer enters their address — exactly when the existing `rates` function can run.

### 2.2 Is a single third card on /onboarding right? (the question John asked me to pressure-test)

**My answer: yes to one entry point; no to making it a visually-identical peer of the two recipient cards under the current heading — that framing is subtly wrong and will confuse people on the who-pays axis.**

Here's the reasoning. The current page's hidden frame is *"Someone is shipping something **to you**. **You** pay. How much do you already know?"* All three of those are true for both existing cards. The seller link breaks **all three**: you're shipping **out**, the **buyer** pays, and the word **"prepaid"** (which means the recipient paid in advance) is actively wrong for it. Drop a third card that silently flips the frame next to two that share it, and a scanning user won't clock the difference — they'll think it's a third flavor of "someone ships to me."

So the recommendation is **structural yes, framing fix required**:

- Keep it to **one page, three cards** — don't add a whole "are you buying or selling?" step ahead of it. ~95% of today's traffic is recipients; a new upstream fork taxes them to serve a new bet. (This is also why /onboarding beats the dashboard, which the WISHLIST originally suggested — a new seller who's never heard of SendMo has to *see* the option to adopt it; burying it in a logged-in dashboard defeats the acquisition goal.)
- **Reframe the page heading** from "How should we set up your prepaid shipment?" to something intent-neutral like **"How do you want to ship?"** so it no longer presumes recipient-pays.
- Give the seller card **copy that makes the flip unmistakable.** Draft, mirroring the two cards John screenshotted:

  > **Sell & Ship — buyer pays**
  > *Post a link — the buyer pays for shipping*
  > **Best when…** you're **selling** an item · you want the **buyer** to pay shipping
  > **How it works:** ① You enter your address + package size/weight. ② Share your link — in a listing or straight to the buyer. ③ Buyer enters their address, picks a speed, and pays — you print the label.
  > **What the buyer does:** Opens your link, enters their address, picks a speed, and pays. No account needed.

The exact heading + card treatment is a judgment call on John's front door, so it's **Open Question 1**. But "one card, reframed page" is the recommendation.

### 2.3 "Flexible vs non-flexible seller links" → the axis is actually single-use vs reusable

John asked whether one option can enable "flexible and non-flexible seller links." Digging in, **the flexible/completed axis doesn't apply to seller links the way it does to recipient links.** On the current page, flexible-vs-completed means *"who fills in the missing details — you or the other party?"* A seller link is **always** on the "other party" side, because the buyer always supplies their own destination (the seller can't know who will buy, especially on a public listing). There is no "completed seller link" in that sense — if the seller already knew the buyer's address, they wouldn't need a link at all.

So a seller link is **inherently the flexible pattern**. Its real, meaningful sub-variation is **single-use vs reusable**, which lines up with John's two circumstances:

| Circumstance | Shipping one item or many? | Link behavior |
|---|---|---|
| 1:1 private sale | One, to one known buyer | **Single-use** — closes after the first paid label |
| Public listing, unique item (one couch) | One, seen by many | **Single-use** — many view, one buys, then sold |
| Public listing, multiples (a shop) | Many identical | **Reusable** — each buyer spawns a child shipment |

Two consequences:

- **Reusable is already built** — it's the flex-link primitive (one link, many child shipments). A reusable seller link is that mechanic, seller-initiated. Single-use just closes the link after the first successful buy (reuse `status='used'`, already a valid value).
- **Public single-use has one edge case 1:1 doesn't:** two buyers paying at once for the one couch → two paid labels. Handle it the cheap way (§2.7).

So John's instinct — "one option enables both" — is **right**: one card, one flow, one internal toggle. The toggle is single-use vs reusable, not flexible vs completed. And for v1 the **seller always specs the package** (they hold the box); a future "seller leaves the box loose, finalize later" variant carries real money-reconciliation complexity and is out of scope (§5).

### 2.4 Data model changes

All additive; existing rows and both existing `link_type`s are untouched.

**`sendmo_links`:**
- **`link_type`** — drop and re-add the CHECK to include `'seller_link'`. (Recommend `seller_link` over the WISHLIST's `seller_marketplace` — it isn't marketplace-specific; it covers 1:1 too.)
- **`origin_address_id UUID NULL REFERENCES addresses(id)`** — the seller's from-address, known at creation. New because today the only address FK on a link is `recipient_address_id`, which means *destination*.
- **Relax `recipient_address_id` to nullable**, guarded by a role-aware CHECK: `NOT NULL` for `full_label`/`flexible` (unchanged behavior), nullable for `seller_link` (destination unknown until the buyer completes). This is the single most delicate change — it touches a NOT NULL on the core table — and wants careful review (OQ2).
- **Package columns** `pkg_weight_oz`, `pkg_length_in`, `pkg_width_in`, `pkg_height_in` (all `NUMERIC NULL`) — the seller's specced box, filled by the Guesstimator. Mirrors the discrete columns already on `shipments` (Rule 6: extend the existing pattern rather than invent a JSON blob).
- **`max_shipments INTEGER NULL`** — `1` = single-use, `NULL` = reusable. Drives the close-on-first-buy logic.
- Reused as-is: `preferred_carrier`/`preferred_speed` (the seller's optional carrier constraint), `short_code`, `status`, `is_test`.

**`shipments`:**
- **`buyer_email TEXT NULL`** — captured at checkout (new; no equivalent exists today). Needed for the receipt/tracking email and the optional claim.
- **`recipient_user_id UUID NULL REFERENCES profiles(id)`** — normally null; set only if a buyer later claims the shipment under a verified email (§2.6). Plus an RLS SELECT policy `USING (auth.uid() = recipient_user_id)`.
- The buyer's destination lands on the existing `shipments.recipient_address_id` (NOT NULL — satisfied at buy time); the seller's origin is copied to `shipments.sender_address_id` from `link.origin_address_id`. Owner `shipments.user_id` = the **seller** (link owner), consistent with how a flex child shipment is owned by the link owner.

### 2.5 Payment: the one new surface

A new **on-session buyer checkout**. Recommend a dedicated edge function `seller-checkout/` (rather than overloading `payments/`, which is the recipient full-label path) that:

1. Server-derives the price from the buyer's chosen rate through the existing markup engine (never trusts a client price — same discipline as today).
2. Creates a Stripe **PaymentIntent** with `capture_method='automatic'`, **Payment Element**, cardholder present, **no saved card and no Customer required** (the buyer is a stranger). This is CIT, the opposite of Pattern D's off-session MIT.
3. On `payment_intent.succeeded` (via the existing stripe-webhook): buy the EasyPost label through the **reused** labels buy path, write the `shipments` row (owner = seller), write a `transactions.charge` ledger row, fire emails, and — if single-use — flip the link to `status='used'`.

**Open question on the ledger (OQ3):** the append-only `transactions` ledger (Rule 16) has `user_id NOT NULL REFERENCES profiles(id)`, but the payer (buyer) has no profile. Recommendation: anchor the charge row to the **seller** as merchant-of-record (keeps the shipment and its charge under one account for admin reconciliation), with `buyer_email` as metadata. Alternatives: the system user, or a lazily-created buyer profile (rejected — pollutes `auth.users` with a row per stranger). Wants the reviewer's read.

**Chargeback note (not solved in v1):** the buyer pays with their own card on-session, so a dispute after the seller has printed and shipped is a normal Stripe dispute with SendMo as merchant of record — bounded to the shipping cost, not the goods. Flag, don't build for it in v1.

### 2.6 How the buyer manages their purchase — reconciled with a decided proposal

**Product invariant (John, 2026-07-17):** *any payer always needs a way to manage their purchase.* The buyer is the payer here, so the whole model holds exactly as long as the buyer can not just **see** but **manage** what they paid for — track it, and cancel/refund or get help if it goes wrong. This needs **no account**, because SendMo already has an accountless management path (below).

John asked that the buyer be able to return and see the shipment, and I told him two turns ago "guest checkout + claim-on-verified-email works." **Reading the decided `account-creation-timing` proposal corrected that.** That proposal chose Pattern A (create the account via OTP *before* payment) for recipients and **explicitly rejected its Pattern C — "claim this shipment later"** — as low-adoption ("assumes the user has a reason to claim it... adoption would be very low"). I shouldn't quietly re-introduce a rejected pattern as the headline.

The clean reconciliation: **the buyer isn't a recipient; they're a one-off payer, like the anonymous sender the decided proposals already bless.** So:

- **Primary (already built, no account):** the buyer gets the **confirmation + tracking emails**, the stable **`/t/:public_code` page**, and — crucially for the invariant — the **tokenized manage/cancel link** `/t/:public_code?cancel=<token>` in their receipt email. `shipments.cancel_token` already exists ([020_cancel_token_and_link_lifecycle.sql:35](../supabase/migrations/020_cancel_token_and_link_lifecycle.sql)), and the tokenized-cancel pattern for an accountless party is already **decided and shipped** (label-cancel-and-change §2.3/§3.2; delivered for the flex sender in flex-sender-visibility). So the buyer can **track *and* cancel/refund** from their inbox with no account and no OTP friction — exactly the invariant above, and the same management surface every anonymous sender already gets.
- **Optional (additive, explicitly low-adoption):** *if* the buyer already has or later creates a SendMo account with the **same Supabase-verified email**, an idempotent backfill attaches matching shipments (`SET recipient_user_id = <uid> WHERE buyer_email = <verified email> AND recipient_user_id IS NULL`). Safe because Supabase guarantees the email is verified; never attach on a typed string. This is a nice-to-have for buyers who are also SendMo users — not the way the feature earns its keep.

The **seller**, by contrast, is the account holder and goes through the normal Pattern-A OTP when creating the link — fully consistent with the decided proposal.

This is a better answer than my first one, and it's why the proposal leads with "no account needed" on the buyer card.

### 2.7 Concurrency on public single-use links

Two buyers hit checkout at the same moment for the one couch. Cheapest correct answer, reusing machinery that exists: **accept both payments, auto-void/refund the loser** with an honest "just sold" message, using the existing refund/void path ([refundService.ts](../src/lib/refundService.ts) + the labels void path). A soft reservation lock is the fancier option and isn't worth it for used-goods volume in v1. Whichever buy first flips the link to `status='used'` wins; the second sees the closed-link state.

## 3. File-by-file plan

**Migrations (new, additive):**
- `0NN_seller_link_schema.sql` — the `link_type` CHECK swap; `sendmo_links.origin_address_id`, package columns, `max_shipments`, and the role-aware `recipient_address_id` CHECK relaxation; `shipments.buyer_email`, `shipments.recipient_user_id` + its RLS SELECT policy. Follows the `ADD COLUMN IF NOT EXISTS` idempotent convention used across 002–024.

**Edge functions:**
- `seller-checkout/index.ts` **(new)** — creates the on-session PaymentIntent (Payment Element) for the buyer's server-derived rate; no saved card/Customer.
- [rates/index.ts](../supabase/functions/rates/index.ts) — feed origin+package from the link and destination from the buyer; **enforce the seller's carrier constraint server-side** (don't just hide options client-side).
- [labels/index.ts](../supabase/functions/labels/index.ts) — reuse the buy path on the seller-link branch; owner = `link.user_id`, `buyer_email` persisted, origin copied from `link.origin_address_id`.
- [stripe-webhook/index.ts](../supabase/functions/stripe-webhook/index.ts) — on success for a seller-link PI, trigger the buy + ledger row + `status='used'` close (single-use) + emails.

**Frontend:**
- `/onboarding` fork — add the third card + reframed heading (§2.2). Likely [src/pages/](../src/pages/) onboarding component + the card list.
- **Seller link builder** — reuse the Guesstimator, an origin-address form, `FlexPreferencesForm` (as the optional advanced carrier constraint), and a single-use/reusable toggle. Creates a `seller_link` row, returns `sendmo.co/s/<code>`, shows the share/copy affordances.
- **Buyer completion at `/s/:shortCode`** — reuse the [SenderFlow.tsx](../src/pages/SenderFlow.tsx) wizard shell, but the final step is an **on-session Payment Element checkout** instead of the sender's free "confirm." Detect seller-link vs flex by `link_type` (the same join the sender flow already does: `short_code → link`).
- **Seller dashboard** — the seller's link shows its child shipment(s) + label PDF(s); reuse existing link/shipment list components.
- **Buyer post-pay** — reuse `/t/:public_code` as the return page; receipt email carries that link.

**Emails:** reuse the label-confirmation (to seller) + tracking templates; add a buyer receipt variant ([_shared/email-templates.ts](../supabase/functions/_shared/email-templates.ts)).

## 4. Test plan

- **Unit:** rate derivation with origin+package from link and destination from buyer; server-side carrier-constraint enforcement (a buyer cannot select a filtered-out carrier); single-use close logic; the idempotent claim backfill (`AND recipient_user_id IS NULL`).
- **Integration:** seller-checkout PI success → EasyPost buy → shipment(owner=seller, buyer_email set) → `transactions.charge` written once (idempotent on the webhook event id) → link closes if single-use. Decline → no label, link stays open. Concurrent double-buy on a single-use link → one label kept, one auto-refunded, link `used`.
- **e2e (Playwright, per TESTING.md):** a new spec covering create-seller-link → open `/s/<code>` as an anonymous buyer → pay with a Stripe test card → seller sees label, buyer sees `/t/<public_code>`. Cover both single-use (link closes) and reusable (second buyer spawns a second shipment) variants.
- **Browser-verify (PLAYBOOK Rule 19):** real end-to-end in a browser before the LOG entry.

## 5. Out of scope (explicit non-goals)

- **The seller-pays label tool + marketplace-API order import** (eBay/Pirate Ship style: pull the sold order, print label + packing slip, card on file). This is the *other* half of the seller feedback (§1.2) and its own future proposal.
- **"Seller covers shipping" toggle** — v1 is pure buyer-pays. Additive later.
- **"Seller leaves the package loose, finalize later" (a truly flexible seller link)** — real money-reconciliation complexity; deferred.
- **Inventory / quantity management** beyond a simple single-use vs reusable flag.
- **Saved cards for buyers / one-click repeat buying** — buyers are strangers in v1; the saved-card seller experience belongs to the seller-pays tool.

## 6. Verification (run after implementation)

1. As a seller, go to `/onboarding` → the third card is present and its copy makes clear the *buyer* pays. Create a single-use seller link (origin + Guesstimator package + USPS-only constraint). Get `sendmo.co/s/<code>`.
2. In an anonymous browser, open the link → see the item/preview, enter a destination, confirm rates are USPS-only, pick a speed, pay with a Stripe test card.
3. Confirm: seller receives the label (email + dashboard); buyer lands on `/t/<public_code>` and gets a receipt + tracking email; `transactions` has exactly one charge row; the link now reads closed/`used`.
4. Create a **reusable** link; run two buyers through it → two independent child shipments, link stays open.
5. Simulate concurrent buys on a **single-use** link → one label survives, the other auto-refunds, link is `used`.
6. **Buyer management (the invariant):** from the receipt email, the buyer opens `/t/<public_code>?cancel=<token>` and can cancel/refund with no account — confirm a wrong token is rejected.
7. Optional-claim path: the buyer signs up later with the same email → the shipment appears in their dashboard; a *different* email does not.

## 7. Open questions (for the reviewer and John)

1. **/onboarding framing (John's call).** One card + reframed intent-neutral heading (my rec), vs. a literal third peer under the current "prepaid shipment" heading, vs. an upstream "buying or selling?" split. I argue against the last two (§2.2) — but it's his front door.
2. **The `recipient_address_id` NOT NULL relaxation (reviewer).** Is a role-aware CHECK the right move, or is there a cleaner shape (e.g. a separate seller-link table) that avoids loosening a constraint on the core `sendmo_links` table? This is the change most likely to have blast radius.
3. **Ledger attribution for a buyer-paid charge (reviewer).** Anchor the `transactions.charge` to the seller as merchant-of-record (my rec), the system user, or something else? Rule 16 says append-only with `user_id NOT NULL`.
4. **Is on-session checkout worth a new function, or should it extend `payments/`?** I lean new (`seller-checkout/`) to keep the recipient path clean, but open to reuse.
5. **Naming:** `link_type='seller_link'` (my rec) vs the WISHLIST's `seller_marketplace`.
6. **(Added post-review) Can a seller unilaterally cancel + refund the buyer's paid label?** The owner-JWT cancel path exists today ([cancel-label/index.ts:156](../supabase/functions/cancel-label/index.ts)); for a seller link that means the seller could refund a charge the *buyer* made. Recommend **yes, with mandatory buyer notification** — a seller who can't fulfill must be able to refund the buyer — but it's a governance call with no prior decision. (Surfaced by the review, B3.)

## Reconciliation with prior decided proposals

- **`2026-05-11_account-creation-timing` (decided).** It chose Pattern A and **rejected Pattern C (claim-later)** for recipients. This proposal does **not** revive Pattern C as the buyer's primary path: the buyer is treated as an anonymous one-off payer (the pattern that proposal *does* bless for senders), gets tracking+emails with no account, and the claim exists only as an optional, acknowledged-low-adoption add-on for buyers who are also SendMo users (§2.6). The **seller** uses Pattern A OTP unchanged.
- **`2026-05-11_sender-flow-wizard` (decided).** The buyer completion flow **reuses** the decided `/s/:shortCode` wizard shell and the `/t/:public_code` return page; the only divergence is a paid final step instead of the sender's free confirm. The viewer-role detection (`public_code → link.user_id` vs `auth.getUser()`) that proposal established is reused to tell seller from buyer.
- **`2026-05-16_flex-payment-pattern-d-execution` (decided).** Pattern D is off-session MIT against a saved recipient card. The seller link is the **complement, not a contradiction**: on-session CIT for a card-present stranger. It adds a payment surface; it doesn't change Pattern D.
- **`2026-05-11_label-cancel-and-change` (decided).** The buyer's accountless manage/cancel path (§2.6) reuses this proposal's decided tokenized `/t/<code>?cancel=<token>` mechanism and the `shipments.cancel_token` column (migration 020) — satisfying John's "the payer can always manage their purchase" invariant without an account, rather than inventing a new management surface.

## Reconciliation with the WISHLIST entry

This supersedes **WISHLIST.md → "Seller Marketplace Link (buyer-pays variant)"** (Phase 2). Adopted from it: the buyer-pays inversion, the reuse list, the "share into a listing" use case, and the Payment-Element (not off-session) call. Diverges from it in three ways this proposal argues are corrections: (a) **the seller specs the package**, not the buyer (the buyer never has the box); (b) the real toggle is **single-use vs reusable**, not flexible-vs-completed; (c) it names the **`recipient_address_id` NOT NULL blocker** the WISHLIST didn't catch. The WISHLIST entry will be annotated to point here.

---

## Review

```
reviewer:    Fresh Claude Opus 4.8 session — loaded cold; verified every schema/reuse claim against live migrations (001/017/020/025), the cited edge functions (rates, labels, payments, stripe-webhook, cancel-label, tracking), and all four cited decided proposals in full
reviewed_at: 2026-07-17
verdict:     needs-info
```

### Summary

The *problem framing* is excellent and the *scope cut* (buyer-pays vs the separate seller-pays/marketplace-import tool) is the right call, honestly argued. But the *Architecture* section makes several claims that don't survive contact with the live code: one relies on a status value that no longer exists and would crash at runtime (B1); the "reuse the stripe-webhook to buy on success" flow is a new inversion, not reuse, and is the wrong shape for an on-session buyer (B2); and the headline "buyer manages via token" invariant does **not** hold as-shipped because refunds/receipts/emails are hardcoded to the link owner, whom the seller link explicitly is *not* (B3). None of these kill the feature — it's worth doing and mostly assembles from real parts — but they change the design materially, so this needs a revised architecture + John's calls on OQ2/OQ3 before implementation. Verdict is **needs-info** (endorse the direction; not yet greenlightable); I'd move to approve-with-changes once B1–B5 are addressed.

### Blocking issues

**B1 — `status='used'` is not a valid link status; it will throw a CHECK violation on the first single-use close.**
- *Location:* §2.3 ("reuse `status='used'`, already a valid value"), §2.5 pt 3, the §2.1 ASCII diagram, §3 ("`status='used'` close"), and the Reconciliation/WISHLIST notes.
- *Issue:* Migration [020](../supabase/migrations/020_cancel_token_and_link_lifecycle.sql) (lines 43–55) **renamed `'used'` → `'in_use'`** and the live constraint is `CHECK (status IN ('draft','active','in_use','completed','expired','cancelled'))`. `'used'` was deleted, and migration 020 even runs `UPDATE … SET status='in_use' WHERE status='used'`. The latest `admin_insert_shipment` RPC (migration [025](../supabase/migrations/025_admin_insert_shipment_phone.sql):129) mints full-label links at `'in_use'`. Every `'used'` literals still in the tree (migrations 004–019) is a *superseded* RPC body. An `UPDATE … SET status='used'` on the seller-link close would fail `sendmo_links_status_check`. The proposal asserting it's "already a valid value" is the single clearest factual error.
- *Suggested fix:* Use `'in_use'` (present-tense "shipment in flight" — exactly the state the full-label RPC uses after a same-sitting buy) or add a new explicit terminal value via migration. Correct all five references. Bonus: closing to `in_use`/`completed` also drops the link out of the `status='active'` public-read RLS ([001](../supabase/migrations/001_initial_schema.sql):223) — which is the desired "closed link" behavior, so `in_use` is consistent.

**B2 — "On `payment_intent.succeeded` the stripe-webhook buys the label" is a new inversion, not reuse, and is the wrong shape for an on-session buyer.**
- *Location:* §2.5 pt 3, §2.1 diagram, §3 (stripe-webhook bullet).
- *Issue:* Verified: the webhook's `payment_intent.succeeded` arm ([stripe-webhook/index.ts:215–345](../supabase/functions/stripe-webhook/index.ts)) only UPSERTs `stripe_intents` and writes the `charge`/`fee_stripe` ledger rows — it explicitly does **not** buy a label or flip link status (comment lines 330–336). Today the buy is *always* triggered synchronously by the `labels/` function: client-triggered for full-label (client confirms the PI, then POSTs to `labels/` with the verified PI), inline for flex. Moving the buy into the webhook (a) loses the synchronous buy-time-rate-gate UX — SPEC §13.6 returns HTTP 409 `rate_changed` → `RateChangedDialog` so the client can re-shop; a webhook has no client to 409 to; (b) forces the present, waiting on-session buyer to poll for an async result; (c) creates a **double-buy risk** — Stripe retries webhooks on any non-2xx/timeout and EasyPost `/buy` is not idempotent.
- *Suggested fix:* Mirror the existing on-session full-label flow — create the PI in the checkout fn, confirm the Payment Element on-session, then have the **client** call `labels/` with the verified PI for a synchronous buy + rate-gate + single-use close. This is *less* work and reuses the real pattern; the webhook keeps its existing ledger-only job. (This is also the correct analog: the seller-link buyer is a full-label-style on-session payer, not a flex off-session recipient.)

**B3 — The "buyer manages via token" invariant (§2.6) does NOT hold as-shipped; refund emails, the `/t/` receipt, and the −refund ledger row are hardcoded to `link.user_id`.**
- *Location:* §2.6 ("the buyer can track *and* cancel/refund from their inbox… exactly the invariant"), and the label-cancel reconciliation.
- *Issue:* The refund *money* is safe — Stripe refunds to the PI's own source, so the buyer's card is correctly refunded. But everything *around* it assumes payer == link owner. Verified in shipped code: [cancel-label/index.ts:449](../supabase/functions/cancel-label/index.ts) — `// Full-label: payer is the link owner (recipient).` — resolves the refund-submitted email recipient from the link owner's profile; PAYMENTS.md §12 confirms Email A/B/C all resolve to `sendmo_links.user_id → profiles.email`; [tracking/index.ts](../supabase/functions/tracking/index.ts) gates the receipt block on `viewerRole === "payer"` where "payer" == link owner and classifies a cancel-token holder as `sender_flex` (explicitly denied the receipt). For a seller link: the **seller** receives the refund emails and a receipt for a charge they never made, while the **buyer** (token holder) gets no notification and can't see their own amount-paid/last4. Worse, the token is minted+emailed to `sender_email` today and `buyer_email` doesn't exist, so the buyer never receives the cancel link at all. Also: `cancel-label` only revives `in_use → active` (line 571), so a single-use seller link closed to a terminal state wouldn't revive on cancel; and the seller can unilaterally cancel/refund the buyer's paid label via the owner-JWT path (line 156) — a governance question with no prior decision.
- *Suggested fix:* Own this as real design work, not reuse. Branch the payer-identity resolution in **both** `cancel-label/index.ts` and `tracking/index.ts` on `link_type` — resolve the payer from `buyer_email` for seller links vs `link.user_id` for recipient links — and make the `/t/` `viewerRole` treat the seller-link buyer (token holder) as the receipt-bearing payer. State that `flex-sender-visibility` is precedent only for *"an accountless party can trigger a cancel,"* not for *"the accountless payer is refunded, notified, and shown their receipt."*

**B4 — Client-price-trust risk on the brand-new on-session checkout; "same discipline as today" points at the wrong leg.**
- *Location:* §2.5 pt 1 ("never trusts a client price — same discipline as today").
- *Issue:* "Today" on the full-label leg ([payments/index.ts:188–191](../supabase/functions/payments/index.ts)) takes a client `amount_cents` with only a `>= 50` floor — that is exactly the **D1 launch-blocker** in the in-review [2026-07-06_money-path-review-fixes.md](2026-07-06_money-path-review-fixes.md) (pay 50¢, buy a $50 label). Only the *flex* leg server-derives price from the link cap. A seller-checkout that mirrors `payments/` inherits D1.
- *Suggested fix:* State explicitly that seller-checkout follows the **flex server-derive** discipline: the buyer picks an EasyPost `rate_id`, the server re-fetches that rate and applies the markup engine, the PI is created for the server-derived amount, and the buy-time gate runs on that amount — never a client-supplied price. Note D1's fix is still *in-review*, not confirmed deployed, so this can't lean on "the full-label leg is now safe."

**B5 — Server-side carrier-constraint enforcement must live at buy-time, not only in `rates/`.**
- *Location:* §3 (rates/ bullet: "enforce the seller's carrier constraint server-side").
- *Issue:* [rates/index.ts:94,366–368](../supabase/functions/rates/index.ts) takes `preferred_carrier` from the *client body* and filters on it. A buyer can skip the rate UI and call the buy path directly with any `easypost_rate_id`. Enforcing only in `rates/` is the same "each function assumes the other checked" class as D1/D2. (Lower money-severity — the buyer still pays the correct price for whatever carrier — but the proposal frames it as a guarantee.)
- *Suggested fix:* Resolve the seller's carrier/speed constraint from the **link row** server-side (the row is already fetched) in *both* `rates/` (UX) and the buy path (enforcement).

### Non-blocking concerns

**N1 — Ledger attribution (OQ3): seller-anchoring collides with `checkAccountBudget`.** The Account Budget (PAYMENTS.md §10.2) sums `transactions.charge` per user over 24h/7d. Anchoring buyer-paid charges to the seller means a shop doing >$200/day of *buyer* purchases trips the *seller's* budget and starts 402-ing real buyers, and per-user margin/velocity conflates merchant revenue with the seller's own spend. Fix alongside OQ3: exclude `txn_kind='cit_seller_link'` from `checkAccountBudget` (or don't call it on seller-checkout — it isn't the seller's spend). Note the webhook already falls back to the system UUID `…0001` when no `sendmo_user_id` is in PI metadata ([stripe-webhook:254](../supabase/functions/stripe-webhook/index.ts)), so a charge row always writes — this is purely an attribution choice, and `transactions.link_id` already lets you reconcile per-link without overloading `user_id`.

**N2 — `recipient_address_id` NOT NULL relaxation: ~15 join sites; mostly graceful, two need branches.** Verified references across Dashboard, LinksEdit, tracking, tracking-admin, admin-report, reconciliation-report, links, rates, labels, and the `admin_insert_shipment` RPC. Most are SELECT joins that tolerate NULL (render no destination — correct for a not-yet-completed seller link), but `links/index.ts:643` inserts `recipient_address_id` on create and needs a seller-link branch. The role-aware CHECK is workable and has design precedent (SPEC §12's original schema intended type-specific nullable columns on `sendmo_links`). The genuine tradeoff for John (OQ2): a **separate `seller_links` table** avoids overloading the core table with columns meaningful for only one type (`origin_address_id` + 4 package cols + `max_shipments`, all NULL for the other two) and the oddity of a `recipient_address_id` that's semantically meaningless for the type — at the cost of a second resolution path in `links`/`rates`/`labels`. I lean toward the additive-column approach (Rule 6) *if* the CHECK is airtight, but the semantic-overload cost is real. Either way, enumerate the ~15 sites in the file-by-file plan.

**N3 — Concurrency (§2.7): "accept both, auto-refund the loser" can leave BOTH labels surviving.** Under the webhook-buys design, two succeeded PIs → two webhook deliveries; if each buys before either flips status and the close is a plain `UPDATE SET status=…`, both labels get bought and nothing designates a "loser." Fix: gate the buy on an atomic transition — `UPDATE sendmo_links SET status='in_use' WHERE id=? AND status='active' RETURNING id` — only the winner proceeds. (Another argument for B2: a client-triggered synchronous buy is far easier to serialize than two independent webhook deliveries.)

**N4 — Seller-origin-address privacy.** Does opening a *public* seller link expose the seller's full origin street to any anonymous visitor? PLAYBOOK Rule 7 hides the recipient's address from senders; the mirror concern (a seller's home address on a public "DM to buy" link) isn't addressed. Rates only needs the origin resolved server-side (as the flex leg resolves `to_address`); don't return the seller's street to the buyer's client pre-purchase.

**N5 — `/onboarding` third card (OQ1): the read is correct; make the routing explicit.** Verified `RecipientStepPathChoice.tsx`: both current cards are recipient-pays under "How should we set up your prepaid shipment?", and both "What the sender does" blurbs say "No account needed" for the *sender* — a buyer-pays card does flip that frame, so the reframed heading + explicit copy is right. But the picker drives a binary `RecipientPath` (`"flexible" | "full_label"`) state machine threaded through `stepRouting.ts`, `RecipientFlowContext`, the progress bar, and the flow badge ([RecipientOnboarding.tsx:117–121](../src/pages/RecipientOnboarding.tsx)). "Add a third card" is clean only because the card should route to a **separate seller-builder flow**, not into the recipient state machine — say so.

### Nits

- Route param is **`:code`**, not `:public_code` (`App.tsx` `/t/:code`). The proposal writes `/t/:public_code` throughout; the value passed is the public_code, so it's cosmetic — but fix it so an implementer doesn't invent a new param.
- The sender wizard's "Done" step was removed in the sender-flow-wizard Round 2 (`SenderFlow` redirects to `/t/<code>?fresh=1`); the "Intro→Package→Rates→Review→Done" reuse description is stale.
- `SenderStepRates` hides prices ("No pricing shown (recipient pays)", SPEC §8 Step 2). A paying buyer MUST see prices, so the rates *step* can't be reused verbatim either — it needs a price-visible variant.
- Package-column naming: the link already has `weight_hint_oz` (001:62) and shipments uses `weight_oz`/`length_in`; adding `pkg_weight_oz` puts two weight columns on one table. Align naming (or reuse `weight_hint_oz` semantics).
- §2.4 "Owner `shipments.user_id` = the seller" — `shipments` has **no** `user_id` column; ownership is via `link_id → sendmo_links.user_id`. Harmless but imprecise; the file-by-file "owner = link.user_id" phrasing is the correct one.
- §2.6/Reconciliation attribute the "anonymous one-off party is blessed" pattern partly to `account-creation-timing`; that proposal actually pushes senders *out of scope* and nods to the sender-wizard decision — the blessing comes from `sender-flow-wizard`. (The Pattern-A-chosen / Pattern-C-rejected representation itself is accurate.)

### Predicted pitfalls

1. **Runtime CHECK-constraint crash on the first single-use close (B1).** Ship `status='used'` and the very first successful single-use buy throws `sendmo_links_status_check` at the close step — after money moved, and under the webhook-buys design possibly after the label bought (charged buyer, no clean close). Same class as the H2 incident just logged (2026-07-16, PR #52: "4 nonexistent-column refs killed H2 adjustments in prod") — a value that doesn't exist in the live schema, merged because it wasn't checked against migration 020. Deterministic; 100% reproducible on the golden path.

2. **The buyer is silently locked out of managing their own purchase; the seller gets someone else's receipt (B3).** The first real seller-link cancel refunds the buyer's card but emails the *seller* "your refund is processing" and shows the *seller* a receipt for a charge they never made, while the buyer — holding the cancel token — is classified `sender_flex`, sees no receipt, and gets no email. This violates the proposal's own headline invariant and mirrors the payer-identity confusion the 2026-06-27 label-confirmation-email fix already had to untangle ("payer maps to sender in full-label but recipient in flex"). Seller-link makes the payer a *third* identity the code has never modeled.

3. **Double-charge / double-buy from the webhook-buys inversion under retry (B2).** Stripe re-delivers `payment_intent.succeeded` on any non-2xx/timeout; EasyPost `/buy` isn't idempotent. A webhook that both buys and (per §2.7) auto-refunds losers can, on a retry or concurrent second delivery, buy a second label or refund the wrong PI. The current architecture dodges this precisely because the buy is a single client-triggered `labels/` call. This is the 2026-07-06 "fire-and-forget killed post-response work" fragility combined with the D3 idempotency lessons (per-object keys like `stripe.refund.<rfnd_id>`) — the proposal inherits none of those guards.

4. **A popular seller gets budget-blocked by their own buyers (N1).** Seller-anchored charges + `checkAccountBudget` per-user summing means a shop doing >$200/day of buyer purchases trips the seller's Account Budget and starts 402-ing real buyers — which reads to the seller as "SendMo broke my store." The budget was built to cap a recipient's own off-session spend, not a merchant's inbound volume.

### What the proposal got right

- **Scope discipline (§1.2, §5).** Cleanly separates buyer-pays (this) from the seller-pays/marketplace-import tool and resists conflating them. That's the correct product cut, and it's honestly argued (including *why* eBay's already-paid-shipping buyer doesn't fit a pay-at-a-link flow).
- **The single-use-vs-reusable reframe (§2.3)** is a real correction over the WISHLIST's "flexible vs non-flexible": a seller link is always flexible (buyer supplies destination), and the meaningful axis is single-use vs reusable.
- **Naming the `recipient_address_id NOT NULL` blocker (§2.4, OQ2)** — it correctly identifies the single most delicate schema consequence and surfaces it for review rather than glossing it, with the right additive/idempotent migration instinct.
- **The `/onboarding` framing analysis (§2.2)** is right and well-argued: a third buyer-pays card breaks the who-pays frame; the reframed intent-neutral heading + explicit copy is the correct fix; keeping it to one page (not an upstream buying/selling fork) protects the ~95% recipient flow.
- **Accurate representation of `account-creation-timing`** — Pattern A (recipients) chosen, Pattern C (claim-later) rejected as low-adoption; the proposal correctly does *not* revive Pattern C as the buyer's primary path and treats the buyer as an incidental one-off payer (which is consistent with that proposal's own "pattern B where the buyer is incidental" carve-out).
- **Honesty about the one hard part (§1.4)** — it doesn't oversell the on-session checkout as trivial, and flags chargeback exposure as unsolved-in-v1 rather than hiding it.

## Author response

```
author:       Claude Opus 4.8 (original author session)
responded_at: 2026-07-17
disposition:  accept all — B1–B5, N1–N5, and every nit. No rejections. One item escalated to John as a new governance question (OQ6). I independently re-verified B1/B2/B3 against the live code before accepting; all three hold.
```

This is a strong review and it made the design materially more correct. The direction survives intact, but three of my Architecture claims were wrong on contact with the code, and the headline "buyer manages via token" invariant needs real work rather than free reuse. Per-point:

**B1 — `status='used'` crashes. ✅ Accept.** Verified: migration [020:52](../supabase/migrations/020_cancel_token_and_link_lifecycle.sql) renamed `'used'`→`'in_use'` and the live CHECK is `('draft','active','in_use','completed','expired','cancelled')`. Fix: single-use close writes **`'in_use'`** (present-tense "shipment in flight"), which is exactly what the current `admin_insert_shipment` RPC mints. Bonus the reviewer noted: `in_use` also drops the link out of the `status='active'` public-read RLS ([001:223](../supabase/migrations/001_initial_schema.sql)) — so "closed to new buyers" falls out for free. All five references corrected at implementation. This is the H2 "value not in the live schema" class (LOG 2026-07-16, PR #52) — exactly what draft-time grounding is supposed to catch, and I missed it by trusting the 001 enum over 020.

**B2 — webhook-buys is a new inversion, not reuse. ✅ Accept, and it's *less* work.** Verified: the `payment_intent.succeeded` arm ([stripe-webhook:215–345](../supabase/functions/stripe-webhook/index.ts)) only UPSERTs `stripe_intents` + writes ledger rows; comment lines 330–336 confirm the buy/status-flip was deliberately removed from that path. New design: **mirror the on-session full-label flow** — the seller-checkout fn creates the PI, the client confirms the Payment Element, then the **client** calls `labels/` with the verified PI for a synchronous buy + the buy-time rate-gate (409 `rate_changed` → re-shop) + the single-use close. The webhook keeps its ledger-only job. This preserves the rate-gate UX, avoids the Stripe-retry/EasyPost-non-idempotent double-buy, and is the correct analog (the buyer is a full-label-style on-session payer).

**B3 — the "buyer manages via token" invariant does NOT hold as-shipped. ✅ Accept — this is the important one.** John's invariant (*the payer must always be able to manage their purchase*) is right as a principle, but the code only satisfies it for payer == link owner, and the seller link is the first feature where **payer ≠ link owner**. Verified: [cancel-label:448](../supabase/functions/cancel-label/index.ts) resolves the refund-email recipient from `link.user_id`; [tracking/index.ts](../supabase/functions/tracking/index.ts) gates the receipt on `viewerRole === "payer"` (== link owner) and classifies a token-holder as `sender_flex` (no receipt); the token is minted to `sender_email`, which doesn't exist for a seller link. As written, the **seller** would get the buyer's refund email + a receipt for a charge they never made, and the **buyer** would get nothing. Fix — own it as real work, not reuse: branch payer-identity on `link_type` in **both** `cancel-label/` and `tracking/` (resolve payer from `buyer_email` for seller links), make `/t/` treat the seller-link token-holder as the receipt-bearing payer, and mint/deliver the cancel token to `buyer_email`. Precedent correction accepted: `flex-sender-visibility` blesses "an accountless party can *trigger* a cancel," not "the accountless payer is *refunded, notified, and shown their receipt*." This is scope I under-counted — the honest §1.4 "one new build" is now **two**: the on-session checkout *and* the payer-identity rewiring. The governance sub-point (seller refunding the buyer's charge) → **OQ6**.

**B4 — client-price-trust; "same discipline as today" cited the wrong leg. ✅ Accept.** Correct: the full-label `payments/` leg is the D1 launch-blocker, not a model to copy. Seller-checkout follows the **flex server-derive** discipline: buyer picks an EasyPost `rate_id` → server re-fetches that rate → applies the markup engine → PI created for the server-derived amount → buy-time gate runs on that amount. Never a client price. And I won't lean on D1 being fixed (it's in-review, not deployed).

**B5 — carrier constraint must enforce at buy-time. ✅ Accept.** Resolve the seller's carrier/speed constraint from the **link row** server-side in *both* `rates/` (UX filter) and the buy path in `labels/` (the actual guarantee) — the link row is already fetched, so it's cheap.

**N1 — seller-anchored charges collide with `checkAccountBudget`. ✅ Accept — important.** Excellent catch: per-user 24h/7d charge-summing would trip the *seller's* budget on *buyer* volume and 402 real buyers. Fix: exclude seller-link buyer charges from `checkAccountBudget` (it isn't the seller's spend) and reconcile per-link via `transactions.link_id` rather than overloading `user_id`. This actually resolves most of OQ3: seller-anchoring is fine for *attribution* as long as it's excluded from the *budget* check.

**N2 — enumerate the ~15 `recipient_address_id` join sites. ✅ Accept.** Will enumerate in the file-by-file plan; the one that needs a real branch is the create insert at [links/index.ts:643](../supabase/functions/links/index.ts). The separate-`seller_links`-table vs additive-columns tradeoff stays **OQ2** for John — I lean additive-columns-with-an-airtight-CHECK (Rule 6), but the reviewer's semantic-overload point (a `recipient_address_id` meaningless for the type; 6 columns NULL for the other two types) is real and I've sharpened OQ2 to name it.

**N3 — concurrency can leave both labels surviving. ✅ Accept.** The close must be an **atomic transition**: `UPDATE sendmo_links SET status='in_use' WHERE id=? AND status='active' RETURNING id` — only the winner proceeds to buy; the loser auto-refunds. (Far easier under B2's client-triggered synchronous buy than under two independent webhook deliveries — another point for B2.)

**N4 — seller-origin-address privacy. ✅ Accept.** Mirror of Rule 7: resolve the seller's origin **server-side** for rating (as the flex leg resolves `to_address`); never return the seller's street to the buyer's client before purchase.

**N5 — route the third card to a separate seller-builder flow. ✅ Accept.** The card must **not** feed the recipient `RecipientPath` (`"flexible" | "full_label"`) state machine in `stepRouting.ts`/`RecipientFlowContext`; it routes to a distinct seller-builder. Will state this explicitly.

**Nits — ✅ Accept all:** `/t/:code` (not `:public_code`); the sender "Done" step is gone (redirects to `/t/<code>?fresh=1`); `SenderStepRates` hides prices so the buyer needs a **price-visible** rates variant (a real sub-task, not just a nit); package-column naming aligns with the existing `weight_hint_oz` rather than adding a second weight column; `shipments` ownership is via `link_id → sendmo_links.user_id` (no `user_id` column — §2.4 phrasing corrected); and the "blessed anonymous party" pattern is `sender-flow-wizard`, not `account-creation-timing` (whose Pattern-A/C representation was itself accurate).

**Body reconciliation:** sections §2–§3 predate this response; the corrected design is as stated here. I've deliberately **not** rewritten §2.4/§3 yet because **OQ2** (additive columns vs separate table) rewrites them either way — I'll reconcile the body into the chosen shape once John rules the open questions, so we don't churn it twice.

**Net:** no author/reviewer disagreements to break — I accept the whole review. What's left is John's calls on **OQ1** (onboarding framing), **OQ2** (schema shape), **OQ3** (ledger attribution — now mostly settled by N1), and the new **OQ6** (may a seller refund the buyer's charge?). OQ4/OQ5 are low-stakes and I'll take my recommended defaults unless John says otherwise.

## Decision

```
decided_by:  John
decided_at:  2026-07-17
outcome:     approve-with-changes (all review findings B1–B5, N1–N5, and nits accepted into the design; build proceeds)
```

**Approved to build**, with the review's corrections folded in. John's calls on the open questions:

- **OQ1 — onboarding surface: a third card.** Decided against a mockup ([previews/onboarding-seller-card-concepts.html](../previews/onboarding-seller-card-concepts.html); artifact `0ef50ead-90bb-4cf9-9a20-8ebd4d07f1da`). A literal third card on `/onboarding`, in the existing card language, differentiated by an **emerald accent**, a **"New" tag**, and a **"who pays" pill on all three cards** ("You pay" ×2, **"Buyer pays"** on the seller card) so the who-pays flip is unmistakable. The page **heading is reframed** from "How should we set up your prepaid shipment?" to **"How do you want to ship?"** ("prepaid" = recipient-paid, wrong for the seller card). The card routes to a **separate seller-builder flow**, not the recipient `RecipientPath` state machine (per review N5). Copy is the mockup's.

- **OQ2 — schema shape: single table (additive columns on `sendmo_links`) with an airtight per-type CHECK.** Chosen over a separate `seller_links` table. **Deciding factor:** the entire downstream — `shipments`, tracking, refunds, the `transactions` ledger, and admin — all key off `shipments.link_id → sendmo_links`. A separate table would force either a polymorphic `link_id` (an anti-pattern that fights Postgres + RLS) or a parallel seller-shipment/tracking/refund stack; that divergence is far more expensive long-term than a few nullable columns. The semantic-overload downside (columns meaningless for other link types) is neutralized by a **strict per-`link_type` CHECK** that enforces which columns are required/forbidden per type at the DB level. Includes the `recipient_address_id` NOT NULL relaxation (role-aware CHECK) + new `origin_address_id` + package columns (aligned to the existing `weight_hint_oz` naming, per nit) + `max_shipments`, and `buyer_email` + `recipient_user_id` on `shipments`.

- **OQ3 — ledger attribution: seller as merchant-of-record, excluded from the budget check.** The buyer-paid `transactions.charge` anchors to the **seller** (`link.user_id`), tagged so it is **excluded from `checkAccountBudget`** (it isn't the seller's own spend — review N1), with per-link reconciliation via `transactions.link_id` rather than overloading `user_id`.

- **OQ4 — new `seller-checkout/` edge function** (not an extension of `payments/`), to keep the recipient path clean. Author default, unchallenged.

- **OQ5 — `link_type = 'seller_link'`** (not the WISHLIST's `seller_marketplace`; it covers 1:1 too). Author default, unchallenged.

- **OQ6 — a seller may cancel + refund the buyer's paid label — YES, with mandatory buyer notification.** The seller who can't fulfill must be able to refund. This dovetails with **B3**: the buyer (not the link owner) must receive the cancel/refund email and see their own receipt, which is exactly the payer-identity rewiring B3 requires.

**Design corrections locked in (from the review, all accepted):** single-use close writes **`'in_use'`** not the deleted `'used'` (B1); the buy is **client-triggered synchronously via `labels/`** after on-session PI confirmation, webhook stays ledger-only (B2); payer-identity is **branched on `link_type` in `cancel-label/` and `tracking/`**, token minted/emailed to `buyer_email` (B3); seller-checkout **server-derives price from the buyer's `rate_id`** (flex discipline, never client price — B4); carrier constraint **enforced at buy-time in `labels/`** (B5); the single-use close is an **atomic `UPDATE … WHERE status='active' RETURNING id`** so concurrent public buyers can't both win (N3); the seller's **origin address is resolved server-side**, never returned to the buyer's client pre-purchase (N4).

**Honest scope note carried into implementation:** this is **two** new builds, not one — the on-session buyer checkout *and* the payer-identity rewiring across `cancel-label`/`tracking`/emails (so John's "the payer can always manage their purchase" invariant actually holds). The body §2–§3 will be reconciled to the single-table shape (OQ2) as the first implementation step.

**Next:** implement in a **git worktree off `origin/main`** (per the concurrent-session rule), sequenced roughly: (1) migration + strict CHECK, (2) seller-builder + third card, (3) `seller-checkout/` + on-session buyer flow + synchronous `labels/` buy, (4) payer-identity rewiring in `cancel-label`/`tracking`/emails, (5) single-use/reusable + concurrency guard, (6) tests + browser-verify. Each is its own PR against `main`.

### Amendment 2026-07-18 (John) — future-proof to seller-funded labels

**Requirement:** enabling "the seller covers shipping" later must **not** change step 1 (the `/onboarding` card + seller-builder entry) or require a new card. Achieved by treating *who funds* as a field, not an identity. Seam planted in v1:

- **"Who funds" is a field on the link, not a card.** Add `funder TEXT NOT NULL DEFAULT 'buyer' CHECK (funder IN ('buyer','seller'))` to `sendmo_links`. v1 only ever sets `'buyer'`, but the payment step **branches on `funder` from day one**. **`link_type` must NOT encode the funding party** — it stays `'seller_link'`; funding lives in `funder`. (This is why `seller_link` was chosen over any `…_buyer_pays` name.)
- **Step 1 is identical in both modes.** The "Sell & Ship" card (title already mode-neutral in the mockup) and the origin+package builder are the same whether buyer or seller funds. Only v1 *copy* (subtitle + "Buyer pays" pill) reflects buyer-funding; that copy generalizes when the toggle ships.
- **Seller-funds = Pattern D, relabeled.** When enabled: the seller saves a card (SetupIntent) at link creation and is charged **off-session** when the buyer completes the destination — the exact flex mechanism, reusing `payment_methods`, the off-session PI, `is_funded` gating, `max_price_cents` as the seller's cap, and the decline→reactivate email. The only new surface is a "save card + cap" step in the builder, gated on `funder='seller'` — it does not touch step 1.
- **Reinforces OQ2 (single table):** a seller-funded link inherits all of Pattern D's saved-card/off-session plumbing for free by living in `sendmo_links`; a separate table would have to re-plumb it.
- **Scope now:** plant the seam only — the `funder` column + the payment-branch structure — and ship **buyer-pays only**. The functional seller-funds toggle stays the deferred "I'll cover shipping" item (out of scope §5). **Distinct** from the separate seller-pays *tool* (post-sale buy-your-own-labels for eBay/marketplace orders + order-API import), which may warrant its own entry point in its own future proposal and is unaffected here.
