---
title: Industry research — payment authorization patterns for reusable-link billing
slug: payment-auth-pattern-research
project: sendmo
status: research
created: 2026-05-16
author: Claude (Opus 4.7) deep-research session, high-thinking mode
---

## 0. TL;DR

The industry-standard pattern for "validate once, then charge N times against the same card" is **SetupIntent at save → MIT/off_session PaymentIntent per charge against the saved PaymentMethod**, with the optional add-on of a small temporary authorization (Stripe's two $1.99 holds is the canonical reference) when the merchant additionally wants to prove the card is alive and the issuer isn't reflexively declining.

This is what every comparable platform actually does (Patreon, Substack, Airbnb, Uber, DoorDash, GoFundMe, Donorbox, Shippo, Shopify Shipping). None of them attempt to "pre-authorize $cap" for a reusable arrangement — that's not a primitive that exists. A card hold is single-capture, single-amount, max 5-7 days; once captured it is dead. The "I've confirmed there's $100 available" mental model that the strategy proposal tries to preserve is not something any payments vendor actually offers, because the issuer does not expose "available credit" to merchants and the only way to prove balance is to encumber it (which is what we're trying to avoid).

SendMo should commit to **Pattern D (SetupIntent + off_session PI per shipment)** with the small addition of a **single $0/$1 card-verification auth at save** to give the recipient the "yes my card was accepted by Stripe" confirmation — but explicitly drop the "$cap was authorized" mental model from product copy, because it's a fiction we cannot deliver and the per-shipment off_session charge already enforces the cap as a server-side rule.

The biggest schema implication: the `payment_validations` table from the execution proposal stays, but the `holds` table stops being a flex-flow concept entirely (it moves to Phase 3 escrow exclusively), and `stripe_intents` needs `payment_method_id` so we can quickly answer "is this customer chargeable" without an extra round trip to Stripe.

---

## 1. The question being researched

SendMo's flex link is a single URL that a recipient creates once with a price cap (e.g. $100). N independent senders then use the URL over time; each use generates a child shipment billed to the recipient's card. The recipient should feel confident at link creation that the card is "set up and working." The link is reusable indefinitely until the recipient deactivates it or the card becomes invalid.

The original strategy proposal sketched four patterns:

- **A** — single 7-day hold consumed by the first sender (the Phase E commit; broken for reuse)
- **B** — capture-then-rotate so a live hold is always visible
- **C** — keep a $cap auth visible AND charge per-shipment off_session (double-bookkeeping the cardholder sees)
- **D** — SetupIntent save + off_session PI per shipment (no persistent hold)

The author admits the patterns and labels are partly invented. The question this research answers: what is THE industry-standard pattern, and which of A/B/C/D — or a fifth — should SendMo commit to as the single canonical model?

---

## 2. Methodology

- Read Stripe's own canonical documentation in full: `payments/save-and-reuse`, `payments/save-and-reuse-cards-only`, `payments/cits-and-mits`, `payments/place-a-hold-on-a-payment-method`, `payments/multicapture`, `payments/setup-intents`, `declines/codes`, the Authorization Holds resource page, and the CAU (Card Account Updater) docs.
- Pulled card-network constraints from Visa's published Core Rules (Apr 2026) referenced via secondary sources (PayJunction, Chargebacks911, Visa's authorization-and-reversal best practices PDF, Mastercard chargeback timeframes via the same secondary sources). Also the 2025 Visa/MC rule-change summaries.
- Surveyed concrete platforms in the listed comparable categories: Airbnb (verification flow help center), Patreon (subscription billing FAQ), Substack (Stripe one-off + subscription docs), Etsy (postage label billing), Shopify Shipping (threshold billing docs), Pirate Ship / Shippo / ShipStation (billing model overviews), Uber Eats (auth-hold FAQ + group order docs), DoorDash (tip-adjustment docs), GoFundMe / Donorbox (donation card storage). For each, looked for the actual mechanic, not just marketing copy.
- For the "is there a Stripe API to check available credit" question I specifically searched both the public docs and Stripe support; there isn't one (issuers don't expose available credit to merchants, and the only proxies are auth-and-void or run-the-real-charge-and-see).
- For the "outstanding-authorizations data model" question I looked at general payment-system architecture write-ups (Cockroach DB blog, sdk.finance, ClearlyPayments) because Stripe itself doesn't publish a recommended data-model shape and the industry pattern is whatever your accounting/risk team needs.

**What I could not verify:** Etsy and Shopify Shipping clearly use a wallet/threshold-billing model and Etsy in particular does not appear to use Stripe for seller-side billing; I could not find an authoritative source on whether they per-card-charge or settle through an internal balance. I list this as a corroborating data point (the wallet model exists in mature platforms) but don't lean on the exact mechanic. I also could not find a public engineering post from any of these platforms that lays out the SetupIntent + off_session pattern explicitly — the evidence is in the Stripe customer case study + the platforms' help-center descriptions of how billing works, which converge.

---

## 3. Findings — what real platforms do

I'll group these by mechanism, because the convergence is the headline.

### 3.1 SetupIntent / save-card + per-event off_session charge (the dominant pattern)

This is what every consumer marketplace that "saves your card and bills it later" actually does.

- **Patreon** — vaults the card via a "secure third party service" (Stripe), then issues recurring or per-creation charges at billing time. Cards are charged in coordinated UTC; if a card declines, Patreon retries at "optimal times" throughout the month and emails the patron. There is no persistent pre-authorization; the credit-card-on-file is the only persistent state. [Patreon billing FAQ](https://support.patreon.com/hc/en-us/articles/8779192853261-Subscription-Billing-FAQ), [Per-creation billing](https://support.patreon.com/hc/en-us/articles/360002137871-How-per-creation-billing-works)
- **Substack** — uses Stripe to save subscriber cards; subscriptions charge at renewal; one-off tip jars are separate Stripe Payment Links that present checkout. The platform explicitly leans on "card saved → 3x more likely to convert later." No prepaid balance, no pre-auth. [Substack/Stripe customer story](https://stripe.com/customers/substack)
- **GoFundMe / Donorbox / GoGetFunding** — donations are one-shot Stripe charges; recurring donations use a saved-PM model where Donorbox tokenizes through Stripe and exposes a donor login for updating cards. The platform never holds funds against the donor's card between donations. [Donorbox Stripe integration](https://donorbox.org/stripe-donations)
- **DoorDash tip adjustment** — DoorDash explicitly allows post-delivery tip adjustments "up to 30 days after order completion." Mechanically this is an incremental charge or an auth-extension; the original order PI is captured and a separate small charge is run for the tip delta against the saved PM. [DoorDash tip adjustment](https://help.doordash.com/consumers/s/article/Can-I-adjust-the-tip-I-provide-to-my-Dasher)
- **Uber Eats** — every order triggers a separate authorization hold against the saved card; the auth becomes a real charge on settlement; no persistent multi-order auth. Group orders where "creator pays for everyone" are a single bigger charge per order, not a reusable funded pool. [Uber Eats auth holds FAQ](https://help.uber.com/en-GB/ubereats/restaurants/article/authorization-holds---faq-)

The convergent shape: **the merchant has a PaymentMethod attached to a Customer, runs off_session charges per event, and recovers from declines via email+retry+update-card UX.** Nobody pre-authorizes a pool.

### 3.2 The "verification auth" add-on (Airbnb pattern)

Airbnb is the clearest data point on "we want the recipient to feel certain their card works before they share the link":

> "We may send 2 temporary authorizations of $1.99 or less to your debit or credit card. The temporary authorizations are temporary holds and won't actually be charged to your card."

Airbnb does this in addition to the eventual reservation charge — it's specifically a card-verification primitive, not a funds-reservation primitive. The holds release automatically. [Airbnb card verification](https://www.airbnb.com/help/article/1820)

This is the mature industry shape of "validate the card without persisting a charge." Notably, Airbnb does NOT do this at the cap amount — they do it at a fixed small amount, because the only thing the auth proves is "card accepted by issuer right now." It does NOT prove "card has $cap available" — and Airbnb doesn't try to claim that, because issuers don't expose available credit.

### 3.3 The "merchant balance / wallet / threshold-billing" pattern

A second mature pattern exists for high-frequency shipping use cases:

- **Etsy** — sellers buy postage labels against their Etsy Payments seller balance, not against a separate card. Shipping label fees and adjustments are "reflected in your payment account and deducted from your current balance." [Etsy postage label billing](https://help.etsy.com/hc/en-us/sections/360000066248-Fees-Billing)
- **Shopify Shipping** — uses a "threshold billing system": as you spend on labels within a billing cycle, you're invoiced when you hit a threshold; you can continue buying labels up to 110% of the threshold while the invoice processes. Shopify charges the card on file (and folds the labels into the monthly Shopify subscription bill if you don't hit threshold). [Shopify shipping labels billing](https://help.shopify.com/en/manual/fulfillment/fulfilling-orders/shipping-labels/billing-and-taxes)
- **Pirate Ship / Shippo / ShipStation** — all save a card and run per-label charges or wallet-prepay flows. None of them pre-authorize a pool of money on the user's card to cover N future labels.

This is the wallet/balance model that the master proposal §3.6 already calls out as Post-MVP for SendMo. It's *the* mature pattern for high-frequency shipping, but it's a different product shape (prepay vs pay-as-you-go), so the relevant insight here is: even the platforms that move money in bulk against shipping labels don't pre-authorize a pool against the user's card. They either invoice on threshold or deduct from a prefunded balance.

### 3.4 Holds with later capture (hotel / car rental / gas station)

The pattern that the original strategy proposal pattern-matched against (hotel pre-auth, car rental deposit) is genuinely a hold-and-capture pattern — but it's for a **single, bounded transaction with a known end date**. Hotels hold for the duration of a stay; rental cars hold for the duration of the rental; gas stations hold ~$1 then settle the actual fuel amount. None of them try to keep a hold alive across an unbounded sequence of future independent transactions, because the card networks structurally don't allow it (5-7 day max, see §5).

The product-shape mismatch is the key insight: SendMo's flex link is more like "a Patreon page that has a price cap" than "a hotel reservation." The pre-auth-and-capture pattern is the wrong industry analog.

### 3.5 The pattern Stripe Connect destination-charge / transfers model

For the multi-party billing question (sender initiates, recipient is billed): Stripe's official primitive is exactly the saved-PM + MIT/off_session model. Stripe Connect's destination-charge and direct-charge models are for when the merchant (recipient in our analogy) is the cardholder being paid out — that's the wrong direction for our use case. The right primitive remains: customer = recipient, payment method = recipient's card, charges initiated by SendMo (the platform) on the recipient's authorization, off_session.

---

## 4. Stripe's canonical pattern

Stripe's documentation is unambiguous on this and the recommendation is consistent across multiple doc pages:

1. **Save the card with a SetupIntent.** From [Save and reuse](https://docs.stripe.com/payments/save-and-reuse): *"The Setup Intents API lets you save a customer's payment details without an initial payment. This is helpful if you want to onboard customers now, set them up for payments, and charge them in the future—when they're offline."*

2. **Charge later with PaymentIntent + `off_session=true, confirm=true`.** From [save-and-reuse-cards-only](https://docs.stripe.com/payments/save-and-reuse-cards-only): the canonical curl is
   ```
   POST /v1/payment_intents
   amount=1099 currency=usd customer=<cus_> payment_method=<pm_>
   off_session=true confirm=true
   ```

3. **Set up the CIT/MIT chain correctly so subsequent charges are properly classified as MIT.** From [CIT and MIT](https://docs.stripe.com/payments/cits-and-mits): *"When you set up your integration to properly save a card, Stripe marks any subsequent off-session payment as a merchant-initiated transaction (MIT) so that your customers don't have to come back online and authenticate."* This is load-bearing for SCA/PSD2 compliance; if SendMo grows internationally it gets us issuer exemption for subsequent off_session charges.

4. **Get explicit customer consent at save time.** From CIT/MIT: terms must state *"the anticipated timing and frequency of payments… and how payment amounts are determined."* The recipient's flex link consent copy needs to say "each time someone uses your link, your card will be charged for the actual postage." This is non-optional and is the only "front-load" we actually need.

5. **Handle declines by routing the customer back on-session.** Stripe's [Card declines](https://docs.stripe.com/declines/card) and [authentication_required](https://www.flycode.com/stripe/decline-codes/authentication-required) docs are clear: an off_session decline can't be recovered by retry alone — you email the customer, get them back on-session, and let them update the PM or complete 3DS via the existing client_secret.

**On the specific question "can I verify the card has $cap available before saving?":** Stripe does not document such a capability anywhere, because **it does not exist as a card-network primitive.** SetupIntent does a network validity check ("the card information is valid on the network") — that's a BIN check + a `account_status: valid` issuer ping, not an available-credit check. The only way to prove available credit at save time is to authorize the full amount, and that's the thing we don't want to do because the authorization (a) is bounded to 5-7 days, (b) is single-capture, and (c) burns the cardholder's available credit during the hold window. There is no "is $100 available without holding it" API at the network level for issuers to expose.

The implication: the strategy proposal's "$cap validation" framing is asking for a primitive that doesn't exist. The closest thing is auth-for-$cap-then-void, which gives you a single moment-in-time "$cap was available 200ms ago" answer at the cost of (a) potentially confusing the cardholder with a brief pending hold for $cap, and (b) extra Stripe API surface, and (c) it tells the recipient nothing useful about whether the card will work for the 17th sender in 14 days.

---

## 5. Card-network and regulatory constraints

These are the hard bounds:

| Constraint | Source | Implication |
|---|---|---|
| Max card-not-present (Visa CIT) auth lifetime: 7 days | [Stripe place-a-hold](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method) | Cannot persist a $cap auth beyond 7 days. Disposes of Pattern A and B without further argument. |
| Max card-not-present (Visa MIT) auth lifetime: 5 days | [Visa Core Rules](https://usa.visa.com/dam/VCOM/download/about-visa/visa-rules-public.pdf), [PaymentNerds 2025 rule changes](https://paymentnerds.com/blog/visa-mastercard-2025-rule-changes-what-high-risk-merchants-must-know/) | If we *did* try to do a rotating MIT pre-auth, the window is even tighter. |
| Mastercard final authorization: 7 days; preauthorization: 30 days | Mastercard chargeback guide via [Chargebacks911](https://chargebacks911.com/visa-authorization-rules/) | Asymmetric across networks — designing on the longest tail is fragile. |
| One capture per PaymentIntent (with rare multicapture exception) | [Stripe multicapture](https://docs.stripe.com/payments/multicapture) | *"You can only perform one capture on an authorized payment for most payments."* Multicapture is IC+ pricing only, capped at the authorized amount, requires opt-in, and is restricted to "card-not-present transactions for the sale of goods that ship separately" — that's actually closer to our use case than I expected, but it still doesn't fit because the cap is on the *authorized amount* (so still 7-day lifetime, still single PI). Disposes of any "rotate-from-one-PI" fantasy. |
| No online incremental authorization | [Stripe place-a-hold](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method) | Cannot extend a hold's amount online. (Only in-person/Terminal.) |
| Zero-dollar verification: officially encouraged by both networks | [LegalClarity ZDA](https://legalclarity.org/what-is-a-zero-dollar-authorization-for-card-validation/), [MerchantCostConsulting](https://merchantcostconsulting.com/lower-credit-card-processing-fees/visa-zero-dollar-verification-fee/) | The networks *prefer* $0 over $1 ghost auths; misuse-of-authorization fee ($0.15) applies to fake $1 auths. |
| MIT requires customer-saved mandate | [Stripe CIT/MIT](https://docs.stripe.com/payments/cits-and-mits) | The consent text matters and is a deployable artifact, not a research question — must say "we'll charge per shipment for actual postage." |
| SCA/PSD2 for EU customers | [Stripe SCA](https://stripe.com/guides/sca-payment-flows) | If we ever process EU cards, MIT exemption is preserved only if the SetupIntent at save time authenticates the cardholder. SetupIntent does 3DS at save → all subsequent off_session charges qualify for the MIT exemption. PI-with-cap-and-void would also satisfy this if the customer is authenticated, but for a US-only product right now this is moot — flag for the EU expansion proposal. |

The 5-7 day ceiling and the single-capture rule together kill Patterns A, B, and C structurally. They're not bad ideas badly executed — they're asking for a primitive that doesn't exist at the network level.

---

## 6. Industry terminology mapping

The strategy proposal uses some terms loosely. Mapping to real industry vocabulary:

| Strategy term | Standard term | Note |
|---|---|---|
| "Validate-once-then-charge" | **CIT-with-setup_future_usage → MITs** (Stripe vocab) or **"credentials on file" (COF) → unscheduled MIT**` (network vocab) | "Unscheduled MIT" is the official network classification for "we'll charge against this saved card on an irregular schedule we cannot predict." This is the bucket SendMo flex sits in. |
| "Validate-and-void" | **Authorization reversal** (Visa term) or **"verification auth"** (informal but widely used) | Specifically called out by Visa as an acceptable use; the Visa-recommended primitive is the **$0 zero-dollar verification** (ZDA), with the $1 auth-and-void as the legacy fallback the networks are deprecating. |
| "Hold" / "pre-auth" / "authorization" | **Authorization** (the network primitive). "Hold" is the customer-facing artifact. "Pre-authorization" is hotel/travel-specific — implies the 30-day extended window. | Casual use is fine internally but product copy should say "authorization" or just "test charge" not "pre-auth," which carries hotel-industry connotations of long-lived hold. |
| "Saved PM" | **Credentials-on-file (COF)** at the network level; **PaymentMethod attached to a Customer with `setup_future_usage`** at the Stripe level | Important: a PaymentMethod attached to a Customer but never used for setup_future_usage is *not* a properly-established COF and Stripe will not classify subsequent off_session charges as exempted MITs. |
| "Flex hold" (current `intent_role`) | No good standard term — `flex_hold` is fine internally but the conceptual model after this proposal is "card validation" + "shipment charge," not "hold." | The execution proposal already calls this out (Reviewer Finding #6: keep `flex_hold` enum value to avoid migration but reframe the meaning). |

**The most important terminology fix:** what the recipient is doing at onboarding is *establishing credentials-on-file with a mandate to charge for future shipments*, not "authorizing $cap." The product copy should reflect this. The cap is enforced by SendMo's own server-side rule at sender-charge time (the `display_price > link.max_price_cents` check), not by Stripe.

---

## 7. UX research on pending-auth visibility

The evidence on pending-auth visibility is unambiguous and consistent across multiple sources:

- **Visa's own position** ([MerchantCostConsulting](https://merchantcostconsulting.com/lower-credit-card-processing-fees/visa-zero-dollar-verification-fee/)): *"one dollar authorizations followed by the full amount of the sale can appear to a cardholder to be a double billing or extra charge and can generate disputes and chargebacks."* Visa introduced ZDA explicitly because customer confusion was generating chargebacks at scale.
- **Stripe's own position** ([Authorization Holds Explained](https://stripe.com/resources/more/authorization-holds-explained)): pending holds *"can be confusing and create the impression of two transactions when there was really only one."*
- **Real-world cardholder complaints** about Uber Eats and Airbnb pending auths are voluminous (the support pages are full of "why was I charged twice" threads). The industry resolution is always the same: explain the auth in support copy, release as soon as possible, never let the customer see a pending hold that won't either capture or release within minutes.
- **Airbnb's choice** is instructive: they could verify cards via a one-shot $cap pre-auth at booking, but they don't. They use $1.99 holds (twice) explicitly because the verification value is preserved without burning the cardholder's available credit on a number that means nothing to them.

For SendMo specifically: a brief visible pending hold for $cap (the strategy proposal's "1-3 seconds" claim) is dishonest in two ways. (1) The hold often takes minutes to appear on the cardholder's banking app — well after our cancel call. (2) The hold often takes 1-3 *days* (not seconds) to actually disappear from the cardholder's pending list once we release it, because that's the issuer's responsibility and they batch overnight. The brief-window framing is wrong. **Either we do a $0/$1 ZDA-style verification, or we do nothing at save time** — but we should not pretend that a brief PI+cancel for $cap is invisible. It isn't.

---

## 8. Outstanding-auth state — data model patterns

This is the bit where the public engineering literature is thinnest, because it's company-by-company. But the patterns that emerge from the architecture write-ups (Cockroach DB blog, sdk.finance, ClearlyPayments) and from reading how Stripe itself structures the API:

1. **Mature payment systems denormalize Stripe's PaymentIntent / PaymentMethod state into their own DB.** Stripe's API is the source of truth, but local state is required for query performance, RLS, reconciliation, and incident recovery. SendMo's existing `stripe_intents` table is exactly this pattern, correctly executed.

2. **The lookup "is this customer currently chargeable" is typically answered by `(payment_method_id, status='active'|'attached')` on the local mirror, not by re-querying Stripe.** Stripe does not expose a single "list outstanding auths for this customer" call; the closest is `customer.list_payment_methods` (which we already use via the `payment_methods` table). For outstanding auths specifically, you'd query `payment_intents.list(customer=cus, status=requires_capture)` — which works but is slow at scale and isn't a primary source-of-truth pattern any reference architecture recommends.

3. **The disambiguation between "PI canceled by Stripe auto-expiry vs canceled by us vs declined"** is handled via `cancellation_reason` (Stripe sets this to `automatic` for the 7-day expiry, the value you pass for explicit cancels, and there's no such concept for declines because declined PIs go to `requires_payment_method` not `canceled`). SendMo already has `last_event_at` on `stripe_intents`; should add `cancellation_reason` and `last_payment_error_code` (the decline code if any) to disambiguate cleanly.

4. **Gap in SendMo's current schema:** `stripe_intents` has no `payment_method_id` column. After the pivot to off_session-per-shipment, every shipment charge needs to know which PM it used. Currently you can chase it through Stripe (it's on the PI), but querying "which PMs has this user used in the last 30 days for live-mode flex charges" requires either re-pulling each PI from Stripe or extracting it from the webhook and storing it. Add the column.

5. **`payment_validations` is the right shape.** The execution proposal's table — `id, user_id, link_id, customer_id, validated_amount_cents, stripe_intent_id, validated_at, mode` — captures the audit need ("when did we test this card, what did we test it for, with what result"). Should add `result` (success/failure) and `decline_code` per the execution proposal's reviewer notes, plus `payment_method_id` (the PM that was validated; lets us answer "is the PM that was validated the same PM that's currently default?").

---

## 9. The recommended pattern (singular)

**SendMo should commit to Pattern D — SetupIntent at save + off_session PI per shipment — with a single $0/$1 verification authorization at save time for the "yes my card works" UX moment, AND with the cap enforced exclusively as a server-side `link.max_price_cents` rule at charge time.**

I'm calling this **Pattern D' (D-prime)** to distinguish from the original proposal's strict D which omitted the verification step. The "prime" addition is the small verification auth at onboarding — borrowed from Airbnb — to give the recipient the moment of "Stripe accepted my card" confidence without burning the cap window or creating cardholder confusion.

### 9.1 Why this beats the alternatives

| Pattern | What we lose by NOT picking it | Why D' wins |
|---|---|---|
| **A — single 7-day hold consumed by first sender** | Nothing valuable; it actively breaks the reusable-link semantics after sender #1. The execution proposal's PR1 keeps this temporarily only as a bridge. | A is structurally incompatible with the product: one capture per PI, 5-7 day max, the "reusable link" promise collapses on shipment #1. Card networks don't expose a multi-capture-from-one-hold primitive (multicapture is amount-bounded and time-bounded; not a fix). |
| **B — capture-and-rotate (always-live hold)** | An always-visible "your card has $cap held" UX. Sounds attractive in the abstract. | Adds two Stripe round trips per shipment (capture + new auth) → latency + decline risk mid-cycle. Continually burns cardholder credit on a number that doesn't represent any actual upcoming transaction. Doesn't survive across the 7-day window if no shipments happen — same re-auth problem as A. Cardholder confusion compounds: every shipment looks like two charges (the rotating auth + the captured amount). |
| **C — hybrid: keep $cap auth visible + separate per-shipment charges** | Double-bookkeeping: cardholder sees both the "yes funded" pending hold AND each shipment charge. The most customer-hostile of the bunch. | Stripe's own docs and Visa's stated position both call out exactly this dual-pending shape as the #1 driver of bogus dispute filings. No comparable platform does this; the closest analog is gas stations + the eventual settlement, and those release the pre-auth on settlement (~2 days) precisely to avoid the dual-pending problem. C optimizes for a UX cue ("look, $cap is reserved") that nobody actually wants because they don't understand it and it looks like an extra charge. |
| **D — strict (SetupIntent + off_session, no verification)** | The "yes my card was accepted by Stripe" moment at onboarding. Recipient just adds the card and gets told "you're done" — same UX as adding a card to Patreon, which is fine for Patreon but Sendmo's recipient is about to *share* the card with strangers and the absence of a confirmation moment feels off. | D-strict is what the documentation literally recommends and what most platforms do. The downside is purely UX-confidence: the recipient adds the card, hits Save, and gets back "ok done" without anything actually having happened on their card. For SendMo's specific anxiety ("I'm sharing this with strangers, is it really working?") the Airbnb-style verification auth closes the loop cheaply. |
| **D' — SetupIntent + ZDA/$1 verification + off_session per shipment** | Nothing material. We add one extra API call at save time and surface "card verified" to the recipient. | This is the singular best fit. SetupIntent gives us the CIT-with-mandate that classifies subsequent charges as exempted MITs. The verification auth gives us the Airbnb-style "your card works" moment without burning the cap window. The cap stays as a SendMo-server-side rule, which is the only place it can actually live, because Stripe doesn't enforce per-charge caps against a saved PM. |

### 9.2 What the recommended pattern looks like end-to-end for SendMo

```
[Recipient onboarding step 22 — "Add card"]
  → Stripe Elements collects card details
  → Server creates a SetupIntent: customer, usage='off_session',
      mandate_data (CIT-with-mandate; surfaces consent text to issuer)
  → On SetupIntent succeeded webhook:
      - PaymentMethod is attached to Customer (Stripe handles)
      - Server runs a $0 ZDA against the new PM (Stripe will fall back
        to $1 auth-and-void if the network/issuer doesn't support $0)
      - On verification success → write payment_validations row (result=success,
        payment_method_id, link_id, customer_id, mode)
      - On verification decline → write payment_validations row (result=failed,
        decline_code) and surface "Your bank declined this card — please try
        another" in onboarding UI
      - Flip sendmo_links.status: draft → active

[Recipient shares URL — no payment activity]

[Sender N opens link]
  → Front gate (DB-only per execution proposal Option A):
      - sendmo_links.status not in (cancelled, expired)
      - Recipient has at least one non-deleted payment_methods row for the mode
      - Default PM's stored exp_month/exp_year is not in the past
  → Sender fills package details, picks rate

[Sender confirms shipment]
  → labels Edge Function:
      - Cap check: display_price_cents <= link.max_price_cents (SendMo rule)
      - Create off_session PI: amount=display_price_cents, customer,
        payment_method=<recipient's default PM>, off_session=true, confirm=true,
        metadata: { link_id, sender_email (if collected), source='shipment_charge',
        intent_role='flex_hold' (keep enum to avoid migration) }
      - On succeeded → buy EasyPost label → on label-buy failure, auto-refund
        the PI (existing logic)
      - On declined (card_declined, insufficient_funds, etc.) →
        - Cancel the failed PI
        - Return 402 to sender with friendly copy
        - Flip link to Inactive (link_state_events row)
        - Queue recipient email (Resend) with deep-link to dashboard reactivate
      - On requires_action (3DS for off_session) →
        - V1: treat as decline (same path as above; recipient must update PM)
        - V2 (wishlist): SCA-recovery flow with sender-email click-through

[Recipient sees decline notification]
  → Email + dashboard banner
  → "Reactivate" button on dashboard re-runs the verification auth against
     the (possibly updated) PM — same helper as onboarding
  → On verification success → link Active

[Recipient adds new card / replaces card]
  → SetupIntent again → ZDA → write payment_validations row → if any of
     recipient's flex links is currently Inactive due to decline, prompt to
     reactivate

[Card replaced by issuer mid-link-life (Account Updater)]
  → Stripe CAU updates the PM automatically (the saved PM ID stays the same
     where possible; if the card brand changes, a new PM is created and
     payment_method.automatically_updated fires)
  → Handle that webhook: copy new last4/exp to our payment_methods table;
     if brand changed (per CIT/MIT docs), we cannot MIT-charge until we get
     a new mandate — flip affected links to Inactive and email recipient

[Recipient deactivates link]
  → sendmo_links.status = 'cancelled' → sender sees fallback message

[7 days pass with no use — what happens?]
  → Nothing. The PM is still attached to the Customer. The SetupIntent has
     no lifetime constraint (unlike a PI auth). Sender N+1 opens link in
     14 days, off_session charge runs against same PM. This is the entire
     point of the model.
```

### 9.3 Data model implications

| Change | Why |
|---|---|
| Add `payment_method_id TEXT` column to `stripe_intents` | After the pivot, every shipment charge PI is tied to a specific PM. Without this column, answering "which PMs is this user actively charging on" requires either Stripe round trips or webhook-time extraction. Cheap to add now. |
| Add `cancellation_reason TEXT` and `last_payment_error_code TEXT` to `stripe_intents` | Disambiguates auto-expiry (irrelevant after the pivot for flex) vs explicit cancel (verification flow) vs decline (off_session failure). The current `status` column conflates `canceled` regardless of reason. |
| Keep `payment_validations` (per execution proposal) but add `payment_method_id` and `result` and `decline_code` | The execution proposal already calls this out — the additions explicitly capture "which PM was validated, did it succeed, why if not." Becomes the source-of-truth for the dashboard "Active vs Inactive" badge. |
| `holds` table — mark "Reserved for Phase 3 escrow only; flex flow stopped writing here as of PR2" via column comment | Per execution proposal §2.4. Don't drop the table — it's correctly designed for escrow's hold-and-capture semantics. Just stop writing to it from the flex path after PR2. |
| `payment_methods` — already has `is_default` per (user, mode) partial unique index; keep | The "which PM does this user's links charge against" lookup is already efficient. |
| Add `link_state_events` table (per execution proposal §3.3) | Audit trail for the new Active/Inactive transitions. Already proposed; this research supports adopting it. |
| Stop writing `holds` rows from the cap-validation helper after PR2 (execution proposal already calls this out) | The dual-write in PR1 is a temporary bridge; after PR2 the source of truth is `payment_validations` + live PM presence. |

**The strategy proposal's `stripe_intents` payment_method_id gap** is real and worth fixing in PR2 (or a small migration alongside PR2). It's the schema implication that most affects future debuggability.

### 9.4 What changes from the current Phase E behavior

This aligns with the execution proposal's PR2 plan, with three pattern-level clarifications:

1. **At onboarding step 22**: today's commit creates a manual-capture PI for $cap, the recipient confirms via Elements, the webhook writes a `holds` row. In the new pattern: the recipient confirms a SetupIntent (not a PI) via Elements; the server then runs a ZDA against the resulting PM; both `payment_validations` and `payment_methods` rows are written. No `holds` row. **The recipient never sees a pending hold for $cap**, because no such auth is created. The "your card was accepted" UX moment is the ZDA verification result.

2. **At sender confirmation**: today's labels-fn captures from the held PI. In the new pattern: labels-fn creates a fresh off_session PI against the saved PM for the actual rate. The cap is enforced by the server-side `display_price > link.max_price_cents` check (already present); Stripe does not need to know about the cap.

3. **The recipient's mental model in product copy must change**: today's step 22 says "Authorize $X." In the new model: "Add your card. Each time someone uses your link, we'll charge for the actual shipping cost up to $X." The mandate language is the consent that classifies subsequent charges as MIT — this is a *required* artifact, not optional copy.

The webhook handler simplifications, the labels-fn rewrite, the dashboard Active/Inactive binary, the URL rotation, the decline-recovery email — all match what the execution proposal already specifies. The research adds: drop the brief-hold-and-cancel pattern in favor of SetupIntent + ZDA, because (a) it's the documented Stripe canonical pattern and (b) the brief-hold-is-invisible claim doesn't hold up.

---

## 10. Open questions for John

1. **Do we want a ZDA verification at save, or is SetupIntent alone enough?** The Airbnb-style verification auth is a small win for the "card accepted" UX moment but costs one extra Stripe call per save (and Stripe's $0.03 ZDA assessment fee per attempt). My recommendation is yes, because the SendMo recipient is about to share the card-on-file with strangers and the visible "verified" check is worth the cost. But it's a product call.

2. **First-shipment-can-fail-silently for cap-equals-or-exceeds-credit-line.** SetupIntent + ZDA validates the card works *for $0/$1*. It does not validate the card has $cap available. If the recipient sets a $500 cap and their card has $50 credit available, the first sender's $50 actual rate succeeds and the second sender's $300 actual rate declines. This is unavoidable given the absence of an "available credit" primitive. Acceptable failure mode? My read: yes — the off_session decline UX is well-designed in this proposal and the recipient learns at most one shipment too late. But flag because the strategy proposal's $cap validation specifically tried to prevent this.

3. **MIT classification compliance bar for international expansion.** US-only today, so the MIT exemption value is mostly forward-looking. If EU/UK launch is on the 12-month horizon, we should make sure the SetupIntent flow surfaces explicit mandate-data and that the consent copy at step 22 captures the "anticipated frequency" language. Worth a small policy review with someone who reads payments law.

4. **Verification re-runs on every Reactivate?** Execution proposal PR1's Reactivate button runs the cap-validation helper. Under the new pattern that helper is just "run a ZDA against the current default PM." Cheaper than the current cap-amount auth. Should Reactivate also re-run the ZDA, or just check the local DB state? My read: re-run the ZDA — it's the only way to catch silent card-replaced-by-bank scenarios that CAU missed.

5. **Periodic background re-validation.** The execution proposal punts this to WISHLIST. With the new pattern it becomes much cheaper (ZDA, not $cap auth). Worth re-evaluating whether shipping a nightly cron in v1 is now cheap enough to be a net-positive UX (catch card failures before a sender hits them). Recommend: defer to scale, but the cost calculus has shifted — note in WISHLIST that this got cheaper.

---

## 11. Risks / what we should monitor after shipping the chosen pattern

| Risk | How it shows up | Telemetry / mitigation |
|---|---|---|
| **Off_session decline rate higher than expected** | Senders see "couldn't process payment" friendly error; recipient inactivity reactivating their card → conversion drop on flex flow | Per-mode dashboard: % of labels-fn flex-charge attempts that decline, broken out by decline_code. Alert if > 5% sustained over 1 week. Existing `stripe_intents.last_payment_error_code` makes this queryable. |
| **MIT misclassification** (Stripe doesn't tag off_session charges as MIT because mandate not properly set) | Higher 3DS challenge rate on off_session charges; surprising `requires_action` returns on charges that should be MIT-exempt | Track `requires_action` rate per charge. Verify in Stripe Dashboard that the mandate is attached to the PaymentMethod (Stripe surfaces this on the PM detail page). |
| **CAU-induced silent card-brand changes breaking MIT consent** | First sender after a CAU update hits a decline that re-running the verification doesn't fix until recipient adds a new card | Subscribe to `payment_method.automatically_updated`; on brand change, flip affected links to Inactive proactively. Already on the WISHLIST per execution proposal §5. |
| **Cardholder confusion about the ZDA verification** | Customer disputes appear citing "unrecognized $0 / $1 charge" | The ZDA is supposed to not appear at all per Visa's design. If they do appear (some issuers display them), include a tooltip on step 22: "Stripe runs a small verification on your card — no money is charged." |
| **Recipient sets cap > card credit limit** | Eventual mid-flow decline as described in Open Q #2 | Surface a soft warning in step 22 if cap > $200 (recipient median Sendmo amount, TBD): "Higher caps may not be approved by your bank — please make sure your card has enough credit available." Defers the unavoidable failure to the recipient's awareness rather than the sender's surprise. |
| **Stripe webhook backlog or outage at SetupIntent.succeeded** | Recipient finishes adding card; the ZDA never runs; link stays draft | Belt-and-suspenders: client-side polls the `payments/validate-link` endpoint that runs the ZDA on-demand if the webhook hasn't done it within 5 seconds. Same idempotency pattern as the rest of the payments fn. |
| **Cap as server-side rule diverges from product copy** | Sender hits "cap exceeded" error after picking a rate the recipient didn't expect them to be denied | Already correctly enforced server-side. Monitor `label.cap_exceeded` event_type frequency; if > 1% of flex labels, the cap UX needs work (likely surfacing the cap to sender at rate-pick time, which is a separate scope). |

---

## Appendix A: sources

Primary Stripe docs:
- [Save and reuse](https://docs.stripe.com/payments/save-and-reuse)
- [Save and reuse cards only](https://docs.stripe.com/payments/save-and-reuse-cards-only)
- [Setup Intents API](https://docs.stripe.com/payments/setup-intents)
- [CIT and MIT](https://docs.stripe.com/payments/cits-and-mits)
- [Place a hold on a payment method](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method)
- [Multicapture](https://docs.stripe.com/payments/multicapture)
- [Card declines](https://docs.stripe.com/declines/card)
- [Card Account Updater overview](https://stripe.com/resources/more/what-is-a-card-account-updater-what-businesses-need-to-know)
- [Authorization holds explained](https://stripe.com/resources/more/authorization-holds-explained)
- [SCA payment flows](https://stripe.com/guides/sca-payment-flows)

Card network references:
- [Visa Core Rules and Visa Product and Service Rules (April 2026 PDF)](https://usa.visa.com/dam/VCOM/download/about-visa/visa-rules-public.pdf)
- [Visa authorization-and-reversal best practices PDF](https://usa.visa.com/content/dam/VCOM/regional/na/us/support-legal/documents/authorization-and-reversal-processing-best-practices-for-merchants.pdf)
- [Visa Authorization Rules (Chargebacks911 summary)](https://chargebacks911.com/visa-authorization-rules/)
- [PayJunction — why you shouldn't charge a hold after 7 days](https://blog.payjunction.com/authorization-hold-credit-card)
- [PaymentNerds — Visa/MC 2025 rule changes](https://paymentnerds.com/blog/visa-mastercard-2025-rule-changes-what-high-risk-merchants-must-know/)

Zero-dollar verification:
- [LegalClarity — ZDA explained](https://legalclarity.org/what-is-a-zero-dollar-authorization-for-card-validation/)
- [MerchantCostConsulting — Visa ZDA fee](https://merchantcostconsulting.com/lower-credit-card-processing-fees/visa-zero-dollar-verification-fee/)
- [HostMerchantServices — ZDA guide](https://hostmerchantservices.com/articles/what-is-the-visa-zero-dollar-verification-fee/)

Comparable platforms:
- [Airbnb — verify your card using temporary authorizations](https://www.airbnb.com/help/article/1820)
- [Airbnb — payment hold or authorization on payment method](https://www.airbnb.com/help/article/3549)
- [Patreon — subscription billing FAQ](https://support.patreon.com/hc/en-us/articles/8779192853261-Subscription-Billing-FAQ)
- [Patreon — per-creation billing](https://support.patreon.com/hc/en-us/articles/360002137871-How-per-creation-billing-works)
- [Substack/Stripe customer story](https://stripe.com/customers/substack)
- [Donorbox — Stripe donations integration](https://donorbox.org/stripe-donations)
- [Etsy — fees & billing](https://help.etsy.com/hc/en-us/sections/360000066248-Fees-Billing)
- [Shopify — shipping labels billing](https://help.shopify.com/en/manual/fulfillment/fulfilling-orders/shipping-labels/billing-and-taxes)
- [Uber Eats — auth holds FAQ](https://help.uber.com/en-GB/ubereats/restaurants/article/authorization-holds---faq-)
- [Uber Eats — group ordering](https://about.ubereats.com/us/en/how-it-works/group-order/)
- [DoorDash — tip adjustment](https://help.doordash.com/consumers/s/article/Can-I-adjust-the-tip-I-provide-to-my-Dasher)

Off_session decline handling:
- [Stripe — authentication_required decline code](https://www.flycode.com/stripe/decline-codes/authentication-required)
- [Stripe — smart retries](https://docs.stripe.com/billing/revenue-recovery/smart-retries)
- [Stripe — manual confirmation for off-session SCA](https://support.stripe.com/questions/manual-confirmation-for-off-session-payments-requiring-strong-customer-authentication-(sca))
