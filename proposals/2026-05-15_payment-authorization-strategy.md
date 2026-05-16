---
title: Payment authorization & capture strategy across SendMo lifecycles
slug: payment-authorization-strategy
project: sendmo
status: draft
created: 2026-05-15
last_updated: 2026-05-15
author: Claude (Sonnet 4.6) session — Phase E shipped 2026-05-15 (commit ab92b3d) on a one-shot hold model that doesn't fit reusable flex links; this proposal walks back the architectural decision before it sees real users
reviewer: TBD — needs fresh-eyes review per PROPOSAL-REVIEW-PROTOCOL before any code lands
---

## 0. TL;DR

The Phase E shipment (today) implements a **one-shot hold-and-capture** model for flex links: recipient authorizes a hold, the first sender captures it, link is consumed. This contradicts the product's reusable-link semantics (one URL, N child shipments over time) and Stripe's structural constraint that a card hold has a 7-day max life and can only be captured once.

This proposal recommends pivoting to a **"validate-once, charge-per-shipment"** model:

- Recipient onboarding: authorize a hold for $X (the cap) as a card-validation test. Once Stripe confirms, immediately void the hold. The saved PaymentMethod is attached to the customer (via `setup_future_usage='off_session'`) and persists.
- Each subsequent sender's use of the link: server creates a fresh PaymentIntent against the saved PM, off_session, for the actual rate. Auto-captured. No pre-hold per shipment.
- Link "funded" state = "recipient has at least one usable saved PM in the correct mode" — not "an authorized hold row exists."

This satisfies the recipient UX goal (catch dead cards / insufficient capacity *before* sharing the link) without burning the 7-day hold window on every link.

The proposal also covers: full-label flow (no change), per-shipment overage charging (master proposal §3.7 hookup), refund-with-delay UX, off_session decline recovery, and how Phase 3 escrow layers on top.

**This requires reverting two pieces of today's Phase E commit (the labels-fn "capture-the-held-PI" branch and the webhook's `succeeded` → `holds.captured` transition) and replacing them with the new model. The onboarding step 22 UX and the `holds` table itself can stay.**

---

## 1. Context

### 1.1 Where Phase E landed today (2026-05-15, commit `ab92b3d`)

Server side:
- `payments` Edge Function accepts `intent_role='flex_hold'`; creates manual-capture PI tied to `link_id`, attaches Customer (lazy), writes `stripe_intents` row.
- `stripe-webhook` handles `payment_intent.amount_capturable_updated` (creates `holds` row, flips link `draft → active`), `payment_intent.canceled` (voids hold, flips link → `expired`), and extends `payment_intent.succeeded` to flip `holds.status = captured` + link `active → in_use`.
- `labels` Edge Function: when called for a flex link (no `payment_intent_id`, has `link_short_code`), looks up the `holds` row, captures the held PI for `display_price_cents`, then buys the EasyPost label. Errors with 402 on missing/expired/insufficient hold.

Client side:
- `RecipientStepFlexPayment` replaced with real Stripe Elements; creates a draft link + flex_hold PI on mount; on `requires_capture`, advances to step 23.
- `SenderFlow` drops the `comp:true` hack; relies on real flex capture.

### 1.2 The product's actual semantics (per John, 2026-05-15)

A flex link is a reusable URL. The recipient shares it once. **N senders use it over time, each spawning a child shipment**. The recipient sets it up once and forgets it.

### 1.3 Why Phase E doesn't match

Stripe `capture_method='manual'` PIs:
- One PI = one capture. After capture, the PI is in terminal state `succeeded`; you cannot capture again from it.
- Card holds expire automatically after 7 days (this is a card-network constraint, not a Stripe setting; there is no override).
- An uncaptured PI cancelled before 7 days releases the hold immediately.

Implications for the Phase E model:
1. After the **first** sender uses a link, the hold's PI is captured. The link has no remaining authorization for the **second** sender — `labels` fn returns 402 ("No active payment authorization for this link").
2. Even if no one uses the link, the hold expires after 7 days. Recipient must re-authorize.
3. The recipient's mental model — "I set up my link, now anyone can use it whenever" — is broken by the one-shot capture.

### 1.4 The constraint that drives the design

You cannot pre-authorize an unbounded number of future charges in a single Stripe hold. Stripe doesn't expose that primitive (and card networks don't support it). The only mechanism for repeated charges to a single customer is **off_session charges against a saved PaymentMethod**.

Conclusion: hold-then-capture is the wrong primitive for a reusable link. The right primitive is **save-PM-then-charge-per-event**. The "pre-auth" the user mentally wants is a one-time card test, not an ongoing reservation.

### 1.5 What the recipient UX value of pre-auth actually is

John's instinct (2026-05-15): "I really think the pre-auth is a valuable thing so people don't have a surprise when they share the link and then the payment doesn't have enough balance on the card."

This is a real UX win. The pre-auth proves two things at onboarding time:
- The card is valid (not expired, not stolen, issuer accepts it).
- The card has at least $X in available credit (the cap amount).

Both can be checked with a single test authorization. Once verified, the hold can be voided. The information is captured ("card was good enough") without continuing to lock funds.

This is the same pattern hotels, car rentals, and Stripe Identity verification use for "validate but don't yet charge" — except those generally hold the funds until checkout, where we want to release immediately.

---

## 2. Stripe primitive cheat sheet

What's possible and what isn't, summarized so the rest of the proposal sits on shared ground:

| Operation | Stripe primitive | Constraints |
|---|---|---|
| Take card details from user, save for later | SetupIntent OR PI with `setup_future_usage` | Requires UI (PaymentElement); user must be on-page |
| Authorize a hold for $X without charging | PI `capture_method='manual'`, then user confirms via UI | Max 7-day card hold; one capture per PI |
| Release an authorized hold | `PaymentIntent.cancel` | Synchronous; immediate release on most cards |
| Capture a hold for ≤$X | `PaymentIntent.capture` with `amount_to_capture` | Excess released by Stripe automatically |
| Charge a saved PM without user present | PI `confirm: true, off_session: true, payment_method=<pm>` | Requires prior consent ("on-session"); SCA-exempt only when properly tagged |
| Validate a card without holding funds | $0-amount Setup or PI; or low-amount auth+void | $0 only on some networks; auth+void is universal |
| Extend an existing hold's amount | `incremental_authorization` | In-person / Terminal only; not available online |
| Stack multiple pre-auths on same customer | Allowed by Stripe; no documented limit | Limited by customer's card credit (issuer-side) |

**Per-customer pre-auth limits:** No Stripe-imposed cap on concurrent uncaptured PIs per customer. The practical cap is the customer's card credit line — every uncaptured PI ties up $X of that line for up to 7 days, so stacking pre-auths is hostile to the cardholder. Issuers will start declining once the cumulative hold approaches the credit limit.

**Off_session declines:** When charging a saved PM off_session, the customer is not on-page to handle 3DS, insufficient funds, or expired-card prompts. Stripe returns an `authentication_required` or generic decline error. Recovery requires routing the customer back on-session (email link → return to dashboard → update card).

---

## 3. Lifecycle map — when payment touches the user

This section is the spine of the proposal. Every box is a moment where we either move money, authorize money, or check whether money is movable. The current Phase E commit and the recommended pivot both map onto this lifecycle differently.

```
Full-label flow:
[Onboarding step 12] → CHARGE (immediate capture, $exact)
[Label generated]    → no payment activity
[Label cancelled]    → REFUND (delayed: EasyPost confirms void, then Stripe refund)

Flex-link flow (proposed):
[Onboarding step 22] → AUTHORIZE $X (cap), then VOID immediately
                       ↳ side effect: PM attached to Customer for future off_session
[Link shared]        → no payment activity (link is "funded with saved PM")
[Sender uses link]   → CHARGE off_session ($actual, capped at link.max_price_cents)
[Label generated]    → no payment activity (charge already happened)
[Label cancelled]    → REFUND (delayed, same path as full-label)
[Card removed/expired]
  Sender attempts use → off_session DECLINE → sender sees clean error,
                        recipient notified to update card

Future twists (John 2026-05-15):
[Carrier reweighed]  → OVERAGE charge off_session (master proposal §3.7)
[Disputed]           → CHARGEBACK ledger row (existing handler)

Phase 3 escrow (out of scope here, sketched in §10):
[Sender confirms]   → CHARGE shipping (off_session, same as flex)
                    → AUTHORIZE escrow $item (off_session, manual capture)
[Delivered]         → CAPTURE escrow → transfer to seller's Connect account
[Disputed]          → escrow CANCELED → refund buyer
```

---

## 4. Recommended model — "validate-once, charge-per-shipment"

### 4.1 Recipient onboarding (step 22)

1. Server creates PI: `amount=$X (cap), capture_method='manual', customer, setup_future_usage='off_session', metadata.intent_role='flex_validation'` (NB: rename from `flex_hold` to make the new semantics explicit).
2. Client confirms via PaymentElement. Stripe authorizes against the recipient's card.
3. Webhook receives `payment_intent.amount_capturable_updated`:
   - Mark `stripe_intents.status='requires_capture'` (existing)
   - **NEW**: immediately call `cancelPaymentIntent` to release the hold
   - On cancellation success: insert a `payment_validations` row (new table, see §6) with `link_id, customer_id, validated_amount_cents, validated_at`
   - Flip `sendmo_links.status` `draft → active`
   - DON'T write a `holds` row at this point — the model's new
4. Webhook receives `payment_intent.canceled` (from our own cancel call):
   - Mark `stripe_intents.status='canceled'` — terminal state for this validation PI
   - No further action; the side effect (PM attached to Customer) is the deliverable

What persisted:
- `profiles.stripe_customer_id_<mode>` (existing)
- The PaymentMethod attached to that Customer (via `setup_future_usage` side effect)
- `payment_methods` table row (existing; written by `payment_method.attached` webhook)
- `payment_validations` row (new) — proof the card was tested for $X
- `sendmo_links.status = 'active'`

What's gone:
- The held funds. The customer's card was authorized for $X for a few seconds, then released.

### 4.2 Per-shipment capture (sender uses link)

1. `labels` Edge Function called with `link_short_code` (existing flow).
2. Server resolves link → recipient user → recipient's default `payment_methods` row for the link's mode.
3. **Cap check** (existing, unchanged): server derives `display_price_cents` from EasyPost rate; rejects if > `link.max_price_cents`.
4. **NEW** Server creates fresh PI: `amount=$actual_rate, capture_method='automatic', customer, payment_method=<saved_pm>, off_session=true, confirm=true, metadata.link_id, metadata.shipment_id (post-buy)`.
5. PI status response:
   - `succeeded` → continue to EasyPost buy
   - `requires_action` (rare, off_session 3DS) → fail with "Card requires authentication. Recipient must update card." Cancel the PI.
   - `declined` (insufficient funds, fraud, etc.) → fail with clean sender-facing message + queue recipient notification.
6. Webhook receives `payment_intent.succeeded` → existing ledger row (+charge) + fee_stripe row. NO `holds` row updates, NO link status changes (link stays `active` for future shipments).
7. On EasyPost buy failure (existing logic): auto-refund the just-captured amount.

### 4.3 Link status semantics

`sendmo_links.status` transitions in the new model:

| Status | Trigger | Meaning |
|---|---|---|
| `draft` | Created at step 22 (onboarding) | Awaiting first validation |
| `active` | Validation succeeded (webhook canceled the hold cleanly) | Card validated; senders can use |
| `expired` | Recipient removes the last PM on this customer | Sender flow shows "needs payment" |
| `cancelled` | Recipient manually deactivates | Hard off; sender shows "link unavailable" |

NB: the existing `in_use` and `completed` statuses are removed from the flex flow. They were inherited from one-shot semantics that no longer apply. (Full-label still uses `used` for its "label-already-bought viewer link" semantics — that's a different code path.)

The dashboard "Needs payment" badge (today's commit `b73dd7c`) now checks:
- For each flex link: does the link's owner have any non-deleted `payment_methods` row in the correct mode?
- If no: render "Needs payment"
- If yes: render "Active"

(The current `holds` table check becomes obsolete for this purpose.)

### 4.4 Migration of in-flight Phase E data

Today's commit created (a) the `holds` table records-keeping path and (b) the labels-fn capture branch. Neither is yet exercised by real users (Phase E was never browser-verified). Practical migration:

- Drop or no-op the labels-fn capture-the-held-PI branch (replace with the off_session-charge branch).
- Webhook's `payment_intent.amount_capturable_updated` handler: change "insert holds row" to "cancel the PI".
- Webhook's `payment_intent.succeeded` for flex_hold: remove the `holds.status = captured` + `links.status = in_use` updates (those don't fit anymore).
- The `holds` table can stay in the schema for Phase 3 escrow (which DOES need hold-and-capture semantics — see §10) but the flex flow stops writing to it.

---

## 5. Per-circumstance breakdown

How the model behaves across the matrix of (flow type) × (lifecycle event):

### 5.1 Full-label (no change from today)

| Event | Action |
|---|---|
| Onboarding step 12 | Server creates PI ($exact, capture_method='automatic'). Recipient confirms. Stripe captures immediately. |
| EasyPost buy succeeds | Continue, write transactions.charge row. |
| EasyPost buy fails | Auto-refund (existing logic). |
| Label voided pre-pickup | cancel-label → EasyPost void → tracking polls → Stripe refund → transactions.refund row. Delayed (2-4 weeks per carrier policy). |
| Carrier reweighs after pickup | Future: overage charge off_session against saved PM (master §3.7). |

### 5.2 Flex link — first shipment ever

| Event | Action |
|---|---|
| Onboarding step 22 | Server creates PI ($cap, manual, setup_future_usage). Recipient confirms via Elements. |
| Webhook: amount_capturable_updated | Cancel PI immediately. Write payment_validations row. Link → active. |
| Recipient shares URL | No payment activity. |
| Sender uses link | Server creates fresh PI ($actual, off_session, customer, saved_pm). Captured. EasyPost buy. |
| EasyPost buy fails | Auto-refund the just-captured PI (existing logic, works as-is). |

### 5.3 Flex link — Nth shipment (same recipient, same card)

Same as 5.2 from "Sender uses link" onward. The card is already saved; the per-shipment PI uses it directly. No re-authorization needed.

### 5.4 Flex link — card declined off_session

| Event | Action |
|---|---|
| Sender confirms label | Server creates off_session PI → Stripe returns `card_declined` or `authentication_required`. |
| Server response | Cancel the failed PI. Return 402 to sender with "Payment couldn't be processed. The recipient needs to update their payment method." |
| Notification fan-out | Email recipient: "A sender tried to use your link but your card was declined. Update at sendmo.co/dashboard." |
| Recipient dashboard | "Needs payment" badge surfaces. CTA: "Update card" (routes to Add Card modal). |
| Recipient adds new PM | Webhook (payment_method.attached) writes new row. New PM becomes default. Link returns to active automatically (no further action). |

### 5.5 Flex link — recipient removes all saved cards

`payment_method.detached` webhook fires. If detaching the last card for this user in this mode, flip all the user's flex links to `status='expired'`. Same recovery path as 5.4.

### 5.6 Flex link — recipient deletes link

`sendmo_links.status = 'cancelled'`. Sender flow: "This link is no longer available." Existing logic.

### 5.7 Carrier adjustment (overage)

When the carrier reweighs a package post-pickup and bills SendMo for more than the captured amount:

| Event | Action |
|---|---|
| EasyPost notifies of adjustment | Webhook writes `carrier_adjustments` row (master §3.7). |
| Server checks the original shipment's saved PM | If still valid, create off_session PI for the overage amount. |
| Cap on per-shipment cumulative adjustment | $10 (master proposal cap). |
| Cap on per-card per-24h adjustments | $20 (master cap). |
| Overage charge succeeds | transactions.carrier_adjustment row. |
| Overage charge fails | Notify recipient; SendMo eats the cost until card updated. |

### 5.8 Cancel + refund (label voided pre-pickup)

| Event | Action |
|---|---|
| Sender (or admin) hits Cancel | cancel-label → EasyPost void → set shipments.refund_status='submitted'. |
| EasyPost confirms void (days later) | tracking poll triggers Stripe createRefund. |
| Stripe webhook: charge.refunded | transactions.refund (-amount) + shipments.refund_status='refunded'. |
| User sees | "Refund Pending" → "Refunded" in tracking page. The 2-4 week carrier delay is real and user-visible (per SPEC §13.1). |

This is unchanged from existing implementation; flex doesn't change refund handling.

### 5.9 Comp labels (admin)

No payment, no validation. Existing logic. Out of scope here.

---

## 6. Schema changes

### 6.1 New table: `payment_validations`

```sql
CREATE TABLE public.payment_validations (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES public.profiles(id),
    link_id                 UUID REFERENCES public.sendmo_links(id),
    customer_id             TEXT NOT NULL,
    validated_amount_cents  INTEGER NOT NULL,
    stripe_intent_id        TEXT NOT NULL,  -- the PI that was authorized + voided
    validated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    mode                    TEXT NOT NULL CHECK (mode IN ('test','live'))
);
CREATE INDEX idx_payment_validations_user ON public.payment_validations (user_id, mode);
CREATE INDEX idx_payment_validations_link ON public.payment_validations (link_id);
```

Audit trail for "this card was tested for $X on this date." Useful for forensics if a card is later declined despite passing validation.

### 6.2 `sendmo_links.status` CHECK constraint update

The existing enum is `('draft', 'active', 'in_use', 'completed', 'expired', 'cancelled')`. Under the new model, flex links don't use `in_use` or `completed`. We can either:
- Leave the enum unchanged and just not write those values for flex (drift hazard)
- Add a comment or trigger that documents flex-vs-full-label status semantics

Recommend: leave enum, add column comment + trigger comment. The status semantics are different per link_type and that's OK.

### 6.3 `holds` table

Keep the schema as-is. Mark "not used by flex flow as of <date>; reserved for Phase 3 escrow." Add comment.

### 6.4 Migration plan

```sql
-- migration_NNN_payment_validations.sql
CREATE TABLE public.payment_validations (...);  -- per §6.1

COMMENT ON TABLE public.holds IS
  'Pre-authorized payment holds. As of 2026-05-NN, flex flow no longer
   writes here — it uses the validate-once / charge-per-shipment model
   (proposals/2026-05-15_payment-authorization-strategy.md). This table
   is reserved for Phase 3 escrow, which genuinely needs hold-and-capture
   semantics for item-cost authorizations.';
```

No backfill needed — Phase E was never used in production.

---

## 7. Edge cases & open questions

### 7.1 What happens between the authorize and the immediate cancel?

The webhook event `payment_intent.amount_capturable_updated` typically fires within 1-3 seconds of the confirmation. The cancel call adds another ~1 second. Total window: a few seconds with the hold actually live.

During that window, the customer sees a pending charge on their card (depending on issuer, can be near-instant or take minutes to appear). If they refresh their banking app between authorize and cancel, they see the hold. If they refresh after, they see nothing.

**Risk:** If the cancel call fails (network blip, Stripe outage), the hold stays live until Stripe auto-expires it (7 days). Recipient sees a $X pending charge that never resolves.

**Mitigation:** Retry the cancel from the webhook (idempotent), and add a cron job that scans for `stripe_intents` rows with `intent_role='flex_validation', status='requires_capture'` older than 5 minutes and force-cancels them.

### 7.2 What if multiple senders open the link simultaneously?

Two senders click the link at the same time. Each enters package details, picks a rate, hits confirm. Both labels-fn invocations try to create off_session PIs against the same saved PM.

Stripe handles this fine — they're independent PIs. As long as both have funds, both succeed. If the card has only $X capacity and shipment 1's charge eats it, shipment 2's off_session charge declines naturally.

No coordination needed. The race is benign.

### 7.3 What if the recipient's saved PM has multiple cards?

Today we pick the `is_default=true` row. That's fine. Recipient can change default via dashboard (existing UI).

### 7.4 Recipient cancels card at issuer (lost wallet) without telling SendMo

Same as 5.4 — off_session declines, sender sees "couldn't process," recipient notified.

### 7.5 Recipient never updates after a decline

Link stays in `expired` state. Sender always sees "needs payment" message. No money lost. Recipient inertia is acceptable failure mode.

### 7.6 Card expiry approaches (e.g., expires next month)

Stripe sends a `payment_method.automatically_updated` event when the network pushes a new card number/expiry. We already handle `payment_method.attached`; should also handle this event to update our `payment_methods` row.

**Open**: do we also proactively warn recipients 30 days before expiry via email? Probably yes, but separate scope.

### 7.7 Periodic health check on saved PMs

Some services do a periodic $0 or $1 auth+void to confirm cards are still valid (e.g., monthly). This catches "card replaced" / "credit cut" before a real sender tries to use the link and fails.

**Open**: do we ship this in v1, or defer? My read: defer. Off_session decline handling (§5.4) is sufficient for v1; periodic checks add infrastructure (cron, webhook handler for periodic auth results, customer-facing comm) for marginal benefit at low scale.

### 7.8 What if the cap changes after the link is funded?

Recipient edits link's `max_price_cents` from $100 to $50 via dashboard. The original validation was for $100. We don't need to re-validate — the cap check at sender time uses the current `max_price_cents`. Off_session charges will simply be rejected by our own cap-check if they exceed the new cap.

### 7.9 What if a recipient creates many links and we never validate each one?

The validation is **per-customer**, not per-link. Once the recipient has a saved PM, all their flex links benefit from it. The validation step at link creation is essentially a "do you have a valid card on file?" check that auto-passes for returning users.

For first-time users: do the validate-and-void on first link. For returning users with an existing PM: skip the validate step and create the link directly. Surface this in the onboarding UX as "Your card on file is ready — link active immediately."

**Open**: do we still want the validate step for returning users? Trades off friction vs the "what if the saved card silently went bad" question. My read: only do periodic re-validation if §7.7 ships; otherwise skip the validate for returning users.

---

## 8. Off_session decline handling — UX details

When the labels-fn off_session charge declines, the sender is mid-checkout. We need to:

1. **Sender response (clean error):**
   ```
   "Your payment couldn't be processed right now. The recipient may need
    to update their payment method before this link will work. We've
    let them know."
   ```
   No technical detail. No card brand. Just a friendly stop-the-press message.

2. **Recipient notification (email + dashboard banner):**
   - Email subject: "Action needed: your SendMo link needs payment update"
   - Body: "{Sender first name or 'A sender'} tried to use your SendMo link, but your card ({brand} •••• {last4}) was declined. Tap to update."
   - CTA: deep link to dashboard with `?fix-payment=1` query param that opens Add Card modal automatically.

3. **Dashboard state:**
   - "Needs payment" badge (existing from today's commit).
   - Inline error card under "My Label Link": "Last shipment attempt was declined on {date}. Update your card to keep your link active."
   - Audit log: write a row to `event_logs` so support can reconstruct the decline.

4. **Sender retry:**
   - Once recipient updates card, link returns to active automatically.
   - Sender can refresh `/s/<short_code>` and try again. (Or we send them a "link is active again" email if we captured their email — flex senders are anonymous by default but the package step has an optional email field.)

---

## 9. Phased rollout

Recommend three-PR sequence, each independently shippable:

### Phase E.1 — pivot the server-side capture model (this proposal's core)

- Webhook `amount_capturable_updated`: cancel the PI immediately, write `payment_validations` row, flip link to `active`. Drop the `holds` write.
- Webhook `payment_intent.succeeded`: drop the `holds.captured` + `links.in_use` updates for flex.
- Webhook `payment_intent.canceled`: detect "our own cancel" vs "Stripe auto-expire" (via `cancellation_reason='requested_by_customer'`); the former is no-op (already handled), the latter triggers a "validation expired, link needs re-auth" path — but in the new model, validation cancel is normal so no special handling required.
- Labels fn: replace flex capture branch with off_session PI creation against the saved PM.
- Recipient onboarding (step 22): no UI change. Still shows "Authorize $X" copy. The copy is honest — we ARE authorizing, just releasing immediately after confirmation.
- Step 23 (link ready): copy update from "Your link is active — up to $X hold" to "Your link is active — card validated for up to $X per shipment."

### Phase E.2 — off_session decline notification

- Email template for "card declined, update needed."
- Dashboard banner under My Label Link card.
- Deep link from email → dashboard with auto-open of Add Card modal.

### Phase E.3 — returning-user fast path

- At onboarding step 22 for users with existing valid PM: skip the validate-and-void; create the link directly.
- UX: "Your saved card (Visa •••• 4242) will be used for this link. [Use different card]"

### Out of scope here (separate proposals):

- Periodic health checks on saved PMs (§7.7)
- 30-day expiry warnings (§7.6)
- LinksEditor (/links/new) integration — currently creates links without any payment validation; needs the same step-22-equivalent (today's WISHLIST follow-up)
- Phase 3 escrow (sketched in §10; needs its own proposal)
- Overage / carrier adjustment charging (master proposal §3.7; infrastructure exists, code doesn't)

---

## 10. Phase 3 escrow — how this composes

Escrow links (marketplace use case: buyer pre-pays for both shipping AND the item value, seller gets the item value released on delivery) have genuinely different payment semantics from flex.

Per master proposal §3.8 (revised round 2): escrow is **single-PI + separate Stripe transfer to seller** at clearance. The PI authorizes shipping + item, captures immediately; the item portion is held on SendMo's platform balance and released to the seller's Connect account on delivery confirmation; on dispute, SendMo refunds the buyer (shipping is retained since the carrier already executed).

The `holds` table that this proposal vacates from the flex flow becomes the right home for tracking the item-portion of escrow PIs — "authorized to release" / "released" / "refunded to buyer" lifecycle.

So: the model split is

- **Flex**: validate-once + charge-per-event (this proposal)
- **Escrow**: hold-the-item-portion + capture-on-delivery / refund-on-dispute (Phase 3)

Each uses different Stripe primitives because the product semantics differ.

---

## 11. Open questions for review

Items I want the fresh-eyes reviewer (and John) to push on:

1. **Validate-and-void timing.** §7.1 — is the 1-3 second visible-hold window acceptable, or do we need to hide it entirely (e.g., $0 SetupIntent path instead of PI+cancel)? SetupIntent is cleaner but doesn't validate available credit; PI+cancel validates but exposes the brief hold. Stripe's recommended pattern for "validate card has $X" is PI+cancel.

2. **Returning-user validate skip (§7.9 + Phase E.3).** Skip the validate-and-void for users with existing PMs, or always do it? Friction vs decline-surprise tradeoff.

3. **Periodic re-validation (§7.7).** Ship in v1 or defer? Cost: one cron + one webhook handler. Benefit: catches dead cards before a sender hits the failure.

4. **Cap migration.** Existing flex links from before Phase E have `status='active'` and no `payment_methods` row tied to a hold context (they predate the whole concept). After this proposal lands, those links will all show "needs payment" because the user-customer-PM lookup will find nothing. Do we (a) accept this as correct surfacing of a real broken state, (b) backfill a no-op validation row for legacy links to keep them "active" until first decline, (c) something else? My read: (a). The previous comp-mode flex flow was unfunded; surfacing that is honest.

5. **What if a recipient has saved PMs in test mode but not live mode (or vice versa)?** Each mode has its own Stripe Customer. The link's `is_test` determines which mode's PM pool is checked. If a recipient validates a test card and then admin switches the link to live, the live check finds no PM. **Open**: handle this as "needs payment in live mode" with a re-validate prompt? Or block the mode-switch?

6. **Webhook event subscriptions.** Today's Phase E commit relies on `payment_intent.amount_capturable_updated` and `payment_intent.canceled` being subscribed in the Stripe Dashboard (verified by John 2026-05-15). After this proposal lands, `amount_capturable_updated` is still required; `canceled` is required (for both our own cancel and for any future auto-expire). No new event subscriptions needed.

7. **off_session SCA.** EU/UK card issuers may require 3DS even for off_session charges in some scenarios. Stripe returns `requires_action`. **Open**: in v1, do we treat this as "decline" and notify recipient, or try to send the sender's optional email a "click here to confirm payment" link with a Stripe-hosted 3DS challenge? My read: v1 = treat as decline; v2 = SCA-recovery flow.

---

## 12. Decision needed from John

Before this is ready for fresh-eyes review:

1. **Approve the pivot.** Does "validate-once, charge-per-shipment" match your mental model? Walk through §3 (lifecycle map) and §5 (per-circumstance) and tell me if anything's off.
2. **Phase E.1 timing.** Revert today's flex-capture code now, or queue this whole proposal for review-then-implement? My read: revert now, ship Phase E.1 ASAP, then write a clean implementation. The current code being on `main` but unverified is worst-of-both.
3. **Open question #1 (validate-and-void timing).** PI+cancel with brief visible hold, or SetupIntent without credit check?
4. **Open question #4 (cap migration).** Legacy unfunded links — accept they break, or backfill?
5. **Open question #5 (mode mismatch).** Block live-mode link if only test PMs exist, or surface a re-validate prompt?

---

## Appendix A: comparison vs alternatives considered

| Alternative | Why not |
|---|---|
| **Keep hold-and-capture (Phase E as shipped)** | Breaks reusable-link semantics; 7-day hold cap; one capture per PI. |
| **Rolling re-authorization (capture+create new hold each shipment)** | Adds two Stripe ops per shipment, latency, decline risk mid-cycle. Doesn't scale past 1 active hold per link. |
| **Multiple pre-auths stacked** | Eats customer's credit line for shipments that may never happen. Customer-hostile. |
| **No pre-auth, just save PM at onboarding via SetupIntent** | Loses the "card has $X capacity" check, the actual UX value John flagged. |
| **Validate-and-void (this proposal)** | Keeps UX value, fits reusable semantics, uses standard Stripe primitives. |

## Appendix B: references

- Master Stripe integration plan: `proposals/2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md` (§3.4 PI lifecycle, §3.7 carrier adjustments, §3.8 escrow shape, §4.4 mode resolution)
- Account creation timing: `proposals/2026-05-11_account-creation-timing_reviewed-2026-05-11_decided-2026-05-11.md` (sets the precedent for proposal review process)
- SPEC §13 Payment System + §13.1 Label Void & Refund Policy
- PROPOSAL-REVIEW-PROTOCOL.md (review process)
- Today's Phase E commit: `ab92b3d` (will be largely superseded by E.1 if this proposal lands)
- Today's UX-state commit: `b73dd7c` (the "needs payment" badge + sender early-fail — survives the pivot intact)
