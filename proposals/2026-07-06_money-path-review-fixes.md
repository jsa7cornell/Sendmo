---
title: Money-path review fixes — price integrity, comp retirement, refund ledger, sweep window (D1–D4)
slug: money-path-review-fixes
project: sendmo
status: in-review
created: 2026-07-06
last_updated: 2026-07-06
reviewed: null
decided: null
author: Claude (Fable 5) — full-codebase money-path review session, 2026-07-06 (main @ 83d62ce); fixes being implemented in parallel on the recommended options
reviewer: null
outcome: null
---

> **Why this is a proposal and not just a fix PR:** a full code review of the money path
> today found two launch-blocking exploits (buy a $50 live label for 50¢; mint free live
> labels with any flex-link URL) and two refund-correctness bugs that can move real money
> the wrong way. The *code fixes* are mechanical and are being implemented in parallel.
> What earns the protocol is the four **design decisions** baked into those fixes — each
> one closes an alternative that a future session might otherwise re-open, and one (D2)
> retires an authorization path that a decided proposal deliberately created. This file
> records the decisions, the options considered, and the risks, so the review is of the
> *design*, not a race against the diff.

## 1. Context

Today's full code review (main @ `83d62ce`) walked every function that touches money:
`payments`, `labels`, `stripe-webhook`, `tracking`, `webhooks`, `cron-refund-sweep`,
`refunds`, and the `_shared` helpers. It matters *now* because
[`2026-07-04_customer-live-payments`](2026-07-04_customer-live-payments_reviewed-2026-07-04_decided-2026-07-04.md)
(T1-1) is live in closed beta — strangers are about to move real money through these
paths, and two of the findings are exploitable by any visitor with a browser.

The review produced four design-bearing findings (D1–D4 below, each a decision) plus a
set of mechanical fixes that need no decision (§6). Severity, in plain terms:

| # | Finding | Severity | Money at risk |
|---|---------|----------|---------------|
| D1 | Client-controlled price on the full-label leg | **Launch blocker** | Pay 50¢, get a $50 live label |
| D2 | comp + flex link mints free live labels | **Launch blocker** | $0 paid, real label bought |
| D3 | Refund ledger books cumulative amounts; zero-balance paths refund "all remaining" | High | Ledger overstates refunds → real over-refunds |
| D4 | Refund sweep gives up at day 21; policy window is 2–4 weeks | Medium | Contradictory customer emails, stuck terminal state |

## 2. D1 — Full-label price integrity (launch blocker)

### The bug

Two functions each assume the other one checked the price. Neither does.

```
client ──amount_cents──▶ payments/index.ts        creates PI for ANY amount ≥ 50¢
                          (only floor check)        never compared to the EasyPost rate

client ──display_price_cents──▶ labels/index.ts   buy-time rate gate compares the
        (body value, labels:96)                     EP rate against the BODY value
                                                    (labels:999) — and SKIPS the gate
                                                    entirely when the body omits it
```

- [`payments/index.ts`](../supabase/functions/payments/index.ts) accepts a client-supplied
  `amount_cents` with only a `>= 50` floor check. It already fetches the EasyPost shipment
  (line ~375, for Radar `shipping` bundling) — but never reads the rate off it.
- [`labels/index.ts:96`](../supabase/functions/labels/index.ts) takes `display_price_cents`
  from the request body on the full-label leg. The buy-time rate gate (the safety net
  from [`2026-05-23_buy-time-rate-gate`](2026-05-23_buy-time-rate-gate.md)) compares the
  EasyPost buy-time rate against that body value at labels:999 — and the gate condition
  `gateDisplayCents > 0` means an *absent or zero* body value skips the gate entirely.
- Nothing anywhere compares `pi.amount` to the EasyPost rate.

**Net effect:** an authenticated customer can create and confirm a 50¢ PaymentIntent,
then call `labels` with `display_price_cents: 50` (or omit it) and buy a $50 live label.
The rate gate — built precisely to stop under-priced buys — is fed the attacker's number.

Note the contrast with the flex leg: there the server already resolves price from the
link's cap server-side (Rule 14, decided in
[`2026-05-11_sender-flow-wizard`](2026-05-11_sender-flow-wizard_reviewed-2026-05-11_decided-2026-05-11.md)).
The full-label leg never got the same treatment because at the time it was admin-only.

### Options

**(a) — RECOMMENDED, being implemented: gate on the PI amount, never skip.** The full-label
leg already verifies the PaymentIntent against Stripe and holds `verifiedPaymentIntent.amount`
(labels:896) — the server-known truth for what the customer actually paid. Set the rate-gate
basis from that instead of the body value, never skip the gate when a PI exists, and persist
`display_price_cents` from the PI amount too (so the stored record reflects money that moved,
not a client claim). The body `display_price_cents` becomes advisory-only on this leg.

**(b) — Alternative, deferred as fast-follow: validate at PI creation.** `payments` already
fetches the EP shipment at :375; it could also read the chosen rate and reject
`amount_cents < applyMarkup(rate)` before the PI ever exists. This is genuine defense in
depth (catches the attack one step earlier, before any money is authorized) and we want it
— but it is *additive* to (a), not a substitute: the buy is the moment money converts to an
irreversible label, so the gate must live there regardless. Deferred so the launch blocker
ships minimal.

**(c) — Rejected: keep body value but require it.** Making `display_price_cents` mandatory
closes the skip but still trusts the attacker's number. Not a fix.

### Risks

- **Legit rate drift now 409s.** If the rate genuinely moved between quote and buy, the gate
  fires against the (honest) PI amount and returns the existing 409 `rate_changed` +
  void-and-refund behavior. That is the gate working as designed since
  `2026-05-23_buy-time-rate-gate` — no new failure mode, just no more silent skips.
- Client paths that legitimately omitted `display_price_cents` relied on the skip; after the
  fix they go through the gate on the PI amount, which is strictly more correct.

## 3. D2 — Retire comp-via-flex-link (launch blocker)

### The bug

[`labels/index.ts:386`](../supabase/functions/labels/index.ts) — the comp gate reads:

```ts
if (isComp && !resolvedLink) { /* require admin JWT */ }
```

So `comp: true` **with** an active flex link skips the admin check — and with it the entire
payment branch, including the live-mode kill switch and the allowlist. Anyone who has a flex
link URL (they're shared by design — that's what flex links are *for*) can mint free labels,
live ones included. No card, no charge, real postage.

### How we got here (drift, not a new invention)

This is drift from a decided design whose premise expired.
[`2026-05-11_sender-flow-wizard`](2026-05-11_sender-flow-wizard_reviewed-2026-05-11_decided-2026-05-11.md)
deliberately built the sender flow comp-only — the "admin-JWT-**or**-active-flex-link" gate —
because Stripe Phase E was blocked and comp was the only way flex links could produce labels
at all. Then Pattern D
([`2026-05-16_flex-payment-pattern-d-execution`](2026-05-16_flex-payment-pattern-d-execution_reviewed-2026-05-16_decided-2026-05-18.md),
decided 2026-05-18) made flex charge real money — but the comp authorization the wizard
introduced was never retired. The gate's own comment still cites "proposal §3.5" as if the
2026-05-11 premise held.

### Options

**(a) — RECOMMENDED, being implemented: comp requires an admin JWT, unconditionally.**
Delete the `!resolvedLink` escape. `comp: true` means "an admin is deliberately issuing a
free label" — the link's presence is irrelevant to that authorization. One-line gate change
plus comment cleanup.

**(b) — Rejected: keep comp-via-link but add the kill switch/allowlist checks inside it.**
Patches the symptoms (free *live* labels) but leaves the design wrong: possession of a URL
is not authorization to skip payment. Every future payment-branch safeguard would need to be
mirrored into the comp branch forever.

**(c) — Rejected: remove comp entirely.** The admin onboarding comp path is real and used;
retiring the *flex-link* authorization is the surgical scope.

### Risks

- **A residual client path sending `comp: true` + a link would break.** Expected: none —
  the only comp sender should be the admin onboarding path, which doesn't pass a link. The
  implementer must `grep` `src/` for every `comp` send-site and confirm before merge; if one
  exists, that's a finding to surface, not silently accommodate.
- No customer-visible change otherwise: paying flex senders never set `comp`.

## 4. D3 — Refund ledger sourcing + idempotency keying

### The bug (two compounding halves)

**Half 1 — the webhook books the wrong number.**
[`stripe-webhook/index.ts:700-745`](../supabase/functions/stripe-webhook/index.ts),
`charge.refunded` arm:

```ts
const refundData = charge.refunds?.data?.[0];
const refundAmount = (refundData?.amount ?? charge.amount_refunded ?? 0);
const stripeRefundId = refundData?.id ?? `${charge.id}_refund`;
```

Under our pinned Stripe API version (`2026-04-22.dahlia`), `charge.refunds` is **not
expanded** in webhook payloads — so the fallback is the common path, and
`charge.amount_refunded` is **cumulative**. First partial refund of $5: books −$5 (correct,
by luck). Second partial refund of $3: `amount_refunded` is now $8, so the ledger books −$8
— **overstating total refunds by $5**. The refund id likewise falls back to the synthetic
`${charge.id}_refund`, so distinct refunds collide on the `refunds` upsert.

**Half 2 — the zero-balance paths refund "everything remaining."**
[`tracking/index.ts:260`](../supabase/functions/tracking/index.ts) and
[`webhooks/index.ts:582`](../supabase/functions/webhooks/index.ts) both do:

```ts
amount_cents: refundableBalance > 0 ? refundableBalance : undefined,
```

In `createRefund`, `undefined` means **refund the full remaining charge** (Stripe default) —
so when the *ledger* says the balance is ≤ 0, instead of skipping, these callers ask Stripe
to refund whatever Stripe still thinks is refundable.
[`cron-refund-sweep/index.ts:316`](../supabase/functions/cron-refund-sweep/index.ts) gets
this right: it checks `refundableBalance > 0` and skips otherwise.

**The compounding:** Half 1 makes the ledger overstate refunds → the computed balance hits
≤ 0 while Stripe still holds refundable money → Half 2 converts that bookkeeping error into
a **real over-refund** on the customer's card.

### Options

**(a) — RECOMMENDED, being implemented:**
1. In the `charge.refunded` arm, **retrieve the charge's refunds explicitly from Stripe**
   (one API call) and book **one ledger row per refund object**, keyed
   `stripe.refund.<rfnd_id>`. Per-refund keying converges: however many events or replays
   arrive, each real refund books exactly once, at its own amount. The synthetic
   `${charge.id}_refund` fallback dies with it.
2. All three cancel-refund initiators (`tracking`, `webhooks`, `cron-refund-sweep`) share
   **one helper** that **skips** when the refundable balance is ≤ 0 — extending the pattern
   the sweep already has (Rule 6: extend, don't invent) instead of three hand-rolled
   ternaries.

**(b) — Rejected: expand `charge.refunds` via webhook config / API-version bump.** Changing
the pinned API version to get expansion back has blast radius across every webhook arm and
is exactly the kind of "fix one field, shift every payload shape" change we shouldn't couple
to a launch-blocking week. The explicit retrieve is one call, on a low-volume event.

**(c) — Rejected: derive the delta from `amount_refunded` minus prior ledger rows.** Works
until an event is delivered out of order or replayed, then books garbage. Per-refund-object
rows keyed on Stripe's own ids is the shape the ledger's idempotency machinery was built for
(cf. the per-refund-object keying decision in
[`2026-05-22_reconciliation-and-carrier-adjustments`](2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_decided-2026-05-22.md) B4).

### Migration note — existing rows use the old key

Existing prod refund ledger rows were keyed `stripe.<eventId>:refund`. The new code keys
`stripe.refund.<rfnd_id>` — so a Stripe event **replay** after deploy would not collide with
the old row and could **re-book an already-booked refund**. Integration must check for this
explicitly. Expected prod exposure: **~1 live refund row**; the implementer verifies the
actual count and John reconciles manually (a one-off scoped check, logged per Rule 0.5 —
no mass migration, the ledger is append-only).

### Risks

- One extra Stripe API call per `charge.refunded` event — negligible at our volume.
- The shared skip-helper changes behavior on the (rare) ≤ 0-balance path from "refund all
  remaining" to "do nothing" — which is the *point*, but any genuinely-owed refund that was
  being delivered by that accident now needs the admin `/refunds` tool. Correct trade.

## 5. D4 — Refund-sweep timeout vs. the policy window

### The bug

`cron-refund-sweep` has `STALE_DAYS = 21`
([`cron-refund-sweep/index.ts:41`](../supabase/functions/cron-refund-sweep/index.ts)). At
day 21 it marks `refund_status = 'rejected'` — a **terminal** state — and emails the
customer "refund unsuccessful." But PLAYBOOK policy (and carrier reality) says carrier
refunds take **2–4 weeks**. A week-4 EasyPost confirmation then:

1. Sends a contradictory "refund completed" email (customer was just told it failed), and
2. Can never advance the status — `stripe-webhook` only advances `refund_status` from
   `'submitted'`, so the row is stuck at `'rejected'` while the money actually moved.

The 21-day threshold came from
[`2026-05-21_refund-system-implementation`](2026-05-21_refund-system-implementation_reviewed-2026-05-21_decided-2026-05-22.md)
("cron sweep stays Phase 2 with 3-week threshold") — decided before the 2–4-week policy
window was written down. This is a reconciliation between two of our own documents, with
ground truth (Stripe saying money moved) as the tiebreaker.

### Options

**(a) — RECOMMENDED, being implemented:** `STALE_DAYS` 21 → **28** (covers the full policy
window), **and** `stripe-webhook` advances `refund_status → 'refunded'` from `'submitted'`
**or** `'rejected'` when a real Stripe refund lands. Ground truth wins: if Stripe says the
customer got their money, no local status label should say otherwise. The "unsuccessful"
email still only fires at day 28, so the contradictory-email window shrinks to genuinely
late (>4-week) confirmations — and even then the status self-heals.

**(b) — Rejected: only bump to 28, keep 'rejected' terminal.** Shrinks but does not close
the window; a day-29 confirmation still strands the status forever.

**(c) — Rejected: make the sweep re-check EasyPost before rejecting.** More moving parts
for the same outcome; the webhook advance in (a) covers it with one condition change.

### Risks

- Customers with genuinely failed refunds wait 7 more days for the "unsuccessful" email.
  Acceptable: a premature *false* "unsuccessful" is worse than a late true one.
- 'rejected' → 'refunded' is a new transition; the admin rejected-queue view must treat it
  as resolution, not data corruption (small UI/query check in the same PR).

## 6. Also fixed in the same review (mechanical — no design decision needed)

Listed for completeness; these ride in the same PR but are not up for debate here:

- **Fire-and-forget systemic fix** — new `_shared/background.ts` wrapping
  `EdgeRuntime.waitUntil` so post-response work (emails, logging) isn't killed at response
  time; all bare floating-promise sites route through it.
- **cancel-label success-on-DB-fail** — a Stripe refund that succeeds but whose DB write
  fails currently returns success; now returns 500 + admin alert so it can't silently desync.
- **Refund emails quote the wrong number** — templates used `rate_cents` (our EasyPost
  cost) instead of what the customer paid; new `_shared/paid-amount.ts` resolves the paid
  amount once, everywhere.
- **EasyPost webhook 200-on-error** — handler errors returned 200 (EasyPost never retries);
  now 500 so retries happen.
- **Admin partial-refund idempotency window** (deferred fast-follow) — two identical admin
  partial refunds within the key window dedupe silently; needs a nonce or confirm step.
- **Low cleanups** — dead `adjustmentCollected` code, stale comments (incl. the D2 gate
  comment), missing guards.

## 7. Rollout

- **Single PR** against `main`; John merges. D1–D4 + §6 are one review unit because D3's
  halves span the same files as §6's cancel-label fix and splitting them invites a
  half-fixed ledger.
- Edge functions **redeploy on merge** (existing deploy flow). **No schema changes, no
  migrations** — every fix is code-level; the ledger stays append-only and untouched
  structurally.
- **No feature flag needed:** D1/D2 close holes (tightening only), D3/D4 change refund
  bookkeeping forward-only. The one manual step is the D3 migration-note reconcile
  (§4, expected ~1 row), done by John after deploy.
- Order within the PR is irrelevant at runtime; nothing here gates on the closed-beta
  allowlist state.

## 8. Test plan

- **Unit tests per fix** (vitest, existing unit layer per `TESTING.md`):
  - D1: gate fires on PI-amount basis; gate never skipped when a PI exists; persisted
    `display_price_cents` = PI amount; 50¢-PI/$50-rate case returns 409 + void/refund.
  - D2: `comp:true` + active link + no admin JWT → rejected; admin JWT + comp (no link)
    still works; grep-audit of `src/` comp send-sites recorded in the PR description.
  - D3: two partial refunds on one charge → two ledger rows at their own amounts, keys
    `stripe.refund.<id>`; replayed event books nothing new; ≤0-balance initiator skips
    (all three callers via the shared helper).
  - D4: webhook advances `'rejected'` → `'refunded'`; sweep cutoff honors 28 days.
- **`tsc` clean** + **full vitest suite** green before the PR is marked ready.
- Post-merge spot check (per `verifyfix` norms): one test-mode full-label buy end-to-end,
  one comp label as admin, confirm the D3 prod reconcile count.

## 9. Out of scope

- The D1(b) PI-creation-time validation in `payments` — fast-follow, tracked.
- The admin partial-refund idempotency window (§6) — fast-follow.
- Any pricing, markup, or rate-selection logic change.
- Schema/migration work of any kind.

## 10. Open questions

1. **D3 migration note:** is a manual one-row reconcile acceptable, or does the reviewer
   want a guard that detects old-key/new-key double-booking automatically before insert?
2. **D4:** should the 'rejected' → 'refunded' transition also *retract*/follow-up the
   earlier "unsuccessful" email, or is the "completed" email alone sufficient correction?
3. **D2:** if the implementer's grep *does* find a client comp+link send-site, is the call
   to fix the client in the same PR, or pause and surface first?
4. **Rollout:** any appetite for splitting D3/D4 (refund correctness) from D1/D2 (launch
   blockers) if the review stalls on the refund half? Author's view: keep one PR.
