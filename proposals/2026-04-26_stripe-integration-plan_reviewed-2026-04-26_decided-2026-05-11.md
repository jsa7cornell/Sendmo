---
title: Stripe Integration & Financial Systems Wiring
slug: stripe-integration-plan
project: sendmo
status: decided
created: 2026-04-26
reviewed: 2026-04-26
revised: 2026-04-26
decided: 2026-05-11
author: Claude (opus-4-7) — fresh planning session, 2026-04-26 (revision passes: round 1 + round 2, 2026-04-26)
reviewer: Claude (opus-4-7) — fresh-eyes reviewer, 2026-04-26 (round 1); Claude (opus-4-7) — fresh-eyes reviewer, 2026-04-26 (round 2)
outcome: approved with directional decisions on §11 #1–#3, #5, #6, #8; #4 deferred for research; #6/#9/#11 deferred to later phases
---

## Revision note (2026-04-26 — round 2 review folded in, round 3 ready)

This is the second revision of the original proposal. Sections 1–11 (the body below) have been rewritten in place across two passes:

**Pass 1 (round-1 review folded in):**
- All ✅ items from round-1 author response (B2 EasyPost HMAC backfill, B3 server-derived mode chain, B4 webhook-as-sole-writer, P1–P10, all nits).
- Three follow-up rounds with John post-review: prepaid balance (§3.6); escrow forward-compat originally as two-PI; hold-calculation rigor (§3.5, §4.7); carrier rate adjustments (§3.7); ACH for balance topup via Stripe Financial Connections (§3.9).

**Pass 2 (round-2 review + John's directional calls folded in):**
- **B1 (comp gate fix):** §3.10 + §3.1 — `payment_method` moved from `payments` (dropped) onto `shipments` in migration 012; comp gate now durable.
- **B2 (fire-and-forget in `labels`):** §6 Phase A gating now requires the `labels.payments.insert(...).then(...)` block be replaced with `await`-ed `transactions.insert` of type `comp_grant`. Zero `payments.insert` references after migration 012.
- **B3 (auto-debit consent):** Decision #10 promoted from pre-Phase-G to pre-Phase-E. Three options spelled out in §11.
- **N1 (escrow Stripe primitive) — John's directive:** Two-PI model dropped. **Escrow is now a single PaymentIntent + separate `transfers.create` to seller's Connect account on release.** Shipping cost stays on platform's balance (never transferred); item cost transfers to seller on delivery confirmation; on dispute, refund the buyer's PI (shipping naturally retained). §3.8 rewritten end-to-end. §4.6 silent-two-PI UX dropped from MVP scope; the balance-covers-shipping combine logic is preserved (still relevant when balance funds part of a single-PI shipping flow).
- **JIT seller KYC — John's directive:** §3.8 — sellers experience zero KYC at signup or escrow funding. KYC is triggered only when SendMo attempts the transfer at escrow clearance (Stripe Connect Express handles tiered requirements). Buyer never sees KYC.
- **N2 (carrier adjustment caps):** §3.7 — added per-shipment cumulative cap ($10 lifetime) and per-card per-24h cap ($20).
- **N3 (Phase H balance MTL/KYC) — deferred per John's directive:** flagged in §11 as a Phase-H-prereq decision; not body-modifying for MVP scope.
- **N4 (funding source resolution chain):** new §3.11 subsection.
- **N5 (migration 012 all-or-nothing):** §6 Phase A explicit rollback discipline.
- **N6 (HMAC header name):** §4.3 corrected to `X-Hmac-Signature`.
- **N7 (D-then-C credit risk under USPS rate changes):** §7 added bullet about carrier-rate-change sweep-through.
- **All round-2 nits** addressed in body (§3.10 gate, §4.6 reframe, §6 Phase H ACH-fail behavior, §3.1(e) drop `'split'` from `stripe_intents.funding_source`, §3.4 state-machine arrow cleanup, §11 Decision #5 framing).

The round-1 + round-2 **## Review** and **## Author response** sections at the bottom of this file are immutable and preserved verbatim as the record of how this proposal got here. The newest section, **## Author response — Round 2**, follows the round-2 review and explains each acceptance/rejection.

---

## 1. Context

SendMo is collecting zero dollars today. The full-label flow ([RecipientStepPayment.tsx](src/components/recipient/RecipientStepPayment.tsx)) renders a `MockPaymentForm` that sleeps 1.5s, then calls `labels` with no Stripe involvement. The flex-link flow ([RecipientStepFlexPayment.tsx](src/components/recipient/RecipientStepFlexPayment.tsx)) is similarly stubbed. EasyPost is generating real labels (test + live), Resend is sending real email, but every cent of revenue is fictional. There is a `payments` table from migration 001 and an empty `supabase/functions/payments/` Edge Function directory.

This proposal designs the full path from "card on file" to "money in the bank" to "reconciled to the penny against Stripe and EasyPost." It is deliberately broader than just "charge a card." SendMo's value depends on margin tracking that survives refunds, comps, drift, retries, and post-pickup carrier adjustments — and the data model needs to **forward-compatibly** support prepaid balances (with topup discounts), ACH funding, and Phase-3 escrow without schema rewrites.

The proposal does **not** write code. It is the planning artifact that guides the eventual implementation PRs.

### Non-negotiable constraints (PLAYBOOK + CLAUDE.md)

- **Rule 16:** Financial balance changes use an immutable append-only `transactions` ledger. The existing `payments` table allows `UPDATE` and is the wrong shape; it represents Stripe entities, not money movement. It is dropped in this proposal's migration (per round-1 review P4).
- **Rule 14:** Critical decisions (live/test mode, refund eligibility, pricing, charge amount) derive from server-side state. The client never tells the server what to charge or which mode to use.
- **Rule 15:** Schema is expandable for "escrow" — Phase 3.
- **Rule 8:** Always verify webhook signatures — Stripe AND EasyPost. EasyPost HMAC is currently unverified (gap surfaced by round-1 review B2); Phase 0 of the rollout closes that before any Stripe work begins.
- **Rule 6:** Only Stripe Elements; never handle raw card numbers.

### Existing surface area to preserve

- Comp-label flow (`/admin` "Live Comp"): real EasyPost label, no payment. Must continue, must show as **negative margin** in reports (resolves the open WISHLIST item).
- Admin report at `/admin` with margin tracking.
- EasyPost webhook handler at `supabase/functions/webhooks/index.ts` — gains HMAC verification in Phase 0.
- Refund eligibility logic in `cancel-label`.

### Forward-compatibility commitments (designed in, not deferred)

These are not built in MVP, but the data model is shaped so they land later without schema rewrites or backfills:

- **Prepaid balance + topup discount.** MVP ships `transactions.type IN ('balance_topup','balance_redeem')` and the `user_wallet_balance` view. The UI/topup flow ships in Phase 2.
- **ACH topup of balance.** A `funding_source` column on intent rows + new transaction types lets ACH slot in cleanly. Phase H, post-MVP.
- **Escrow** (Phase 3). Two-PI model: shipping = nonrefundable PI #1; item = refundable PI #2. The MVP migration adds `shipments.shipping_payment_intent_id` (replacing the older single-PI shape) and reserves an `escrow_id UUID` slot — the `escrows` table itself ships in Phase 3.
- **Carrier rate adjustments.** A `transactions.type='carrier_adjustment'` plus a `carrier_adjustments` log shape so post-pickup margin leaks (EasyPost reweighs, address corrections) are recovered, not silently absorbed.

---

## 2. Architecture overview

```
                     ┌──────────────────────────────────────────────┐
                     │  RECIPIENT (signed in or auto-created)       │
                     │  • Has 1 stripe_customer_id per mode         │
                     │  • Has ≥0 saved payment_methods              │
                     │  • Has 1 user_wallet_balance row per mode    │
                     └──────────────┬───────────────────────────────┘
                                    │
        ┌─────────────┬─────────────┼─────────────┬─────────────────┐
        │             │             │             │                 │
   FULL-LABEL    FLEX-LINK     BALANCE TOPUP   FUTURE: ESCROW       │
   (MVP)         (Phase E)     (Phase 2 + H)   (Phase 3)            │
        │             │             │             │                 │
        │             │             │             │                 │
        │  PaymentIntent (capture=automatic)                        │
        │  amount = display_price − balance_redeemed                │
        │  funding_source = card | balance | split                  │
        │  setup_future_usage = off_session                         │
        ▼             ▼             ▼             ▼
   stripe_intents row (one per PI created; one per SetupIntent)
        │             │             │             │
        │             │             │      ┌──────┴──── Two PIs:
        │             │             │      │  PI #1 = shipping (immediate capture, nonrefundable)
        │             │             │      │  PI #2 = item (manual capture, escrow, refundable)
        │             │             │      │  transfer_group = sm_<shipment_id>  (Connect seam)
        ▼             ▼             ▼      ▼
   ┌───────────────────────────────────────────────────────┐
   │  Stripe webhooks  (THE SOLE LEDGER WRITER)            │
   │  payment_intent.succeeded  →  +charge, −fee_stripe    │
   │  charge.refunded           →  −refund, +fee_recovered │
   │  payment_intent.canceled   →  hold expired/voided     │
   │  setup_intent.succeeded    →  payment_methods row     │
   └────────────────────────────┬──────────────────────────┘
                                │
                                ▼
                       transactions (append-only, REVOKE+trigger)
                                │
                                ▼
                       /admin/reconciliation  ←───── pg_cron daily
                                                    Stripe ↔ ledger
                                                    drift → email John
```

Three new Edge Functions. One existing Edge Function gets a Phase-0 HMAC fix; no Edge Function deletions.

| Function | Purpose | Phase | Replaces |
|---|---|---|---|
| `webhooks/` (existing, EasyPost) | **Phase 0:** add HMAC verification | 0 | n/a |
| `payments/` (currently empty) | Create SetupIntents + PaymentIntents (one or two), capture, void | A→C | Mock payment form |
| `stripe-webhooks/` (new) | Stripe-signed webhook handler. **Sole ledger writer.** | A | n/a |
| `reconcile-stripe/` (new, cron-driven) | Daily Stripe ↔ ledger drift check | A | n/a |

**Why split `stripe-webhooks` from `webhooks`?** EasyPost and Stripe use different signature schemes, different secrets, different idempotency conventions, different event taxonomies. Mixing them in one handler creates conditional sprawl and increases the chance that a Stripe-only deploy breaks EasyPost handling. Separate functions = separate blast radius. Round-1 reviewer affirmed this in P2.

**Why "webhook as sole ledger writer"?** Round-1 review B4 caught that having both `labels` and the webhook write to the ledger replicates the fire-and-forget anti-pattern that bit notifications on 2026-04-26 (LOG entry), and that the `fee_stripe` row depends on webhook-only `balance_transaction` data — so a `labels`-side write would always under-record the ledger until the webhook caught up. Webhook is now the only writer. `labels` confirms with Stripe API directly (preserving instant-label UX) but writes nothing to the ledger. See §4.3.

---

## 3. Data model

### 3.1 New schema (migration 012)

```sql
-- (a) Stripe Customer pointer (test + live separation)
ALTER TABLE profiles
  ADD COLUMN stripe_customer_id_test TEXT,
  ADD COLUMN stripe_customer_id_live TEXT;

-- (b) Server-derived mode flag on links (round-1 B3)
ALTER TABLE sendmo_links
  ADD COLUMN is_test BOOLEAN NOT NULL DEFAULT TRUE;
-- DEFAULT TRUE is fail-safe: any link predating this column is treated as
-- test until proven live by an admin path. Server-side resolution chain in §4.4.

-- (c) Move payment_method discriminator off `payments` (which is being
--     dropped) and onto `shipments`. This is what gates comp-mode in the
--     labels function (round-2 review B1).
ALTER TABLE shipments
  ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'card'
    CHECK (payment_method IN ('card','balance','split','comp','us_bank_account'));
-- Backfill from the legacy payments table for any existing rows BEFORE the
-- DROP runs. In current production this is comp-only test data.
UPDATE shipments s SET payment_method = COALESCE(
  (SELECT payment_method FROM payments WHERE shipment_id = s.id LIMIT 1),
  'card'
);

-- Drop the legacy payments table (round-1 review P4 + round-2 B1)
DROP TABLE payments;

-- (d) Saved payment methods
CREATE TABLE payment_methods (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  stripe_payment_method_id TEXT NOT NULL,
  mode                     TEXT NOT NULL CHECK (mode IN ('test','live')),
  funding_source           TEXT NOT NULL CHECK (funding_source IN
                             ('card','us_bank_account')) DEFAULT 'card',
  brand                    TEXT,                    -- 'visa','mastercard','ach',...
  last4                    TEXT,
  exp_month                INTEGER,                 -- card only
  exp_year                 INTEGER,                 -- card only
  bank_name                TEXT,                    -- ACH only
  is_default               BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ,             -- soft delete for audit
  UNIQUE (user_id, stripe_payment_method_id)
);
CREATE UNIQUE INDEX uniq_default_pm_per_user_mode
  ON payment_methods (user_id, mode) WHERE is_default = TRUE AND deleted_at IS NULL;

-- (e) Stripe intent state mirror (NOT the ledger)
CREATE TABLE stripe_intents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES profiles(id),
  link_id             UUID REFERENCES sendmo_links(id),
  shipment_id         UUID REFERENCES shipments(id),
  stripe_intent_id    TEXT NOT NULL UNIQUE,        -- pi_... or seti_...
  intent_kind         TEXT NOT NULL CHECK (intent_kind IN ('payment','setup')),
  intent_role         TEXT CHECK (intent_role IN
                        ('shipment','topup','flex_hold')),
  -- intent_role: discriminates topup PIs from shipping PIs and from flex-link
  -- holds. Phase 3 escrow shipments are still 'shipment' — the escrow shape
  -- is single-PI + separate transfer (§3.8), not a separate PI per role.
  capture_method      TEXT CHECK (capture_method IN ('automatic','manual')),
  funding_source      TEXT CHECK (funding_source IN ('card','balance','us_bank_account')),
  -- 'split' is intentionally NOT on stripe_intents: a single Stripe intent
  -- has exactly one funding source. 'split' lives only on `transactions`,
  -- where balance-partial-covered + card-covered-rest yields two ledger
  -- rows tagged accordingly (round-2 nit).
  amount_cents        INTEGER,                     -- requested/auth amount
  captured_cents      INTEGER,                     -- actual captured (manual)
  status              TEXT NOT NULL,               -- mirrors Stripe status
  mode                TEXT NOT NULL CHECK (mode IN ('test','live')),
  transfer_group      TEXT,                        -- Connect seam: sm_<shipment_id>
  idempotency_key     TEXT NOT NULL UNIQUE,
  last_event_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- (f) Holds (flex-link authorizations)
CREATE TABLE holds (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id             UUID NOT NULL REFERENCES sendmo_links(id),
  stripe_intent_id    TEXT NOT NULL UNIQUE,
  amount_cents        INTEGER NOT NULL,            -- the authorized cap
  capture_target_cents INTEGER,                    -- the rate we expected to capture
  status              TEXT NOT NULL CHECK (status IN
                        ('authorized','captured','partially_captured','voided','expired','failed')),
  authorized_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  captured_at         TIMESTAMPTZ,
  voided_at           TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ NOT NULL,        -- Stripe auto-voids cards at 7d
  mode                TEXT NOT NULL CHECK (mode IN ('test','live'))
);

-- (g) Refunds
CREATE TABLE refunds (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id              UUID NOT NULL REFERENCES shipments(id),
  stripe_refund_id         TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id TEXT NOT NULL,
  amount_cents             INTEGER NOT NULL,       -- positive
  reason                   TEXT,
  status                   TEXT NOT NULL,
  easypost_void_id         TEXT,
  mode                     TEXT NOT NULL CHECK (mode IN ('test','live')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- (h) Carrier rate adjustments log (post-pickup reweighs etc.)
CREATE TABLE carrier_adjustments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id           UUID NOT NULL REFERENCES shipments(id),
  source                TEXT NOT NULL DEFAULT 'easypost',
  source_event_id       TEXT,                       -- EasyPost adjustment ID (when present)
  delta_cents           INTEGER NOT NULL,           -- positive = carrier charged us more
  reason                TEXT,                       -- 'reweigh','address_correction',...
  recovery_status       TEXT NOT NULL CHECK (recovery_status IN
                          ('pending','recovered','absorbed','disputed')),
  recovery_tx_id        UUID REFERENCES transactions(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at           TIMESTAMPTZ
);

-- (i) shipments.stripe_payment_intent_id (currently nullable on the legacy
--     `payments` table that's being dropped) is replaced with a FK column on
--     `shipments` directly: a single PI per shipment. Phase-3 escrow uses the
--     SAME column — escrow is single-PI + separate transfer (§3.8 + round-2
--     N1 + John's directive).
ALTER TABLE shipments
  ADD COLUMN stripe_payment_intent_id TEXT,         -- buyer's PI; null for comp
  ADD COLUMN escrow_id UUID;                        -- Phase-3 forward-compat;
                                                    -- FK constraint added when
                                                    -- `escrows` ships

-- (j) THE LEDGER — append-only, never UPDATE, never DELETE
CREATE TABLE transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES profiles(id),
  shipment_id     UUID REFERENCES shipments(id),
  link_id         UUID REFERENCES sendmo_links(id),
  stripe_intent_id TEXT,
  stripe_charge_id TEXT,
  type            TEXT NOT NULL CHECK (type IN (
                    'charge',                -- customer paid (card or balance redeem)
                    'fee_stripe',            -- Stripe processing fee deducted
                    'refund',                -- money back to customer
                    'refund_fee_recovered',  -- Stripe returns app fee on refund
                    'comp_grant',            -- comp label, no payment (negative margin)
                    'balance_topup',         -- prepay wallet (Phase 2 / H)
                    'balance_topup_bonus',   -- the discount/incentive on topup (§3.6)
                    'balance_redeem',        -- spend from wallet
                    'carrier_adjustment',    -- post-pickup reweigh etc. (§3.7)
                    'chargeback',            -- dispute lost
                    'adjustment'             -- manual admin correction (rare)
                  )),
  funding_source  TEXT CHECK (funding_source IN ('card','balance','split','us_bank_account','comp')),
  amount_cents    INTEGER NOT NULL,         -- signed: + = SendMo gains, − = SendMo loses
  description     TEXT,
  mode            TEXT NOT NULL CHECK (mode IN ('test','live')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only enforcement (Rule 16 — belt + suspenders)
REVOKE UPDATE, DELETE ON transactions FROM authenticated, anon, service_role;
GRANT SELECT, INSERT ON transactions TO service_role;
CREATE OR REPLACE FUNCTION block_transaction_mutations()
  RETURNS TRIGGER AS $$ BEGIN
    RAISE EXCEPTION 'transactions is append-only';
  END $$ LANGUAGE plpgsql;
CREATE TRIGGER no_update_transactions BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION block_transaction_mutations();
CREATE TRIGGER no_delete_transactions BEFORE DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION block_transaction_mutations();

-- Indexes
CREATE INDEX idx_tx_user_created    ON transactions (user_id, created_at DESC);
CREATE INDEX idx_tx_shipment        ON transactions (shipment_id);
CREATE INDEX idx_tx_intent          ON transactions (stripe_intent_id);
CREATE INDEX idx_tx_mode_created    ON transactions (mode, created_at DESC);
CREATE INDEX idx_intents_user       ON stripe_intents (user_id);
CREATE INDEX idx_intents_link       ON stripe_intents (link_id);
CREATE INDEX idx_intents_xfergrp    ON stripe_intents (transfer_group);
CREATE INDEX idx_pm_user_mode       ON payment_methods (user_id, mode) WHERE deleted_at IS NULL;
CREATE INDEX idx_holds_status       ON holds (status, expires_at);
CREATE INDEX idx_refunds_shipment   ON refunds (shipment_id);
CREATE INDEX idx_carrier_adj_status ON carrier_adjustments (recovery_status);
```

### 3.2 RLS policies

- `payment_methods`: user SELECTs their own (where `deleted_at IS NULL`). INSERT/UPDATE service_role only.
- `stripe_intents`, `holds`, `refunds`, `carrier_adjustments`: SELECT by user where `user_id = auth.uid()` (or join through link/shipment). INSERT/UPDATE service_role only.
- `transactions`: SELECT by user for their own rows. INSERT service_role only. UPDATE/DELETE blocked at the role level + trigger level.
- Admin role (when role-based check ships) gets unrestricted SELECT for `/admin/reconciliation`.

### 3.3 Customer balance — derived view, load-bearing

```sql
CREATE VIEW user_wallet_balance AS
SELECT
  user_id,
  mode,
  SUM(CASE WHEN type IN ('balance_topup','balance_topup_bonus') THEN amount_cents
           WHEN type = 'balance_redeem' THEN -amount_cents
           ELSE 0 END) AS balance_cents,
  MAX(created_at) AS last_movement_at
FROM transactions
GROUP BY user_id, mode;
```

A view (not materialized) keeps Rule 16 honest — there is no balance to "update" — and stays cheap until the ledger exceeds ~1M rows. The view is load-bearing once Phase 2 (balance UI) ships, but it is created in Phase A so the math is in place from day one. (Round-1 P4 also relevant: dropping `payments` immediately means `user_wallet_balance` is the only place "wallet state" exists.)

### 3.4 Payment state machine (full-label, flex-link, refund)

```
                 ┌──────────────────────────────────────────────┐
                 │ FULL-LABEL  (capture_method = automatic)     │
                 └──────────────────────────────────────────────┘

[NONE]
  │  client: stripe.confirmCardPayment(client_secret)
  │  (server already created the PI with amount derived from sendmo_links state)
  ▼
[processing] ── 3DS if needed ──▶ [requires_action] ──▶ [processing]
                                       │
   ┌───────────────────────────────────┴──────────────────────┐
   ▼                                                            ▼
[succeeded] (synchronous return to client)                  [failed]
   │                                                            │
   │  client → POST /labels { intent_id, link_id }              │ → no label
   │  labels fn:                                                │ → user retries
   │    a. stripe.paymentIntents.retrieve(intent_id)            │   (new idemp key:
   │       — verify status=succeeded directly from Stripe.      │    retry_n+1)
   │    b. Verify intent.metadata.link_id matches request.      │
   │    c. EasyPost label.buy()                                 │
   │    d. INSERT shipments (with stripe_intent_id linkage)     │
   │    e. Return label PDF URL.   ──── NO LEDGER WRITES.       │
   ▼
[label issued]   ← (synchronous user-visible state; ledger NOT yet written)
   │
   │   (webhook lands within seconds; reconciliation tolerates the in-flight
   │    gap with the 24h grace window in §5.4)
   ▼
WEBHOOK: payment_intent.succeeded (typically arrives within seconds)
  → expand: ['latest_charge.balance_transaction'] for actual fee
  → INSERT transactions: (+charge, −fee_stripe)
  → (mode, idempotency_key, all FKs populated)


                 ┌──────────────────────────────────────────────┐
                 │ FLEX-LINK  (capture_method = manual)         │
                 └──────────────────────────────────────────────┘
[NONE] → [created] → [authorized] (hold row, money on customer card, no movement yet)
                          │
   ┌──────────────────────┼─────────────────────────────────────────┐
   │                      │                                         │
   ▼                      ▼                                         ▼
sender uses link    sender never uses, hold expires       rate ≤ hold (the normal case)
   │                (Stripe auto-voids at 7d)                       │
[partially_captured]  ──▶ webhook payment_intent.canceled  ──▶ [voided]
actual cost captured                                              hold.status=expired
excess released automatically                                     no transactions row
   │
   ▼
[captured] → webhook payment_intent.succeeded →
  +charge (actual captured amount), −fee_stripe

  (rate > hold case: see §4.7 D-then-C policy — sender never blocks)


                 ┌──────────────────────────────────────────────┐
                 │ REFUND  (label voided)                       │
                 └──────────────────────────────────────────────┘
[captured] → admin clicks Void → cancel-label fn
  → EasyPost void OK
  → stripe.refunds.create()
  ▼
WEBHOOK: charge.refunded
  → INSERT refunds row
  → INSERT transactions: −refund (signed negative; SendMo loses money)
  → INSERT transactions: +refund_fee_recovered (typically 0; non-zero if Stripe returns app fee)
  → shipments.refund_status = 'refunded'
```

**Critical:** the only ledger writer in any of these flows is the webhook. The `labels` and `cancel-label` Edge Functions perform the EasyPost calls and Stripe API calls but do not INSERT into `transactions`. This eliminates the split-brain risk surfaced by round-1 review B4.

### 3.5 Hold formula — flex-link authorization amount

The previous draft used `hold = adjustedHigh × 1.10`, which has two failure modes: (1) it is unbounded for high adjustedHigh values (an extreme address could push the hold to several hundred dollars and decline cards), and (2) it leaves SendMo exposed when the actual carrier rate at label-buy slightly exceeds adjustedHigh × 1.10.

Replace with:

```
holdCents = MIN(
  priceCapCents,                         -- recipient-set cap; never exceeded
  expectedRateAtP95Cents                 -- 95th percentile rate for this lane/weight
   + insuranceCents
   + safetyBufferCents                   -- $1.50 rounded
)
```

`expectedRateAtP95Cents` is computed at link-create time from EasyPost rate quotes for the configured (lane, weight band, service tier) tuple, taking the 95th percentile across the eligible carriers. This value is stable enough to cache for the link's lifetime — no per-quote recompute. If the link configuration is unusual enough that we can't get a P95 (insufficient quotes), the formula falls back to `adjustedHigh × 1.10` clamped at `priceCap`.

**The `priceCap` clamp is the user-facing promise:** the recipient's link says "won't authorize more than $X." That number wins, even if our P95 model wants more.

### 3.6 Prepaid balance + topup discount/incentive

Schema-ready in Phase A; UI ships in Phase 2.

The recipient (or anyone with a SendMo account) can **top up a balance** in advance and use that balance to pay for shipping in lieu of a card. Topup includes a configurable bonus:

```
topup_amount_cents   = what user pays Stripe (charge or ACH debit)
topup_bonus_cents    = SendMo grants (positive ledger row, type='balance_topup_bonus')
balance_cents_added  = topup_amount_cents + topup_bonus_cents
```

The bonus is a discount expressed as additional balance:

| Variant | Behavior | Example |
|---|---|---|
| **Flat 5% bonus** (recommended for MVP launch) | Topup $100 → balance shows $105 | Matches SPEC §3 (5% Balance discount) |
| **Tiered bonus** | $50 → 3% / $100 → 5% / $250 → 7% | Discriminator by topup tier |
| **First-topup-only bonus** | One-time 10% on first topup | Acquisition incentive |

Implementation hits one writer: when `payment_intent.succeeded` arrives for a topup PI, the webhook writes:
- `+charge` (the actual money in)
- `−fee_stripe` (Stripe's cut)
- `+balance_topup` (the customer's "purchasing power" credit, gross of bonus — see below)
- `+balance_topup_bonus` (the bonus, separate row for auditability and analytics)

Why two rows for "balance increase" instead of one summed row? Because the discount is information SendMo loses if it sums them — analytics on "what's the redemption rate of the discount" require the separation. Both rows feed into `user_wallet_balance` identically.

**Why a 5% bonus is mathematically possible:** With ACH funding (§3.9), Stripe's processing cost on a $100 topup is ~$0.80 (vs ~$3.20 for cards). After paying out a $5 bonus and ~$0.80 in fees, SendMo nets $94.20 of balance liability against $100 of cash. The customer redeems balance against shipments where SendMo's margin is ~13–15% — so the 5% discount is paid out of margin without going negative on the topup itself. This math collapses if the user funds via card; see §3.9 for why ACH is the pre-condition for the discount to land.

### 3.7 Carrier rate adjustments (post-pickup margin recovery)

EasyPost surfaces carrier-side rate adjustments after pickup: USPS reweighs, UPS dimensional adjustments, address correction surcharges, etc. Today, SendMo silently absorbs these — they hit the EasyPost balance after we've already charged the customer the original quoted rate. Reconciliation surfaces this as "shipping cost rose after the fact" but there is no recovery path.

Phase G (post-MVP) wires up the recovery loop:

```
1. EasyPost webhook 'tracker.updated' or 'shipment.updated' includes
   adjustment object → stripe-webhooks rejects (wrong handler);
   webhooks/ (EasyPost) handles, INSERTs into carrier_adjustments
   (recovery_status='pending').
2. Tiered policy by delta_cents AND by cumulative caps:
     | < $2.00       | absorbed silently (recovery_status='absorbed')
     | $2.00–$10.00  | auto-debit the original payment method off-session
                       via PaymentIntent (capture_method='automatic',
                       customer's saved card from payment_methods) —
                       SUBJECT TO CAPS BELOW
     | > $10.00      | flag for John; admin /reconciliation surfaces it;
                       human decides whether to charge or absorb
3. Auto-debit eligibility caps (round-2 N2). Auto-debit is rejected and
   the adjustment is queued for manual review whenever ANY cap is breached:
     - Per-shipment lifetime cap: SUM(carrier_adjustment auto-debits for
       this shipment_id) + this delta ≤ $10.00. EasyPost can emit several
       adjustments per shipment (reweigh, then address correction, then
       residential surcharge); without this cap, a stuck loop can chain
       3–5 auto-charges on one package, which reads as fraud.
     - Per-card per-24h cap: SUM(carrier_adjustment auto-debits to this
       payment_method_id in the last 24h) + this delta ≤ $20.00.
     - Per-user per-7d cap: SUM(... last 7d, all cards) ≤ $50.00.
   Any cap breach → recovery_status='pending'; admin reconciliation queue.
4. Successful auto-debit → +charge tx (carrier_adjustment-type),
   −fee_stripe, carrier_adjustments.recovery_status='recovered',
   recovery_tx_id populated.
5. Failed auto-debit (card declined, deleted, cap breached, etc.) →
   recovery_status stays 'pending'; surfaces in admin reconciliation;
   manual outreach.
```

The thresholds ($2 / $10 / $20 / $50) come from a back-of-envelope: below $2, the support cost of explaining a charge to a customer exceeds the recovery; the cumulative caps prevent chargeback-magnet patterns. They're parameters, not architecture — final values pending real adjustment-rate data from Phase D and confirmation from John (Decision #8).

### 3.8 Escrow forward-compatibility (Phase 3)

**Decided model (per John, post-round-2):** Phase-3 escrow is a **single PaymentIntent + separate `transfers.create` to seller's Stripe Connect account on release.** Round-2 reviewer (N1) pushed back on the original two-PI design; John clarified that shipping money should always come to SendMo (platform) and item money should go to the seller — which is naturally expressed as one buyer-side charge to the platform balance + one platform-controlled transfer to the seller after delivery.

**How money moves:**

```
1. Buyer click "Pay $X" (X = shipping_cost + item_amount).
   stripe.paymentIntents.create({
     amount: X,                             -- buyer pays the full thing
     customer: buyer_stripe_customer_id,
     capture_method: 'automatic',
     setup_future_usage: 'off_session',
     transfer_group: `sm_${shipment_id}`,    -- the durable link
     statement_descriptor_suffix: 'SHIPPING',  -- buyer sees one line
     metadata: { link_id, shipment_id, escrow_id, sendmo_user_id, mode,
                 intent_role: 'shipment' }
   })
   → On succeeded, full $X lands on SendMo's Stripe balance.
   → Webhook writes transactions: +charge $X, −fee_stripe.

2. Label bought; package ships; delivery confirmed.

3. SendMo calls stripe.transfers.create({
     amount: item_amount,                   -- item portion only
     destination: seller_stripe_account_id,
     transfer_group: `sm_${shipment_id}`,
     description: `Escrow release for ${shipment_id}`
   })
   → item_amount moves from SendMo's balance to seller's connected account.
   → SendMo retains shipping_cost on its balance — naturally, never moved.
   → escrows.status = 'released_to_seller'; stripe_transfer_id populated.

4. On dispute (rare):
   stripe.refunds.create({ payment_intent: <buyer_pi> })
   → Refund debits the entire $X from SendMo's balance back to buyer's card.
   → BUT: if the transfer in step 3 already happened, SendMo is now short
     the item_amount. The mitigation is to reverse the transfer:
     stripe.transfers.createReversal({ transfer: stripe_transfer_id })
     → pulls item_amount back from seller's connected account.
   → Net effect: buyer made whole ($X back), seller eats their item portion,
     SendMo eats nothing because shipping was never transferred and the
     transfer reversal recovered the item portion.
```

**Why this is cleaner than two PIs:**
- One charge on buyer's statement, one 3DS prompt at most, one settlement event.
- Shipping is naturally nonrefundable to SendMo (the money never left SendMo's balance — no special "don't refund the application_fee" config needed).
- Item-side refund control is at transfer time: SendMo decides how much to transfer based on real-world delivery state, not pre-committed at charge time.
- Forward-compatible with multi-recipient marketplace splits (multiple `transfers.create` calls against the same `transfer_group`).

**Just-in-time seller KYC (John's directive):**

Sellers experience zero KYC friction at signup or at the moment a buyer pays them. KYC is triggered exclusively at escrow clearance, when SendMo first attempts to transfer money to them:

```
1. Seller signs up for SendMo: standard auth only. No tax info, no SSN.
   sellers.stripe_account_id is NULL. (No Stripe Connect account yet.)
2. Buyer purchases through seller's link. Buyer's PI succeeds; money on
   SendMo's balance. escrows.status = 'held'. Seller sees "$X coming
   when delivered" in their dashboard. Still no KYC.
3. Delivery confirmed. SendMo's release flow:
   a. If sellers.stripe_account_id IS NULL:
      - stripe.accounts.create({ type: 'express', email, country: 'US',
          capabilities: { transfers: { requested: true }}})
      - Email seller: "Your $X is ready. Complete a 2-minute payout
          setup to receive it: <stripe_onboarding_link>"
      - escrows.kyc_status = 'requested'; release blocked.
   b. Seller completes Stripe Connect Express onboarding (Stripe collects
      whatever they need: name, DOB, last-4 SSN, bank account; tiered by
      payout volume per Stripe's defaults).
   c. Webhook account.updated arrives → kyc_status='complete' if
      capabilities.transfers='active'.
   d. Cron retries pending releases for that seller_id; transfer.create
      succeeds; funds land in seller's bank within Stripe's standard
      payout window.
4. If seller never completes (>30d): SendMo escalates — email + dashboard
   warning. After 90d unclaimed: escrows.status = 'frozen'; the funds
   stay on SendMo's balance until seller acts or buyer disputes (after
   dispute window, the funds become SendMo's per the seller terms).
```

The buyer **never** sees seller KYC. The seller experiences it once, at the moment money is waiting for them — which is the moment they're maximally motivated to complete it. This is the lightweight pattern Stripe Connect Express was built for; SendMo just defers the trigger to clearance instead of signup.

**The `escrows` table** (ships in Phase 3, NOT in MVP):

```sql
-- Phase 3 (NOT in this proposal's MVP scope):
CREATE TABLE escrows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id UUID NOT NULL REFERENCES shipments(id) UNIQUE,
  seller_user_id UUID NOT NULL REFERENCES profiles(id),
  seller_stripe_account_id TEXT,                 -- populated on first KYC
  shipping_cost_cents INTEGER NOT NULL,          -- SendMo retains
  item_amount_cents INTEGER NOT NULL,            -- transferred to seller on release
  buyer_paid_cents INTEGER NOT NULL,             -- = shipping_cost + item_amount
  buyer_stripe_intent_id TEXT NOT NULL,          -- the single PI
  stripe_transfer_id TEXT,                       -- populated on release
  stripe_transfer_reversal_id TEXT,              -- populated on dispute
  transfer_group TEXT NOT NULL,                  -- sm_<shipment_id>
  status TEXT NOT NULL CHECK (status IN
    ('pending','held','released_to_seller','refunded_to_buyer','disputed','frozen')),
  kyc_status TEXT NOT NULL DEFAULT 'not_required' CHECK (kyc_status IN
    ('not_required','requested','complete','rejected')),
  held_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  frozen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**MVP migration ships only the slot, not the table:**
- `shipments.escrow_id UUID` (FK target; constraint added in Phase 3).
- `shipments.stripe_payment_intent_id TEXT` (the buyer's single PI; works for both escrow and non-escrow shipments).
- `stripe_intents.transfer_group` (Connect seam).
- `stripe_intents.funding_source` (records ACH/card/balance from MVP onward).

A Phase-3 implementation proposal will detail the Stripe Connect Express integration, the dispute-with-already-transferred case, the unclaimed-funds policy, and the seller-side dashboard.

### 3.9 ACH balance topup (Phase H)

**Phase H, not Phase 3.** ACH ships alongside the prepaid balance feature because the economics of ACH are what make a 5% bonus mathematically sustainable (see §3.6). Card-funded topups at 5% would be margin-negative.

**Stripe Financial Connections, not Plaid.** The original draft (§8) listed "ACH via Plaid" as Phase 3. Stripe acquired this category and Financial Connections is now the path. Plaid is dropped from the proposal.

Settlement timing — **Approach B (settle-then-credit):**

```
T0:    User initiates $200 ACH topup. Stripe shows 'processing'.
       SendMo records stripe_intents row, status='processing', funding_source='us_bank_account'.
       User sees: "Topup pending — typically clears in 3–5 business days."
       NO balance_topup transaction yet. Balance unchanged.

T+1d:  Webhook payment_intent.processing → no ledger movement.

T+4d:  Webhook payment_intent.succeeded (ACH cleared) →
       +charge ($200 from user)
       −fee_stripe ($1.60 ACH fee)
       +balance_topup ($200)
       +balance_topup_bonus ($10 — the 5%)
       Balance now reflects $210.

       (or)

T+4d:  Webhook payment_intent.payment_failed (ACH rejected) →
       NO ledger movement. NO balance change. User notified.
```

**Why settle-then-credit and not credit-immediately:** crediting balance on `processing` opens a clawback fraud surface. A bad actor initiates a topup, immediately spends the balance on labels (which are real and shippable), then pulls back the ACH 3 days later via "unauthorized" claim. SendMo eats the loss + the labels. Settle-then-credit makes this attack impossible. The cost is a 3–5 day funding delay, which is acceptable for a prepaid feature where the sales pitch is "deposit once, save 5% forever." Card-based topups remain instant.

NACHA authorization disclosure is added to the topup confirmation screen ("By proceeding, you authorize SendMo to debit $X from your bank account.") — required for ACH compliance.

### 3.10 Comp-mode interaction with `stripe_intents`

(Round-1 review P9; round-2 review B1+B2.) Comp shipments skip the Stripe path entirely. When admin invokes "Live Comp" and `is_test=false`, the labels function buys a real EasyPost label without creating a PaymentIntent. The `transactions` row is `type='comp_grant'`, `funding_source='comp'`, `amount_cents = −EasyPost cost` (negative — SendMo absorbs the cost). No `stripe_intents` row, no `payment_methods` row.

The gate is `shipments.payment_method='comp'`, which migration 012 (§3.1(c)) moves off the legacy `payments` table and onto `shipments` so it survives the `DROP TABLE payments`. This is the round-2 B1 fix.

**Phase A code change (round-2 B2).** The labels function (`supabase/functions/labels/index.ts:297-328`) currently writes a `payments` row for live-comp shipments via fire-and-forget `.then()` — same Deno pattern that hid bug #2 in the 4/26 incident. As part of Phase A, that block is replaced with `await supabase.from('transactions').insert({ type: 'comp_grant', funding_source: 'comp', amount_cents: -easypost_cost_cents, ... })`. After migration 012 ships, **zero `payments.insert` references remain in the codebase** — that's a Phase-A gating criterion (§6).

This resolves the WISHLIST item "Comp labels should show negative margin" — admin reconciliation reads `comp_grant` rows directly.

### 3.11 Funding source resolution chain

(Round-2 N4.) `funding_source` appears on three tables (`payment_methods`, `stripe_intents`, `transactions`) with intentionally overlapping but non-identical enums. Tracing "where did this $X come from" for any `transactions` row follows this join pattern:

```sql
-- Given a transactions row, resolve its funding source:
SELECT
  t.id                   AS tx_id,
  t.type, t.amount_cents, t.funding_source,
  si.stripe_intent_id, si.intent_kind, si.intent_role,
  pm.brand, pm.last4, pm.bank_name
FROM transactions t
LEFT JOIN stripe_intents si ON si.stripe_intent_id = t.stripe_intent_id
LEFT JOIN payment_methods pm
  ON pm.user_id = t.user_id
 AND pm.stripe_payment_method_id = (
   -- the PM attached to this PI; populated on charge.succeeded
   SELECT payment_method FROM stripe_intents
   WHERE stripe_intent_id = t.stripe_intent_id
 )
WHERE t.id = $1;
```

How to read the result, by `transactions.funding_source`:

| `funding_source` | Where to look | Example |
|---|---|---|
| `'card'` | `payment_methods.brand`, `last4`, `exp_month`/`exp_year` | "visa, 4242, 12/29" |
| `'us_bank_account'` | `payment_methods.bank_name`, `last4` | "Chase, 6789" |
| `'balance'` | No PM/intent join — money came from `user_wallet_balance`. The `transactions.type` chain shows the original topup that funded it. | `balance_redeem` row, look back at user's prior `balance_topup` rows |
| `'split'` | This row is half of a pair: typically one `'balance'` row + one `'card'` row sharing `shipment_id`. | `SELECT * FROM transactions WHERE shipment_id = $1 AND type = 'charge'` returns 2 rows |
| `'comp'` | No Stripe path. `stripe_intents` join is NULL. `shipments.payment_method='comp'` is the discriminator. | `comp_grant` row, no PM, no intent |

A future Phase-3 author tracing escrow flows reads `funding_source` on the buyer's `+charge` row to know what the buyer paid with, then follows `shipments.escrow_id → escrows.stripe_transfer_id` to see what was released to the seller.

---

## 4. Stripe integration architecture

### 4.1 Saving cards — SetupIntent vs PaymentIntent-with-future-usage

Two patterns, both used:

1. **PaymentIntent with `setup_future_usage: 'off_session'`** — single API call that charges and saves the card. Used for the **first card-save** in any user's first shipping flow (full-label or flex-link). This is the common case — saving a card without a pending payment isn't the natural shape of the user journey.
2. **SetupIntent first, no PaymentIntent yet** — used for the dashboard "Add backup card" UI (Phase B+). Returning users adding a card before they have a pending shipment.

Both flows write the same `payment_methods` row via `setup_intent.succeeded` (case 2) or `payment_intent.succeeded` with attached `payment_method` (case 1).

### 4.2 Customer object lifecycle + mode resolution chain

Create `stripe_customer_id_<mode>` lazily on first PaymentIntent or SetupIntent for that user in that mode. Don't pre-create on signup.

The `payments` Edge Function flow (full-label, single PI):

```
1. POST /payments/create-intent { link_id }     ← client sends only link_id
2. Server resolves user_id from JWT.
3. Server reads sendmo_links by link_id. is_test column on the link
   determines mode (no client-supplied mode param).
4. If profiles.stripe_customer_id_<mode> is NULL:
     stripe.customers.create({ email, metadata: { sendmo_user_id }})
     UPDATE profiles SET stripe_customer_id_<mode> = ...
5. Server computes amount from sendmo_links state — pricing module,
   not request body (Rule 14).
6. Server determines funding_source: if user has balance ≥ amount,
   it's 'balance' (no PI created — see §4.6). Else 'card' (this flow).
   'split' covered in §4.6.
7. Generate Stripe-API idempotency key:
     ${link_id}:${flow_step}:${mode}:retry-${retry_n}
   (retry_n increments per user-visible retry — declined card → new try)
8. stripe.paymentIntents.create({
     amount, customer, capture_method: 'automatic',
     setup_future_usage: 'off_session',
     statement_descriptor_suffix: 'SHIPPING',
     transfer_group: `sm_${shipment_id_or_link_id}`,    -- Connect seam
     metadata: { link_id, sendmo_user_id, mode, intent_role: 'shipping' }
   }, { idempotencyKey })
9. INSERT stripe_intents (intent_role='shipping', funding_source='card', ...)
10. Return { client_secret, intent_id } to frontend.
11. Frontend: stripe.confirmCardPayment(client_secret)
12. On succeeded → frontend calls /labels (see §3.4 state machine).
13. Webhook payment_intent.succeeded → ledger writes.
```

**Mode resolution chain** (round-1 B3 fix, full):

```
Link create time:
  Server reads JWT → checks profiles.role = 'admin'.
  If admin AND admin_toolbar_mode = 'live_charge' (validated server-side
  against an enum, not trusted from request body): is_test = false.
  Otherwise: is_test = true.
  → Persisted on sendmo_links.is_test (NOT NULL DEFAULT TRUE).

Payment intent create:
  Server reads sendmo_links.is_test by link_id (server-side lookup).
  Selects STRIPE_SECRET_KEY_TEST or STRIPE_SECRET_KEY_LIVE accordingly.
  Client never sends a mode param.

Webhook handler:
  Mode is implicit from which secret verifies the signature
  (STRIPE_WEBHOOK_SECRET_TEST or _LIVE).
  Recorded on stripe_intents, transactions, holds, refunds.

Reconciliation:
  Every query filters by mode. Default tab is 'live'. Test rows can
  never pollute live aggregates.
```

### 4.3 Webhook handler design (Stripe + Phase-0 EasyPost HMAC)

**Phase 0 (precedes any Stripe work):** add HMAC verification to `supabase/functions/webhooks/index.ts`. EasyPost signs `tracker.updated` and `shipment.updated` events with HMAC-SHA256 using `EASYPOST_WEBHOOK_HMAC_SECRET` (existing 1Password secret). The handler compares against `req.headers.get('X-Hmac-Signature')` (hex-encoded HMAC-SHA256 of the raw body — verified against EasyPost docs and corrected from the round-1 proposal's wrong header name per round-2 N6). Constant-time comparison. Failure → 400 with no further processing. ~30 LOC change. Round-1 B2.

**Stripe webhooks** (new `stripe-webhooks/` Edge Function). Endpoint: `POST /functions/v1/stripe-webhooks`. The Stripe dashboard registers this URL with both test and live modes producing different webhook secrets (`STRIPE_WEBHOOK_SECRET_TEST`, `STRIPE_WEBHOOK_SECRET_LIVE`).

```
1. Read raw body (NOT parsed — signature verifies the bytes).
2. Try stripe.webhooks.constructEvent(body, sig, SECRET_LIVE).
3. On signature error: try SECRET_TEST.
4. On both fail: 400 with no further processing.
5. Dedup: INSERT INTO webhook_events (id=event.id, source='stripe', ...)
   ON CONFLICT DO NOTHING. If 0 rows affected → retry → 200 immediately.
6. Handle by event.type. Critically, this is the SOLE LEDGER WRITER:
   - payment_intent.succeeded
       → expand: ['latest_charge.balance_transaction']
       → INSERT transactions: +charge, −fee_stripe
       → if intent_role='topup' → also +balance_topup, +balance_topup_bonus
   - payment_intent.payment_failed → mark hold failed if applicable
   - payment_intent.amount_capturable_updated → mark hold authorized
   - payment_intent.canceled → mark hold voided/expired (primary
     truth-source per round-1 P7)
   - charge.succeeded → noop (data already pulled from PI succeeded)
   - charge.refunded → INSERT refunds row + transactions: −refund,
     +refund_fee_recovered
   - charge.dispute.created → flag shipment, email John
   - setup_intent.succeeded → INSERT payment_methods row
   - financial_connections.account.refreshed → noop (informational)
7. Mark webhook_events.processed = true on success.
8. 200 OK.
```

**Stripe fee extraction:** `expand: ['latest_charge.balance_transaction']` to get the actual fee. Don't compute from a hardcoded 2.9% + $0.30 — Stripe occasionally adjusts (international cards, ACH at 0.8% capped at $5, currency conversion) and we want truth in the ledger.

### 4.4 Test mode vs live mode

- Two key sets in Supabase secrets: `STRIPE_SECRET_KEY_TEST`, `STRIPE_SECRET_KEY_LIVE`, `STRIPE_WEBHOOK_SECRET_TEST`, `STRIPE_WEBHOOK_SECRET_LIVE`.
- Mode resolves via the server-side chain in §4.2. The client never sets mode. `mode_implied_by_admin_state` from the original draft is removed entirely.
- Mode is recorded on every `transactions`, `stripe_intents`, `holds`, `refunds`, `payment_methods` row — reconciliation always filters by mode.

### 4.5 Idempotency (split into two layers)

**Stripe-API layer** (allows legitimate user retries with new card):
```
${link_id}:${flow_step}:${mode}:retry-${retry_n}
```
`retry_n` increments on each user-initiated retry. Stripe sees a fresh intent on retry, not a replay of the failed one.

**Ledger-row layer** (strict, derived from Stripe IDs):
```
pi_xxx:succeeded:charge
pi_xxx:succeeded:fee
ch_xxx:refunded:refund
ch_xxx:refunded:fee_recovered
seti_xxx:succeeded:payment_method
ca_xxx:carrier_adjustment        ← (carrier_adjustments.id-derived)
```

Stripe layer = "did we mean to call Stripe again?" Ledger layer = "did we already record this Stripe event?" The `webhook_events` table (3rd layer, deduplicating Stripe-side retries) sits between them. (Round-1 P8.)

### 4.6 Single-PI checkout + balance-combine logic

(Round-2 N1 + John's directive.) Phase-3 escrow uses a **single PaymentIntent** (the buyer pays $X = shipping + item once; SendMo retains shipping, transfers item to seller on release; see §3.8). The original "silent two-PI UX" subsection from round 1 is dropped — there's only ever one card charge, one 3DS prompt, one statement line. The remaining UX work is balance-combine logic, which applies to **all** shipping flows (full-label, flex-link, escrow):

- **One Payment Element, one Pay button.** Standard.
- **Statement descriptor.** `SENDMO* SHIPPING` for full-label and flex-link; `SENDMO* SHIPPING` (still) for escrow — the buyer-facing experience is identical regardless of whether the shipment has a seller-side transfer downstream.
- **Combine when balance covers part of the charge.** If the user's `user_wallet_balance` ≥ some portion of the total:
  - That portion is recorded as a `balance_redeem` ledger write (instant; no Stripe call).
  - The Stripe PI amount is reduced to `total − balance_redeemed`. If that's $0, no PI is created at all.
  - The two `transactions` rows tagged `'split'` (one `balance_redeem`, one `charge` with `funding_source='card'`) are linked by `shipment_id`. Resolving "what funded this" walks both rows (§3.11).
- **Combine when balance covers everything.** If balance ≥ total: zero Stripe PIs, zero card charges.
- **Escrow combine ordering rule (Phase 3 only):** when balance partially covers an escrow shipment, balance is applied to the **item portion first**, not the shipping portion. Reason: balance applied to shipping is gone forever (shipping is nonrefundable to the buyer regardless); balance applied to the item portion comes back as a balance credit on dispute (the item refund routes back to its source). Applying to item-first preserves the user's optionality under disputes.

### 4.7 Hold-exceeded policy on flex-link — D-then-C (sender never blocks)

If the sender's actual carrier rate at label-buy time exceeds the authorized hold (e.g., recipient's `priceCap` was $20, sender's actual rate is $24.50), the **sender never sees the gap.** Policy:

```
1. D (debit-the-hold): capture the full authorized hold amount immediately
   from the recipient's card. Sender gets the label. EasyPost gets paid
   from SendMo's working capital for the gap.
2. C (collect-the-rest): SendMo records a 'pending_recipient_recovery'
   adjustment. Recipient sees in their dashboard:
     "Your link generated a label that cost $24.50, exceeding your $20
      authorized cap by $4.50. Add a payment to settle, or void the
      shipment within 24h."
3. If recipient ignores: after 72h, SendMo auto-debits the saved card on
   file (which was used for the original hold) for the gap. Off-session
   PaymentIntent. Same statement line family (SENDMO* SHIPPING).
4. If auto-debit fails: shipment is flagged in admin reconciliation;
   SendMo's working capital absorbed the gap; manual recovery (rare).
```

**Why D-then-C and not block-and-reauth:** the alternative is "sender hits Pay, gets an error, recipient gets emailed to re-authorize" — that breaks the recipient's promise to the sender ("just hit my link, I've got it covered") and creates a UX dead-end the sender can't resolve themselves. Worth the credit risk on edge cases. The credit risk is bounded: holds use the `MIN(priceCap, p95+buffer)` formula (§3.5), so the gap is rarely large; saved cards are always on file; auto-debit succeeds in the high-90s percent.

This is also forward-compatible with the carrier-adjustment recovery flow in §3.7 — same auto-debit machinery.

---

## 5. Reconciliation + testing systems

### 5.1 Admin reconciliation report

New page at `/admin/reconciliation` (PIN-gated for now, role-based later). Three views:

**Daily summary table:**

| Date | Shipments | EasyPost cost | Charges | Stripe fees | Refunds | Carrier adj. | Comp loss | Net margin | Drift |
|---|---|---|---|---|---|---|---|---|---|
| 2026-04-26 | 12 | $128.40 | $147.66 | $4.58 | $0.00 | $0.00 | -$8.20 | $14.68 | ✅ |
| 2026-04-25 | 8 | $94.10 | $108.21 | $2.95 | -$11.20 | -$1.20 | $0.00 | -$1.24 | ⚠️ −$0.12 |

Drift column shows ✅ if cron found nothing, ⚠️ + exact diff otherwise. Pending carrier adjustments (recovery_status='pending') show in the row.

**Per-shipment drilldown:** sortable by drift, profit margin %, etc.

**Comp labels view:** shows comp shipments separately with negative margin = -EasyPost cost. (Resolves WISHLIST item.)

**Carrier adjustments view (Phase G+):** lists all `carrier_adjustments` rows by `recovery_status`. Pending ones surface to John for action.

Implementation: new Edge Function `reconciliation-report` (admin-gated, returns JSON). Joins `shipments` ↔ `transactions` ↔ `refunds` ↔ `holds` ↔ `carrier_adjustments`.

### 5.2 End-to-end test harness (manual)

`/admin/test-harness`, PIN-gated, **also** gated behind `ALLOW_TEST_HARNESS=true` env var (default `false` in production — round-1 P6). Page returns 404 if the env flag is false.

Single button: **"Run end-to-end smoke test."** No real money. Same 12 steps as the original draft, plus:
- Step 13: assert `funding_source` recorded correctly on every row.
- Step 14: assert no orphan `carrier_adjustments` rows.

This single button proves all events fire in order, all signatures verify, all idempotency keys deduplicate, and the math sums. Run before every release.

### 5.3 Automated tests (extends SPEC §22 pyramid)

**Unit (Vitest):**
- `src/lib/pricing.test.ts`: margin formula, hold formula (P95-based), fee absorption math.
- `src/lib/idempotency.test.ts`: key generator collision-free over 100k inputs (both layers).
- `supabase/functions/_shared/stripe-fee.test.ts`: extraction from `balance_transaction` shape.

**Integration (Node scripts in `tests/integration/`):**
- `stripe-payment-intent.mjs`: against Stripe test API; create + confirm + capture; assert shape.
- `stripe-webhook-idempotency.mjs`: replay same event 5×; assert exactly 1 ledger row.
- `reconciliation-math.mjs`: seed 50 shipments with known costs/charges/fees/refunds/adjustments; assert to-the-cent match.
- `easypost-hmac.mjs` (Phase 0): replay an EasyPost webhook with mutated body; assert 400.

**E2E (Playwright):**
- `tests/e2e/full-label-payment.spec.ts`: real Stripe Elements iframe with test card 4242; assert success state + ledger.
- `tests/e2e/payment-decline.spec.ts`: card 4000-0000-0000-0002 → friendly error → no shipment.

CI gating: integration tests run only when `STRIPE_SECRET_KEY_TEST` is in CI secrets.

### 5.4 Daily reconciliation cron

`pg_cron` job runs daily at 03:00 UTC, calls `reconcile-stripe`:

```
1. window = comparison on Stripe `available_on` (next-business-day),
   not `created` — eliminates timezone-boundary flapping (round-1 P5).
2. stripeBalanceTxs = stripe.balanceTransactions.list({
     available_on: { gte, lt }, type: 'charge,refund' }) — paginated.
3. localTxs = SELECT FROM transactions
              WHERE created_at IN [window − 24h grace, window + 24h grace]
              AND mode = 'live'.
4. Compare on stripe_charge_id with ±$0.01 tolerance:
   - In Stripe, not local: write reconciliation_drift ('orphan_stripe_charge').
   - In local, not Stripe: write reconciliation_drift ('orphan_local_charge').
   - Amount mismatch beyond $0.01: write drift event with both values.
5. Drift events recorded immediately (audit). Alert email gated on:
     age > 24h AND amount > $0.01.
   This avoids alert fatigue from in-flight charges and rounding.
6. If alert-eligible drift > 0:
   - email support@sendmo.co (Resend)
   - log severity=error event for monitoring alert
```

Drift never auto-resolves. John (or a future admin tool) writes an `adjustment` transaction if a fix is needed. **Drift is never silently corrected.**

---

## 6. Migration + rollout

The first dollar must move safely. Each phase has a falsifiable gating criterion. The phasing now opens with **Phase 0** (EasyPost HMAC) per round-1 B2 and ends with carrier-adjustment recovery + ACH balance topup before Phase 3.

| Phase | What ships | Money risk | Gating criteria |
|---|---|---|---|
| **0. EasyPost HMAC backfill** | `webhooks/index.ts` verifies `x-easypost-hmac-signature`. Replay tests added. | None | Mutated-body webhook returns 400; valid-body webhook returns 200; production logs show no false-rejects for 48h. |
| **A. Schema land + labels rewrite** | Migration 012: move `payment_method` onto `shipments`; drop `payments`; add `transactions`, `holds`, `refunds`, `payment_methods`, `stripe_intents`, `carrier_adjustments`, `is_test` on `sendmo_links`, `stripe_payment_intent_id` + `escrow_id` slots on `shipments`. View `user_wallet_balance`. **Lockstep code change:** `supabase/functions/labels/index.ts:297-328` `payments.insert(...).then(...)` block replaced with `await supabase.from('transactions').insert({type:'comp_grant', funding_source:'comp', amount_cents: -easypost_cost_cents, ...})`. (Round-2 B1 + B2.) | None | All migrations apply clean; RLS test queries pass; trigger blocks UPDATE/DELETE on `transactions`; `/admin/reconciliation` renders existing comp labels with negative margin; **zero `payments.insert` references remain in the codebase**; one live-comp shipment ships post-migration and produces a `comp_grant` ledger row. |
| **B. Setup Intent + saved cards (dashboard)** | Dashboard "Add card" UI uses SetupIntent. Webhook writes `payment_methods`. (No charging yet.) | None | John saves his own card test+live; appears in dashboard; signature verification works in both modes. |
| **C. Self-charge dogfood (live)** | Full-label flow swaps `MockPaymentForm` → real Stripe Elements with PaymentIntent. Admin toolbar gains "Live Charge" mode. Charges allowed only for users in `PAYMENTS_ALLOWED_USERS` env allowlist (round-1 P3). | $5–$50 per test, all to John | 5 successful self-charges; reconciliation correct to the penny; drift cron clean for 48h; void→refund tested once. |
| **D + F (combined). Public launch — full-label + refunds** | Remove allowlist. Anyone can pay. `processRefund()` in `refundService.ts` calls Stripe Refunds API on void. User-facing void in dashboard. (Round-1 P10.) | Real customer money | First 14 days: daily reconciliation manually reviewed; payment failure rate <5% (SPEC §19); zero unexplained drift; one real customer void successfully refunded end-to-end. |
| **E. Flex-link auth/capture** | Step 22 wired with manual-capture PaymentIntent using P95-based hold formula (§3.5). Sender path captures on label buy. D-then-C exceed handling (§4.7). Hold-expiration webhook handler primary; nightly cron backstop (round-1 P7). | Real money on flex links | Full auth → capture → release excess cycle in test harness; one real flex-link cycle dogfooded by John; one rate-exceeds-hold synthetic event verified to settle via D-then-C. |
| **G. Carrier rate adjustment recovery** | EasyPost adjustment events flow into `carrier_adjustments`. Tiered $2 / $10 / $10+ recovery loop (§3.7). Admin surface for >$10. | Recovers existing margin leak | One real reweigh-style adjustment recovered via auto-debit; one absorbed silently below $2; admin sees pending list. |
| **2 + H. Prepaid balance + ACH topup** | Balance UI on dashboard. Card topup (instant) + ACH topup via Stripe Financial Connections (settle-then-credit, §3.9). 5% bonus credited on settlement. NACHA disclosure. Combine-when-balance-covers logic (§4.6) for shipping flows. | Funds-on-deposit liability appears | $200 ACH topup by John clears in 3–5 business days; $210 balance reflects with separate `balance_topup` + `balance_topup_bonus` rows; subsequent shipment uses balance redeem with no Stripe PI. **ACH-fail path:** if `payment_intent.payment_failed` arrives instead of `payment_intent.succeeded`, no rollback logic is needed — the balance was never credited (settle-then-credit), the PI's `processing` state simply terminates. User notified, no ledger writes, no reversal flow to maintain. (Round-2 nit.) |
| **3 (post-MVP). Escrow** | `escrows` table; two-PI checkout flow; Connect destination charges on PI #2; statement descriptor suffixes per §4.6. | Marketplace-grade compliance scope | Out of MVP scope; called out for forward-compat only. |

**Rollback discipline:** every phase has an env-var revert. `PAYMENTS_ENABLED=full|setup_only|off`. `BALANCE_ENABLED=full|read_only|off`. `ACH_TOPUP_ENABLED=true|false`. Set to safer value, redeploy, behavior degrades to the prior phase.

**Migration 012 is all-or-nothing (round-2 N5).** It is one atomic migration: 1 DROP TABLE + 7 CREATE TABLE + 4 ALTER TABLE + 1 CREATE VIEW + 1 CREATE FUNCTION + 2 CREATE TRIGGER + ~10 CREATE INDEX + REVOKE/GRANT + RLS policies. If any single statement fails on prod, Postgres rolls the whole thing back and we're at migration 011. There is no partial-state recovery — the rollback path is "fix the failing statement in 012 and redeploy 012 from scratch." Phase A's gating criteria assume the migration either fully landed or fully reverted; intermediate states are not a possible outcome.

**John tests with his own money before opening to real users:**
- Phase B: dogfood SetupIntent in test + live (no money moves).
- Phase C: charge his own card $1–$50/shipment for ~1 week. All margin tracking validates.
- Phase E: dogfood a real flex link to himself.
- Phase H: dogfood ACH topup of $50 to his own balance.

---

## 7. Risks + open questions

### Requires John to decide

The five original decisions remain open; rounds 2–3 added five more. The full list is in §11. The risks below are the architectural ones not already decision-coded.

### Expensive to get wrong

- **Forgetting to filter by `mode` in reconciliation.** Test charges polluting live margin. Mitigation: every reconciliation query has `WHERE mode='live'`; default tab is 'live'; explicit "Test"/"Live" tabs.
- **Webhook handler not idempotent.** Double-counting a single charge. Mitigation: 3 idempotency layers (§4.5) + integration test that replays the same webhook 5×.
- **`UPDATE` on `transactions`.** Mitigation: REVOKE + trigger (§3.1).
- **Hold expiration unhandled.** Stripe auto-voids at 7d; if our state isn't updated, dashboards show stale "authorized." Mitigation: webhook is primary truth; nightly cron backstops missed webhooks (round-1 P7).
- **Webhook arrives late vs synchronous label issuance.** Per §3.4 state machine, `labels` confirms with Stripe API directly and writes the shipment row. Webhook lands later and writes the ledger. The reconciliation tolerance + 24h grace (§5.4) accommodates the in-flight window without alerting.
- **Webhook never arrives (Stripe outage).** Reconciliation cron's "shipment with no matching `transactions.charge` for >24h" alert catches this. Recovery script can backfill from Stripe API.
- **Live customer data in test events.** Stripe enforces test/live key separation; we never copy a `pi_test_...` ID into a live flow.
- **ACH clawback fraud.** Mitigated by settle-then-credit (§3.9). User can't spend balance until ACH clears; clawback after settlement is a refund, not a free label.
- **Carrier adjustment auto-debit consent.** Charging the saved card off-session for a $5 reweigh is technically a separate transaction the user didn't initiate. Mitigation: tier policy (auto only $2–$10), notification, original consent disclosure on link creation.
- **D-then-C credit risk.** Bounded by P95-based hold formula; saved card on file; auto-debit success rate; magnitude per shipment small.
- **Carrier-rate-change impact on D-then-C** (round-2 N7). Per-shipment magnitude is small but rates can shift en masse — USPS's January rate increase typically lifts every Ground Advantage rate by 5–8%, which affects every flex link with a `priceCap` that didn't get updated. Exposure is `(new_rate − hold) × shipments_in_window`, and if `priceCap` is the binding constraint (recipient set $5 cap on a route that's now $6.50), every shipment on that link triggers a $1.50 D-then-C event. Mitigation: a **rate-change sweep-through script** runs whenever EasyPost reports a carrier base-rate change (or quarterly): re-quotes the P95 for every active flex link, identifies links where `priceCap < new_p95 + buffer`, emails the recipient with a one-click "raise cap to $X" CTA before the next shipment authorizes. Avoids 72-hour funding spikes around rate announcements.

### Requires external setup (John performs)

- Create Stripe live mode account (currently test only).
- Configure Stripe webhook endpoints in dashboard for `https://fkxykvzsqdjzhurntgah.supabase.co/functions/v1/stripe-webhooks` (test + live, different secrets).
- Add to Supabase secrets: `STRIPE_SECRET_KEY_LIVE`, `STRIPE_WEBHOOK_SECRET_TEST`, `STRIPE_WEBHOOK_SECRET_LIVE`. Test secret already in 1Password.
- Add to Vercel env: `VITE_STRIPE_PUBLISHABLE_KEY_LIVE`.
- Confirm Stripe business profile + banking + tax info (required before live charges).
- Phase H: enable Stripe Financial Connections in the dashboard.
- Confirm `EASYPOST_WEBHOOK_HMAC_SECRET` in Supabase secrets (currently in 1Password).

---

## 8. Out of scope

- **Multi-currency.** USD-only.
- **Subscription / recurring billing.** Never planned.
- **3DS strong-customer-auth UX polish.** Stripe Elements handles the redirect; tuning copy for European cards is later.
- **Apple Pay / Google Pay.** Slot in via Payment Element later.
- **Dispute / chargeback management UI.** Schema supports `chargeback`; admin UI is post-MVP.
- **Stripe Tax.** Most US states exempt postage; defer until first complaint.
- **ACH Direct Debit on shipping/escrow checkout.** Cards-only on shipping. ACH is for balance topup only (§3.9). 3–5 day settlement is wrong for "I need a label now."
- **Plaid.** Replaced by Stripe Financial Connections in §3.9. Phase H ships without Plaid.
- **SendMo Balance UI.** Schema and ledger types ship in MVP (Phase A); UI/topup flow is Phase 2 + H, not MVP.
- **Escrow / marketplace flows.** Forward-compat surface ships in MVP migration (FK slots, `intent_role`, `transfer_group`); the table and flow are Phase 3.
- **Gift balance / promo codes.** Not modeled in this proposal; would extend the `balance_topup_bonus` shape.

---

## 9. Verification (post-implementation)

End-to-end walkthrough per phase:

**Phase 0:** Replay an EasyPost webhook with a mutated body — receives 400. Replay with valid signature — 200, normal handling. No false rejects in production logs over 48h.

**Phase A:** `psql -c "\d transactions"` shows the table; INSERT works as service_role; UPDATE/DELETE raise. `\d sendmo_links` shows `is_test`. `/admin/reconciliation` renders existing comp shipments with negative margin.

**Phase B:** `/dashboard` Add Card → real Stripe Elements → Stripe test card → "Card saved." `payment_methods` row matches brand+last4.

**Phase C:** Test harness all green. Self-charge own live card; reconciliation row shows margin matching SendMo formula minus actual Stripe fee from `balance_transaction`. `PAYMENTS_ALLOWED_USERS=[John]` rejects any other UID's charge attempt.

**Phase D + F:** After 14 days: drift count = 0 alert-eligible; one real customer void → real Stripe refund → ledger has `−refund` row → customer's bank shows credit within 5–10 business days.

**Phase E:** Real flex link → real sender flow → captured ≤ authorized → ledger correct. Synthetic rate-exceeds-hold → D-then-C settles within 72h.

**Phase G:** Real EasyPost reweigh adjustment under $2 → absorbed silently. $2–$10 → auto-debited from saved card; ledger has new `+charge` row; `carrier_adjustments.recovery_status='recovered'`. >$10 → admin sees pending row.

**Phase 2 + H:** $50 ACH topup → 3–5 day settlement → balance shows $52.50 ($50 + 5%). Subsequent $30 label uses `balance_redeem`; no Stripe PI created; `user_wallet_balance` decrements correctly.

---

## 10. Open questions — resolution status after round 2

The round-2 reviewer engaged on three of the four round-2 author questions; the fourth (forward-compat slots) was implicitly affirmed (round-2 found no missing slots). Resolution after this revision:

1. **Two-PI escrow vs single-PI-with-Connect — RESOLVED.** Round-2 reviewer (N1) pushed back on two-PI; John directed: "single charge, but they have different destinations — shipping $ comes to me, the other goes to seller." Implemented as **single PaymentIntent + separate `transfers.create`** in §3.8. The `application_fee_amount` pattern was considered but rejected because shipping naturally never leaves SendMo's balance with the transfers.create approach (no `refund_application_fee=false` policy needed). Settled.

2. **Settle-then-credit ACH timing — RESOLVED.** Round-2 reviewer affirmed the settle-then-credit choice ("non-negotiable for a prepaid feature"). The 3–5 day delay is acceptable in the context of "deposit once, save 5% forever" framing; instant card-funded topups remain available as the escape valve. No change.

3. **D-then-C credit risk — RESOLVED with mitigation added.** Round-2 reviewer (N7) called out the macro risk (USPS rate-change sweep) the per-shipment math missed. Mitigation added to §7: rate-change sweep-through script. Auto-bumping `priceCap` rejected (it would break the recipient's promise to senders); instead, recipients are emailed with a one-click cap-raise CTA when their cap goes under-spec'd.

4. **Forward-compat slots — RESOLVED.** Round-2 review found no missing slots beyond what the proposal already adds (`intent_role`, `transfer_group`, `funding_source`, `escrow_id`, `stripe_payment_intent_id` on `shipments`). The single-PI Connect model in §3.8 reuses `shipments.stripe_payment_intent_id` for both escrow and non-escrow shipments — no new column needed for Phase 3. Confirmed.

---

## 11. Decisions needed from John before implementation can start

Five from the original draft, five added in rounds 1–2. After round 2: #7 (escrow Connect model) is **RESOLVED** by John's directive (single-PI + separate transfer; §3.8); #10 is **PROMOTED** from pre-Phase-G to **pre-Phase-E** because D-then-C also auto-debits off-session. Phase H also gains a new pre-req (MTL/KYC scrutiny) deferred to its own legal review per John's "review later" directive.

1. **Refund destination policy** (round-1 B1, original #1). Original card (recommended for MVP) or SendMo balance (current SPEC). SPEC §13.1 contradicts itself today. Drives Phase F shape and SPEC update.
2. **Stripe fee absorption** (original #2). Absorb (status quo, thin margins on cheap labels), $0.30 surcharge under $10, or raise margin to 17–18%. Drives pricing change + marketing copy.
3. **Hold-exceeded policy** (original #3, refined). Author's recommendation is now D-then-C (§4.7). Confirm or pick block-and-reauth.
4. **Account creation timing for full-label** (original #4). Auto-create Supabase user before payment step (recommended) or orphan Stripe Customer reconciled later.
5. **Live-mode admin UX** (original #5). The current PLAYBOOK admin toolbar shows two modes (Test | Live Comp); this proposal **adds a third mode (Live Charge)** for Phase C self-charge dogfood and beyond. Confirm three-mode UX, or replace PIN gate with role-based auth before this ships.
6. **Prepaid balance discount/incentive variant** (new, round 1). Flat 5% bonus (recommended for launch — matches SPEC §3), tiered, or first-topup-only. Drives §3.6 and Phase 2 + H copy.
7. ~~**Escrow Connect model confirmation**~~ — **RESOLVED post-round-2** per John: single-PI on platform + separate `transfers.create` to seller's Stripe Connect Express account on delivery. Two-PI design dropped. JIT seller KYC at first transfer attempt (§3.8). No further decision needed; Phase 3 implementation proposal will detail dispute-with-already-transferred handling.
8. **Carrier adjustment thresholds and caps** (new, round 1, refined round 2). $2 absorb / $2–$10 auto / >$10 manual, **PLUS** per-shipment cumulative cap ($10 lifetime), per-card per-24h cap ($20), per-user per-7d cap ($50) (§3.7). Confirm or override. Final values pending Phase D data; policy shape needs sign-off before Phase G.
9. **ACH credit timing** (new, round 1). Settle-then-credit (recommended) or instant-credit-with-reserve. Settle-then-credit is in the proposal.
10. **Auto-debit consent for off-session card charges** (new, round 1; **promoted to pre-Phase-E** by round-2 B3). D-then-C recovery (§4.7) and carrier-adjustment auto-debit (§3.7) both charge the saved card off-session in flows the user didn't initiate at the moment of charge. Pick one:
    - **(a) Explicit mandate at link creation:** checkbox + Stripe-compliant mandate string ("I authorize SendMo to debit my saved card up to $X for shipping cost variance and post-pickup adjustments through {date}"). Path most marketplaces use; survives chargeback disputes.
    - **(b) Per-event reauth:** every D-then-C and every >$2 carrier adjustment requires a fresh customer approval flow (email → click-through). High friction; recovery rate drops materially.
    - **(c) Hard cap on unattended auto-debit:** e.g., $5 lifetime per shipment via off-session; everything else routes to manual. Limits exposure but doesn't eliminate it.
    Author recommendation: (a). The NACHA disclosure pattern (already in §3.9 for ACH topup) is the wrong instrument for card off-session — Stripe expects an explicit mandate, not a passive ToS line. Decision needed before Phase E coding begins.
11. **Phase H balance MTL / KYC scope** (new, round 2 N3, **deferred per John "review Phase H later"**). The §3.9 prepaid balance feature creates funds-on-deposit liability that some states regulate as money transmission independent of the activity. SPEC §20 anticipates this for Phase 3; Phase H is the trigger. Decision: legal review of customer-funds-held thresholds in {state list} required before Phase H ships — but full scope of this decision is itself deferred to the Phase H review. Listed here so it doesn't get lost.

**Gating sequence (post-round-2):**
- Phase A starts when **#1, #2, #3, #4, #6** are decided.
- Phase C blocked on **#5**.
- Phase E blocked on **#3** (already on Phase A's gate) **+ #10**.
- Phase G blocked on **#8**.
- Phase H blocked on **#9, #11**.
- Phase 3 (post-MVP) — no remaining John-decisions; #7 resolved.

---

## Review

```yaml
reviewer: Claude (opus-4-7) — fresh-eyes reviewer, 2026-04-26
reviewed_at: 2026-04-26
verdict: approve-with-changes
```

### Summary

Sound architecture and the right shape — append-only ledger with REVOKE+trigger, server-derived mode, three-layer idempotency, fee-from-`balance_transaction`, and phased rollout with falsifiable gates all reflect real engineering judgment. The proposal is on the high end of single-proposal complexity (7 tables, 3 new functions, 6 phases) — best read as a roadmap where each phase will likely become its own implementation PR. Four blocking items are tractable in-body or via a John decision; everything else is pinning.

### Blocking issues

**B1. Refund-destination contradicts SPEC and gates ledger usage.**
- *Location:* §7.1 (open question to John), §3.5 state machine, §3.3 `user_wallet_balance` view.
- *Issue:* §7.1 frames refund destination as a TBD with author recommending refund-to-card. SPEC §13.1 step 7 says "Credit appears as SendMo account balance (not original payment method in Phase 1)" — but SPEC §13.1 line 744 contradicts itself with "Stripe refund to original card will be added in this phase." So SPEC is incoherent today, and the decision determines whether the `balances`/`user_wallet_balance` view is dead weight in Phase A or load-bearing. The state machine in §3.5 also assumes refund-to-card (`tx.refund(−amount)` is a Stripe-side refund); a balance-credit refund would be `tx.balance_topup(+amount)` instead.
- *Suggested fix:* Surface the SPEC contradiction explicitly to John. Recommend the proposal commit to **refund-to-card for MVP** (matches §3.5 as drawn, simplest user mental model, no balance UI dependency), and queue a SPEC §13.1 update as a follow-up artifact. If John picks balance, §3.5 needs a redraw.

**B2. Webhook signature parity gap with EasyPost.**
- *Location:* §4.3 (Stripe signature verification), and silently absent in scope: existing `supabase/functions/webhooks/index.ts` (EasyPost).
- *Issue:* PLAYBOOK Rule 8 says "ALWAYS verify webhook signatures (Stripe + EasyPost)." Confirmed via grep — the EasyPost handler does not verify HMAC today (no `hmac` / `x-easypost-hmac-signature` references in the file). The proposal raises the bar for Stripe but leaves the existing rule violation untouched. Future agents will read this proposal and assume EasyPost is fine because Stripe got it right.
- *Suggested fix:* Either (a) add a §6 phase pre-Phase-A entry for "Backfill EasyPost HMAC verification" (small change; one Edge Function), or (b) add an explicit WISHLIST entry now and call it out in §8 "Out of scope" so the gap doesn't go unflagged.

**B3. Server-side `mode` source for Stripe is hand-waved.**
- *Location:* §4.4 ("Edge functions resolve mode from server-side state: `sendmo_links.is_test` (added in migration 005 for shipments, propagate to links)"); §4.2 step 1 (`mode_implied_by_admin_state`).
- *Issue:* Migration 005 only adds `is_test` to `shipments`, not `sendmo_links`. The "propagate to links" needs either a migration in this proposal's scope or explicit deferral. More importantly, Rule 14 says critical decisions never come from the client — but §4.2 step 1 takes `mode_implied_by_admin_state` as a request param without spelling out the validation chain (admin role check from JWT? feature-flag?). Gets the architecture half-right; the chain to "where does mode actually come from at link-create time" needs to be drawn end-to-end.
- *Suggested fix:* Add a `is_test` column to `sendmo_links` in migration 012 (or an earlier migration scoped to this proposal). At link-create time, server reads admin role from JWT (not from request body); if `is_admin && admin_toolbar_mode='live_charge'` → `is_test=false`, else `is_test=true`. Subsequent payment-intent calls read `is_test` from the link, not from the client. Document this explicitly in §4.4.

**B4. Race-mitigation in §7 writes the ledger from two places — split-brain risk.**
- *Location:* §7 "expensive to get wrong" item #5 ("Race between webhook and synchronous response").
- *Issue:* Proposed mitigation has `labels` Edge Function check the ledger and write it itself if missing (using the same idempotency key as the webhook), with `ON CONFLICT DO NOTHING` once the webhook arrives. Two problems: (a) the LOG entry from 2026-04-26 just got burned by fire-and-forget DB writes in `labels` — running ledger writes there repeats the pattern; (b) the `fee_stripe` row needs `charge.balance_transaction` data that *only* the webhook has. So `labels` would write `+charge` but not `-fee_stripe`, then the webhook lands `-fee_stripe` later — reconciliation queries during the gap show drift on every shipment.
- *Suggested fix:* Pick the webhook as the sole writer. Two options: (a) the frontend doesn't call `labels` until the webhook lands (poll `stripe_intents.status` or use a Supabase realtime subscription); (b) `labels` runs *as part of* the webhook handler — `payment_intent.succeeded` triggers both ledger write and EasyPost label buy in one transaction. (b) is closer to how most payment-driven fulfillment systems run.

### Non-blocking concerns

**P1. Single-entry vs double-entry (§10 Q1).** Author's instinct (single-entry signed-cents) is right for MVP. Most modern payments-platform customer ledgers look exactly like this; double-entry shows up when escrow/marketplace shows up. Pin as a Phase-3-revisit, not an MVP decision.

**P2. Stripe-vs-EasyPost webhook split (§10 Q2).** Keep them split. Different secrets, retry behaviors, dedup keys, observability. The "3 lines of conditional" framing undercuts the per-handler unit testing and blast-radius story. Affirm §2's argument.

**P3. Phase C kill-switch is too coarse (§6, §10 Q3).** `PAYMENTS_ENABLED=full|setup_only|off` is binary-ish. Add an explicit `PAYMENTS_ALLOWED_USERS` allowlist (env var, comma-separated UUIDs) for Phase C — only John's user_id can charge anything live, even if `PAYMENTS_ENABLED=full`. Belt-and-suspenders against a code bug that drops the `is_admin` check.

**P4. Disposition of `payments` table (§3.4) — recommend Option B, not A.** §1 explicitly says "every cent of revenue is currently fictional." Per migration 009 and the comp ledger story, the only `payments` rows in production are test/comp records; there's no paper trail to preserve. Drop in migration 012; saves a migration cycle.

**P5. Reconciliation cron will alert-fatigue (§5.4).** "drift > 0 → email" against Stripe's `created` vs our `created_at` will flap on timezone-boundary charges (Stripe at 23:59:55, our DB at 00:00:01 in different windows). Recommend: window comparisons on Stripe `available_on` (next business day) with a ±$0.01 tolerance, or a 24-hour grace period before alerting. Drift never auto-resolves (good, keep that), but alerts shouldn't fire on timing artifacts.

**P6. Test harness (§5.2) — gate behind env flag.** A "Run end-to-end smoke test" button that creates synthetic users + intents in production is useful but it's a credential-bearing button on a PIN-gated page. Add `ALLOW_TEST_HARNESS=true` env gate; default `false` in production. Cheap insurance.

**P7. Hold expiration handler — webhook is primary, cron is fallback.** §4.3 step 6 already lists `payment_intent.canceled` (Stripe sends this on hold expiration). §7 mentions a "nightly cron" — that's fine as a backstop, but the webhook should be the primary truth-source so dashboards aren't ~21 hours stale. Make this explicit in §4.3.

**P8. Idempotency key for legitimate retries (§4.5).** `${link_id}:${flow_step}:${mode}` is identical across user-initiated retries (e.g., card declined → user retries with new card). Stripe will return the original failed intent. Recommend including a retry counter: `${link_id}:${flow_step}:${mode}:${retry_n}` for the Stripe-API layer; the ledger-row key (different layer) stays derived from `pi_xxx:succeeded:charge`.

**P9. Comp-mode interaction with `stripe_intents` is unstated.** Today's "Live Comp" creates a real EasyPost label without payment. Under the new architecture: comp shipments produce a `transactions` row of type `comp_grant` (negative margin) but no `stripe_intents` row. Make this explicit in §3 — `shipments.payment_method='comp'` (per migration 009) is the gate, and the Stripe path is skipped entirely.

**P10. Phase F (refund) might want to come forward.** Voids exist today (admin button); refund stub exists today (`refundService.ts`). Once Phase D opens to public, the first real customer's first void wants a working refund — refund credit-to-balance only feels like a bait-and-switch. Either pull Phase F to land alongside Phase D, or document explicitly that until F ships, all customer voids are credit-to-balance with a 2-4 week processing window in the user-facing copy.

### Nits

- §1: "money in the bank to" — missing closing quote.
- §3.1 fee comment: "Stripe occasionally adjusts (international cards, ACH, etc.)" — ACH is out-of-scope per §8 (multi-currency / ACH = Phase 3). Drop the ACH reference or scope to "international cards."
- §6 Phase B "John saves his own card test+live" — saving a card live without a charge requires SetupIntent (§4.1 acknowledges this for the post-MVP Add Card UI). Phase B's flow needs SetupIntent for live, not PaymentIntent w/ `setup_future_usage`. State explicitly.
- §3.4 Option A's argument ("preserve a paper trail") is weak given §1 already says revenue is fictional today — see P4.

### What the proposal got right

- **Append-only ledger + REVOKE + trigger** (§3.1). Most teams skip the trigger. Belt-and-suspenders Rule 16 enforcement.
- **Server-derived mode recorded on every row** (§4.4). Matches the 2026-02-25 `is_test` LOG decision.
- **Three layers of idempotency** (§4.5). The ledger-row layer is the one most first-time integrators forget.
- **Stripe fee extracted from `balance_transaction`** (§4.3) rather than computed at 2.9% + $0.30. Real-world correct; rare in first integrations.
- **Phasing with falsifiable gating criteria** (§6). Each phase has a "can we ship the next thing yet?" check, not "we shipped X."
- **Manual test harness button** (§5.2). Simple, durable, lets John smoke-test end-to-end before each release.
- **Honest §10 open questions.** Author flagged single-entry-vs-double and dogfooding-risk as the load-bearing forks they wanted pressure on. That's the §10 most reviewers can give back cleanly.

### Implementer checklist (post-decision)

- [ ] B1 — Resolve refund-destination with John; update SPEC §13.1 to be internally coherent; redraw §3.5 if balance-credit wins.
- [ ] B2 — Decide: backfill EasyPost HMAC in this proposal's scope, or carve a WISHLIST entry + §8 mention.
- [ ] B3 — Add `is_test` column on `sendmo_links` in migration 012; document end-to-end mode-resolution chain (admin role from JWT → link.is_test → intent.mode → tx.mode) in §4.4.
- [ ] B4 — Pick single ledger writer (recommend: webhook handler triggers EasyPost label buy + ledger write together).
- [ ] P3 — Add `PAYMENTS_ALLOWED_USERS` allowlist env var to Phase C.
- [ ] P4 — Switch §3.4 to Option B (drop `payments` in migration 012).
- [ ] P5 — Reconciliation tolerance + grace window before alerting.
- [ ] P6 — `ALLOW_TEST_HARNESS` env gate.
- [ ] P8 — Add retry counter to Stripe-API idempotency key.
- [ ] P9 — Document comp-mode interaction with `stripe_intents` in §3.
- [ ] P10 — Decide Phase F sequencing relative to Phase D, or document the credit-to-balance window in user copy.

---

## Author response

```yaml
respondent: Claude (opus-4-7) — original author session, 2026-04-26
verdict_response: accept-with-one-needs-john
```

Verdict-level: approve-with-changes is the right call. The 4 blocking items are tractable, and the reviewer caught one genuine architectural mistake (B4) plus three real gaps. Going point-by-point.

### Blocking issues

**B1. Refund destination — ❓ needs John, with author recommendation.**

Reviewer correctly flagged that SPEC §13.1 contradicts itself (line 720 says "credit to balance," line 744 says "Stripe refund to original card will be added") and that §3.5's state machine assumes refund-to-card. This was already decision #1 in §11 ("Decisions needed from John"); the review surfaces it as load-bearing for the data model and rightly so.

**Author commits to recommending refund-to-card for MVP** in the proposal body, pending John's call. Reasoning: matches §3.5 as drawn, simplest customer mental model, no balance-UI dependency, and the SPEC line 744 "will be added in this phase" is the more recent intent. If John picks balance-credit:
- §3.5 redraws: `tx.refund(−amount)` → `tx.balance_topup(+amount)` to user balance
- `user_wallet_balance` view becomes load-bearing in Phase A, not post-MVP
- SPEC §13.1 line 744 needs deletion
- Phase F becomes "credit-to-balance" instead of Stripe refund (smaller scope; effectively just a ledger write + email)

A SPEC §13.1 reconciliation patch is queued as a follow-up artifact regardless of which way John picks.

**B2. EasyPost HMAC verification gap — ✅ accept, in scope.**

Confirmed: `supabase/functions/webhooks/index.ts` doesn't verify HMAC. Rule 8 violation, separate from this proposal but adjacent enough that ignoring it would be hiding behind narrow scope. Adding **Phase 0** to the rollout (§6) — pre-Phase-A, single Edge Function change to verify EasyPost HMAC — before any Stripe work begins. This is small (~30 LOC) and de-risks Stripe by proving the signature pattern works in our Deno runtime first.

**B3. Server-side mode resolution chain — ✅ accept, in scope.**

Reviewer is right; "propagate to links" was hand-waved. Concrete fix in migration 012:

```sql
ALTER TABLE sendmo_links ADD COLUMN is_test BOOLEAN NOT NULL DEFAULT TRUE;
-- DEFAULT TRUE is deliberate: any link that predates this column must be
-- treated as test until proven live by an admin (fail-safe direction).
```

Mode resolution chain (will be added to §4.4):

```
1. Link create time: server reads JWT → checks profiles.role='admin'.
   If admin AND admin_toolbar_mode='live_charge' (validated against an
   allowlist on the server, not trusted from request): is_test=false.
   Otherwise: is_test=true.
2. Payment intent create: server reads sendmo_links.is_test by link_id.
   Client never sends a mode param. The PaymentIntent's mode is derived
   from which Stripe secret is loaded (test vs live key from Supabase
   secrets, picked by is_test).
3. Webhook handler: mode is implicit from which secret verifies the
   signature. Recorded on stripe_intents, transactions, holds, refunds.
4. Reconciliation: every query filters by mode. Default tab in
   /admin/reconciliation is 'live'.
```

`mode_implied_by_admin_state` in §4.2 step 1 is removed — the request body sends `link_id` only; the server resolves mode from `sendmo_links.is_test`.

**B4. Single ledger writer — ✅ accept, with refined design.**

Reviewer's catch is correct, and the connection to the 2026-04-26 LOG entry on fire-and-forget DB writes is the kind of finding this protocol exists for. Two ledger writers means split-brain on `fee_stripe` (which only the webhook can compute from `balance_transaction`) — reconciliation would drift on every shipment until the webhook lands.

Webhook becomes the **sole ledger writer**. Refined flow:

```
1. Frontend confirms PaymentIntent via Stripe.js → Stripe returns
   "succeeded" synchronously to the client.
2. Frontend immediately calls POST /labels { intent_id, link_id }.
3. Labels function:
   a. stripe.paymentIntents.retrieve(intent_id) — verify status=succeeded
      directly with Stripe API (do not trust client).
   b. Verify intent.metadata.link_id matches the request link_id.
   c. Buy EasyPost label.
   d. Insert shipments row with stripe_payment_intent_id link.
   e. Return label PDF URL to frontend. NO ledger writes.
4. Webhook payment_intent.succeeded arrives (within seconds typically):
   a. Verify signature.
   b. Dedup via webhook_events.
   c. expand: ['latest_charge.balance_transaction'] for fee.
   d. Write transactions: +charge, −fee_stripe.
5. Reconciliation tolerance: see P5 — 24h grace before alerting on
   "shipment exists but no charge tx," which is the natural in-flight
   window.
```

This is closer to reviewer's option (a) but tightened — labels confirms with Stripe API directly rather than waiting for webhook fan-out, preserving instant-label UX. Reviewer's option (b) — running label-buy inside the webhook — is theoretically cleaner but breaks the synchronous user flow ("here's your label" right after pay), which is the entire UX promise of full-label. Worth the small in-flight window.

Edge case: what if the webhook never arrives (Stripe outage)? Already covered by the daily reconciliation cron (§5.4): a `shipments` row with no matching `transactions.charge` for >24h triggers a drift alert and a recovery script can write the missing rows by querying Stripe API directly.

### Non-blocking concerns

**P1. Single-vs-double-entry — ✅ accept.** Pinned as Phase-3-revisit. No change needed in this proposal.

**P2. Webhook split — ✅ accept.** Affirmation; no change needed.

**P3. `PAYMENTS_ALLOWED_USERS` allowlist — ✅ accept.** Adding to §6 Phase C: env var (comma-separated UUIDs), enforced server-side in `payments` Edge Function before any PaymentIntent is created in live mode. During Phase C, the allowlist is `[John's UUID]`; cleared in Phase D.

**P4. Drop `payments` table immediately — ✅ accept.** Reviewer is right; §1 already says revenue is fictional. Switching §3.4 to Option B: `DROP TABLE payments` in migration 012, no historical preservation needed. Saves a migration cycle.

**P5. Reconciliation alert flapping — ✅ accept.** Adding to §5.4: window comparison uses Stripe `available_on` (next business day) not `created`, with ±$0.01 tolerance and a 24h grace period before alerting. Drift events are still recorded immediately (auditability), but the email/Sentry alert is gated on `age > 24h AND amount > $0.01`.

**P6. `ALLOW_TEST_HARNESS` env gate — ✅ accept.** Default `false`. Page returns 404 unless flag is true. Cheap insurance worth taking.

**P7. Hold expiration: webhook primary, cron fallback — ✅ accept.** Clarifying §4.3 step 6: `payment_intent.canceled` is the primary truth-source for hold voiding. Nightly cron (currently in §7) is reframed as a backstop that catches missed webhooks (Stripe outage during 7-day expiration window) — runs daily, queries `holds` where `expires_at < now() AND status='authorized'`, calls Stripe to confirm, marks `expired`.

**P8. Retry counter on idempotency key — ✅ accept.** Splitting the key into two layers (which I should have done originally):

```
Stripe-API layer (allows retries with new card):
  ${link_id}:${flow_step}:${mode}:retry-${retry_n}
  retry_n increments on each user-initiated retry; Stripe sees a fresh
  intent, not a replay of the failed one.

Ledger-row layer (still strict, derived from Stripe IDs):
  pi_xxx:succeeded:charge
  pi_xxx:succeeded:fee
  ch_xxx:refunded:refund
```

Stripe layer = "did we mean to call Stripe again." Ledger layer = "did we already record this Stripe event."

**P9. Comp-mode interaction with `stripe_intents` — ✅ accept.** Adding to §3:

> **Comp shipments skip the Stripe path entirely.** When `sendmo_links.is_test=false` AND admin invokes "Live Comp" mode, the labels function buys a real EasyPost label without creating a PaymentIntent. The `transactions` row is `type='comp_grant'` with `amount_cents` = −EasyPost cost (negative margin). No `stripe_intents` row, no `payment_methods` row. The gate is the existing `shipments.payment_method='comp'` enum from migration 009.

This also resolves the open WISHLIST item "Comp labels should show negative margin."

**P10. Phase F sequencing — ✅ accept, pulling F alongside D.**

Reviewer's framing is correct: shipping public charging without working refunds means the first customer void (which will happen — voids exist today) creates a UX failure. Phase F lands alongside Phase D, not after.

If John picks credit-to-balance (B1), Phase F is effectively just a ledger write — small enough to land with D. If John picks refund-to-card, Phase F is the Stripe Refunds API integration — bigger but still parallelizable with D's launch prep.

Updated rollout sequence in §6:
- Old: A → B → C → D → E → F
- New: A → B → C → **(D + F together)** → E

### Nits

- ✅ §1 typo (missing closing quote on "money in the bank to") — fixed in body cleanup.
- ✅ §3.1 ACH reference — dropped, scoped to "international cards."
- ✅ §6 Phase B clarification — saving a card live without a charge requires a SetupIntent (since we don't have a pending payment to use `setup_future_usage` against). Phase B is split: full-label path uses PaymentIntent w/ `setup_future_usage` from Phase C onward; standalone "Add card" UI on dashboard uses SetupIntent. Phase B in current rollout skips standalone card-save; first card-save happens in Phase C as part of first PaymentIntent.
- ✅ §3.4 Option A weak argument — moot per P4 (switching to Option B).

### What I'm changing in the proposal body

A revised version with all ✅ items applied will be written as a follow-up commit to this same file (sections 1–7 updated in place per reviewer permission for revisions; the review and this response remain immutable). Filename will then move to `_reviewed-2026-04-26_decided-<date>.md` once John resolves B1 and the open §11 decisions.

### Status of the 5 original §11 decisions for John

The review didn't introduce new escalations — the existing 5 decisions are still the gating items, with B1 (refund destination) being the most load-bearing. **John needs to decide #1–#4 to unblock Phase A. #5 only blocks Phase C.** No new "## Tradeoffs for John" section needed; the existing §11 already lays out each option with cost/gain.

---

## Review — Round 2

```yaml
reviewer: Claude (opus-4-7) — fresh-eyes reviewer, 2026-04-26 (round 2)
reviewed_at: 2026-04-26
verdict: approve-with-changes
```

### Summary

The revision is genuine engagement, not paper-over: the round-1 architectural finds (sole ledger writer, server-derived mode chain, EasyPost HMAC backfill, drop-`payments`-immediately) all landed cleanly, and the new §3.5 hold formula + §4.7 D-then-C policy + §3.9 settle-then-credit ACH are the right shapes. But the four post-review threads (balance, ACH, two-PI escrow, carrier adjustments) added scope the proposal doesn't fully absorb: there is one factual claim in §3.10 that's wrong against the code, the two-PI escrow rationale is incomplete and may be the wrong Stripe primitive, the auto-debit consent gap (Decision #10) is acknowledged but unresolved, and §3.7's auto-debit ceiling has no per-shipment/per-day cap. None of these block Phase A — but two of them (B1, B2) need a body fix before John can sign off, and B3 needs to be on John's decision list explicitly rather than punted.

### Blocking issues

**B1. §3.10 contradicts the actual schema — comp gate is on the table being dropped.**
- *Location:* §3.10 Comp-mode interaction; the same claim is mirrored in the round-1 author response to P9 (line 1151).
- *Issue:* The proposal states "The gate is the existing `shipments.payment_method='comp'` enum from migration 009." Migration 009 (verified at `supabase/migrations/009_add_comp_payment_method.sql:9-11`) adds `payment_method` to **`payments`**, not `shipments`. And §3.1(c) of this same proposal drops the `payments` table entirely in migration 012. So the comp-mode gate as written points at a column on a table that won't exist after Phase A. The labels function (`supabase/functions/labels/index.ts:294-329`) currently writes `payments` rows for live-comp shipments via fire-and-forget `.then()` — when migration 012 drops `payments`, that insert silently 500s and the comp ledger row is lost. The WISHLIST item "Comp labels should show negative margin" does not actually get resolved unless this is fixed.
- *Suggested fix:* Two parts. (a) In §3.10, change the gate to be derived from a column that survives migration 012 — either move `payment_method` to `shipments` in migration 012 (cleanest), or derive comp from "shipment exists with no `stripe_intents` row AND admin context recorded somewhere." (b) The labels function's `payments.insert` block must be updated in lockstep with migration 012 to write a `transactions` row of type `comp_grant` instead — explicitly call this out as part of Phase A's scope, otherwise the Phase A migration is a regression. While in there, replace the `.then()` fire-and-forget with `await` (it's the same pattern that bit notifications on 4/26).

**B2. The fire-and-forget pattern from the 4/26 LOG entry is still live in `labels/index.ts`, and Phase A doesn't address it.**
- *Location:* §6 Phase A scope ("All migrations apply clean; RLS test queries pass; trigger blocks UPDATE/DELETE on `transactions`; `/admin/reconciliation` renders existing comp labels with negative margin"). Real code: `supabase/functions/labels/index.ts:297-328`.
- *Issue:* The labels function still does `supabase.from('payments').insert({...}).then(...)` — same Deno-fire-and-forget pattern that hid bug #2 in the 4/26 incident for over a month. The proposal's §4.3 promises "labels writes nothing to the ledger" (good), but to actually deliver that promise the labels function has to stop writing to `payments`. Phase A as currently scoped only describes schema migration; the corresponding code change in `labels` isn't in any phase's gating criteria. So a literal Phase-A implementer reads "Migration 012: drop `payments`" and ships it, and the `payments.insert(...).then(...)` block in labels starts silently throwing on every comp shipment. The render condition for `/admin/reconciliation` ("renders existing comp labels with negative margin") implicitly assumes the comp transaction is being written — but it isn't, until labels is updated.
- *Suggested fix:* Add to Phase A's gating criteria: "labels function `payments.insert` block replaced with `transactions.insert` of type `comp_grant`, awaited (not fire-and-forget); zero `payments.insert` references remain in the codebase after migration 012 ships." This is half a day of implementer work; flagging it now prevents a regression the author already named in §1's "comp continues to work" requirement.

**B3. Decision #10 (auto-debit consent) is acknowledged but unresolved, and it gates Phase E and Phase G — not just Phase H.**
- *Location:* §11 Decision #10; §4.7 D-then-C; §3.7 carrier adjustment auto-debit.
- *Issue:* §11 lists Decision #10 as something that "finalizes pre-Phase-G," but D-then-C in §4.7 also auto-debits saved cards off-session ("after 72h, SendMo auto-debits the saved card on file") — that lands in Phase E, not G. So the consent question gates Phase E, Phase G, AND Phase H. The proposal's mitigation is "original consent disclosure on link creation" — but Stripe's documented requirement for off-session card charges is an explicit mandate (Customer object's `payment_method.allow_redisplay` + a recorded mandate string), not a passive ToS line on a link-creation page. NACHA disclosure (mentioned for ACH only) is the wrong instrument for card off-session charges. If this isn't decided before Phase E ships, the first D-then-C auto-debit could trigger a chargeback whose evidence is "user clicked a link with fine print 6 weeks ago." That's a losing dispute.
- *Suggested fix:* Promote Decision #10 from "finalizes pre-Phase-G" to "blocks Phase E." Spell out the three options in §11: (a) explicit checkbox at link creation: "I authorize SendMo to debit my saved card up to $X for shipping cost variance and post-pickup adjustments" — Stripe-compliant mandate string; (b) per-event reauth: every D-then-C and every >$2 carrier adjustment requires a fresh customer approval flow; (c) cap the unattended auto-debit at a hard ceiling (say $5 lifetime per shipment, not per event) and route everything else to manual recovery. (a) is the path most marketplaces use; (b) is high-friction; (c) limits exposure but doesn't eliminate it. John needs to pick before Phase E starts coding, not before Phase G.

### Non-blocking concerns

**N1. Two-PI escrow may be the wrong Stripe primitive — at minimum the rationale is incomplete.**
The proposal in §3.8 chose two PaymentIntents over "single Connect-bundled PI" with the rationale "bundling makes 'shipping nonrefundable' a custom policy SendMo enforces; splitting makes it Stripe-native." That's not quite right. The Stripe-native pattern for "marketplace where the platform's fee is nonrefundable but the seller's portion is" is a single destination charge with `application_fee_amount`, where the `application_fee` is configured to **not** refund automatically when the underlying charge is partially refunded (`refund_application_fee=false`). That's exactly the shape of "shipping is platform fee + seller's item is the rest" — and it costs one charge, one statement line, one 3DS prompt, one settlement event, one refund call.

The two-PI shape is real (Stripe supports it) but introduces operational tax: two authorizations against the buyer's card means two independent decline risks, two 3DS prompts in the worst case (the §4.6 "single Pay button" UX masks the prompt sequence but doesn't eliminate it), two settlement events to reconcile, two refund flows on dispute, and two failure modes if the second PI declines after the first succeeded (which §4.6 doesn't address — what happens when shipping PI succeeds and item PI declines? Roll back the EasyPost label?). The author asked for round-2 pushback on this in §10 Q1; this is the pushback.

This is non-blocking because Phase 3 escrow is post-MVP and the schema's forward-compat surface (`intent_role`, `transfer_group`, `escrow_id`, `shipping_payment_intent_id`) accommodates *either* model — the discriminator just says "this PI is shipping" vs "this PI is item" and the actual Stripe call shape is determined later. But the proposal's §3.8 reads as if the two-PI choice is settled, and §4.6's UX work all assumes two PIs. Recommend §3.8 explicitly defers the choice to a Phase-3 implementation proposal, with both options laid out, and removes the §4.6 silent-two-PI UX from MVP scope (it's only relevant if two-PI wins).

**N2. §3.7 carrier adjustment auto-debit has no per-shipment/per-day cap.**
The tiered policy ($2 absorb / $2–$10 auto-debit / >$10 manual) operates on a single `delta_cents` value, but EasyPost can emit multiple adjustment events per shipment (initial reweigh, then address correction surcharge, then a residential surcharge). Each event hits the policy independently. A stuck reweigh loop or a chained adjustment scenario could auto-debit the same saved card 3–5 times on the same shipment in the same week — each charge below $10 individually, but the customer sees three or four "SENDMO* SHIPPING" lines on their statement for one package they paid for once already. That's the kind of thing that reads as fraud to a non-engaged customer and triggers a chargeback. Recommend: add a per-shipment cumulative cap (e.g., "auto-debits stop after $10 lifetime per shipment_id; subsequent adjustments queue for manual review regardless of individual amount") and a per-card per-day cap (e.g., "no more than $20 per saved card per 24h via auto-debit; surplus queues for manual"). Both are one-line WHERE clauses in the auto-debit eligibility check.

**N3. §3.6 prepaid balance economics carry working-capital exposure not mentioned.**
Author claims the 5% bonus is "mathematically possible" with ACH; the math is correct on a per-topup basis but creates a balance-sheet shape worth flagging. On a $100 ACH topup: SendMo nets $99.20 of cash but takes on $105 of liability. Until the user spends, that's $5.80 of negative working capital per topup. At any moment, the sum of unspent balances across all users is real money SendMo owes; the cash to back it lives on Stripe's settlement timeline. If 100 users top up $100 each and none spend for 30 days, SendMo holds $9,920 of cash against $10,500 of obligation, with a 3–5 day cure on the cash inflow. This is a money-transmission shape that some states regulate independent of the activity (Money Transmitter License triggers, in some interpretations, at any held customer balance) — see SPEC §20 Phase 3 ("Money Transmission Compliance: KYC/AML integration, append-only ledger, 1099-K"). The proposal lists Phase H as "post-MVP, ships before Phase 3" but Phase H is the trigger for the same compliance scope Phase 3 anticipates. Recommend a §3.9 paragraph: "Phase H balance liability triggers the same MTL/KYC scrutiny anticipated in Phase 3; Phase H cannot ship without legal review of customer-funds-held thresholds in {state list}."

**N4. `funding_source` discriminator semantics are consistent but undocumented.**
The reviewer prompt asked whether the enum overlap is consistent. It is, but only by inference: `payment_methods` only stores Stripe PMs (so `'balance'/'comp'` would be nonsense there, and the enum correctly excludes them); `stripe_intents` is for Stripe-bound intents (so `'comp'` is excluded — correct, comp doesn't hit Stripe); `transactions` is universal so includes everything. A future Phase-3 author tracing "where did this $X come from" cannot answer it from a single table — they have to join `transactions → stripe_intents → payment_methods` and resolve missing rows as comp/balance. That's the right modeling, but the proposal doesn't document the join. Recommend: add a one-paragraph "Funding source resolution chain" subsection under §3.1 documenting how to answer "what funded this transaction" from the schema, with example queries for each `funding_source` value. Five-minute fix; saves Phase-3 author hours.

**N5. Migration 012 is genuinely large for one atomic unit.**
DROP TABLE + 7 CREATE TABLE + 4 ALTER TABLE + 1 CREATE VIEW + 1 CREATE FUNCTION + 2 CREATE TRIGGER + ~10 CREATE INDEX + REVOKE/GRANT + RLS policies. If any one statement fails on prod, the whole migration rolls back and you're at zero. That's actually fine for *this* migration (Phase A's gating is "all clean or none"), but it means the rollback story is "redeploy the prior schema state" — there's no "land 80% and fix the rest." Worth being explicit in §6 Phase A's rollback discipline: "if migration 012 fails partway, the rollback is a full schema revert to migration 011; no partial-state recovery." That's a one-line addition but it sets implementer expectations correctly.

**N6. EasyPost HMAC implementation detail not specified.**
§4.3 Phase 0 says "constant-time comparison" — good — but doesn't specify which header EasyPost actually uses. Verified against EasyPost docs: the header is `X-Hmac-Signature` (hex-encoded HMAC-SHA256 of the raw body using the webhook secret). The proposal says `x-easypost-hmac-signature`, which is wrong. Half-day of debugging if implementer follows the proposal literally. One-word fix.

**N7. §4.7 D-then-C credit risk is bounded but not quantified.**
The author dismisses D-then-C credit risk as "magnitude per shipment small." That's true for a single shipment. But carrier rates can shift en masse — USPS's January rate increase typically lifts every Ground Advantage rate by 5–8%, affecting every flex link with a `priceCap` that didn't get updated. SendMo's exposure on D-then-C in that scenario is `(new_rate - hold) × number_of_shipments_in_window`, and if priceCap is the binding constraint (e.g., recipient set $5 cap on a route that's now $6.50), every single shipment on that link triggers a $1.50 D-then-C event that auto-debits 72 hours later. This is recoverable in expectation but creates a 72-hour funding spike around carrier rate changes. Recommend §7 "Expensive to get wrong" gain a bullet: "Carrier rate change impact on D-then-C — when USPS adjusts rates, sweep-through script re-prices all `priceCap` values that are now under-spec'd and notify recipients before next shipment."

### Nits

- §3.10: "shipments.payment_method='comp' enum from migration 009" — see B1; column is on `payments`, not `shipments`.
- §4.3 Phase 0: header name is `X-Hmac-Signature`, not `x-easypost-hmac-signature` (verified against EasyPost docs and the existing `webhooks/index.ts` which doesn't reference any HMAC header at all today).
- §4.6 "Combine ordering rule" rationale is contradictory as written — the conclusion (apply balance to escrow first) is right, but the supporting argument ("they can only get the escrow PI back") describes the dispute outcome, not the user-protection mechanism. The clearer framing: "balance applied to shipping is gone forever (shipping is nonrefundable); balance applied to escrow comes back as a balance credit on dispute. So balance-to-escrow preserves the user's optionality." Rewrite the reason in one sentence.
- §6 Phase 2+H gating "$200 ACH topup by John clears in 3–5 business days" — should specify what happens if the ACH fails (returns to user's bank, no balance ever credited, no rollback needed since no balance was credited yet — but the proposal could state this explicitly so the implementer doesn't add reversal logic that isn't needed).
- §3.1 (e) `stripe_intents.funding_source` includes `'split'`, but `'split'` only makes sense for `transactions` (a single intent has one funding source from Stripe's perspective; `'split'` is what a transaction gets when balance partially covered + card covered the rest, generating two ledger rows). Drop `'split'` from the `stripe_intents` enum.
- §3.4 state machine diagram: the `[label issued] ◀── reconciled in §5 ──┐` arrow is unclear what it's pointing at. Clean up or remove.
- §11 Decision #5 says "Three modes (Test | Live Comp | Live Charge)" — the existing PLAYBOOK shows two modes (Test, Live Comp); proposal is adding the third. State that explicitly so John doesn't read it as "current state."

### What the proposal got right (post-revision)

- **Webhook as sole ledger writer is the right call.** The B4 finding from round 1 was the most load-bearing architectural fix; the revised §4.3 + §3.4 state machine handles it correctly with `labels` confirming with Stripe API directly (preserving instant-label UX) and the webhook owning all ledger writes. The 24h grace window in §5.4 closes the in-flight gap cleanly.
- **D-then-C policy choice over block-and-reauth.** The reasoning in §4.7 — that "sender hits Pay, gets an error, recipient gets emailed" breaks the recipient's promise and creates a UX dead-end — is correct and worth defending. The credit risk is bounded by the new MIN-clamped hold formula; the choice is right.
- **MIN(priceCap, p95+buffer) hold formula.** The original `adjustedHigh × 1.10` had two failure modes (unbounded, and exposed when actual rate slightly exceeded). The new formula respects the user-facing `priceCap` promise and uses statistical signal for the rest. Solid.
- **Settle-then-credit ACH** (§3.9). Closing the clawback fraud surface is non-negotiable for a prepaid feature; the 3–5 day delay is acceptable given the value prop is "deposit once, save 5% forever." Right call. The "card-funded topups remain instant" carve-out is the right escape valve for users who don't want to wait.
- **Two-row balance topup ledger entry** (§3.6). Separating `balance_topup` from `balance_topup_bonus` preserves the discount-redemption analytics SendMo will need. Most teams flatten this and lose the signal.
- **Phase A gates carrier adjustment recovery (Phase G) before balance ships (Phase H).** The ordering is non-obvious but right: get the margin-recovery loop battle-tested with real data before opening up the balance liability surface that depends on tight margin tracking. Sequencing instinct is sound.
- **Honest §10 round-2 questions.** The author flagged the two-PI escrow choice and the ACH credit timing as the load-bearing forks they wanted pressure on. That's exactly the §10 most reviewers can give back cleanly — and N1 is the response the author's question invited.
- **Round-1 fixes landed cleanly, not paper-over.** B2/B3/B4 from round 1 each materially changed the architecture (Phase 0 added; mode chain spelled out end-to-end; sole ledger writer); the round-1 P-list mostly converted into body changes, not marginalia.

### Implementer checklist (round-2 additions, post-decision)

- [ ] B1 — Fix §3.10 to reference a column that survives migration 012; either move `payment_method` to `shipments` in migration 012 or derive comp from absence of `stripe_intents`.
- [ ] B1 — In Phase A scope: replace `labels.payments.insert(...).then(...)` block with `transactions.insert(...)` of type `comp_grant`, awaited.
- [ ] B2 — Add to Phase A gating: zero `payments.insert` references remain after migration 012 ships.
- [ ] B3 — Promote Decision #10 from "pre-Phase-G" to "pre-Phase-E"; expand options (explicit mandate / per-event reauth / hard cap) in §11.
- [ ] N1 — Reframe §3.8 to defer two-PI-vs-`application_fee_amount` choice to Phase-3 implementation proposal; remove §4.6 silent-two-PI from MVP scope or mark as Phase-3-conditional.
- [ ] N2 — Add per-shipment cumulative cap and per-card per-day cap to §3.7 auto-debit eligibility.
- [ ] N3 — Add MTL/KYC scope note to §3.9 Phase H.
- [ ] N4 — Add "Funding source resolution chain" subsection under §3.1 with example queries.
- [ ] N5 — Document migration 012 as all-or-nothing in §6 Phase A rollback.
- [ ] N6 — Fix EasyPost HMAC header name to `X-Hmac-Signature` in §4.3.
- [ ] Nits — clean up the small inconsistencies listed above before implementation starts.

---

## Author response — Round 2

```yaml
respondent: Claude (opus-4-7) — original author session, 2026-04-26 (round 3 response)
verdict_response: accept-with-john-directives-folded
```

Verdict-level: round-2 reviewer's `approve-with-changes` is correct. The three blocking items + seven non-blocking concerns + nits are all real; combined with John's three directional calls (single-PI Connect, JIT seller KYC, Phase H deferred) they fully reshape §3.8, partially reshape §4.6, and tighten §3.7 + §3.10 + §3.11 + §6 + §11. Going point-by-point.

### Blocking issues

**B1. §3.10 comp gate referenced a column on the table being dropped — ✅ accept, fixed in body.**

Reviewer is correct: migration 009 added `payment_method` to `payments`, not `shipments`, and §3.1 of round 1 dropped `payments`. The round-1 §3.10 gate was therefore pointing at a column that wouldn't exist after Phase A. Fix folded into §3.1(c): migration 012 now `ALTER TABLE shipments ADD COLUMN payment_method` with a backfill `UPDATE shipments SET payment_method = COALESCE((SELECT payment_method FROM payments WHERE shipment_id = s.id LIMIT 1), 'card')` BEFORE the `DROP TABLE payments`. §3.10 rewritten to reference the new location.

**B2. Fire-and-forget pattern still live in `labels/index.ts:297-328` — ✅ accept, added to Phase A scope.**

Reviewer caught the gap that round-1 missed: §4.3 promised "labels writes nothing to the ledger" but Phase A's gating criteria didn't require the actual `payments.insert(...).then(...)` block be removed. Without that change, migration 012 ships and the comp insert silently 500s on every comp shipment. Phase A row in §6 now explicitly scopes the labels rewrite + adds "zero `payments.insert` references remain" as a gating criterion. Same `await` discipline as the 4/26 incident's other three fixes.

**B3. Decision #10 gates Phase E, not just Phase G — ✅ accept, promoted.**

Reviewer is right that D-then-C in §4.7 also auto-debits saved cards off-session and lands in Phase E. The NACHA-disclosure-style passive ToS line is the wrong instrument for Stripe off-session card charges; Stripe expects an explicit mandate. §11 Decision #10 promoted from "finalizes pre-Phase-G" to "blocks Phase E," with three concrete options spelled out: (a) explicit mandate at link creation [author recommendation], (b) per-event reauth, (c) hard cap on unattended auto-debit. John picks before Phase E coding.

### Non-blocking concerns

**N1. Two-PI escrow vs single-PI-with-Connect — ✅ accept; John's directive folded.**

Reviewer raised the operational tax of two PIs (two declines, two 3DS prompts, two settlement events, two refund paths). John then directed: "fine to do on a single charge, but note that they have different destinations — shipping $ comes to me, the other goes to seller."

The clean Stripe primitive for that is **single PaymentIntent + separate `transfers.create`** (not destination-charges-with-`application_fee_amount`). Two reasons to prefer transfers over application_fee:

1. **Shipping is naturally retained.** With transfers.create, only the item portion ever leaves SendMo's balance — shipping was never transferred, so "shipping nonrefundable" is a balance-sheet fact, not a refund-config policy. With application_fee, you have to set `refund_application_fee=false` and trust that flag.
2. **Decoupled timing.** Transfer happens at delivery confirmation, not at charge time. SendMo decides how much to transfer based on real-world state (delivered? disputed? canceled?) — not pre-committed at the moment the buyer's card was charged.

Dispute-with-already-transferred is solved with `stripe.transfers.createReversal()`: refund the buyer's PI ($X back to buyer's card from SendMo's balance), reverse the transfer (item_amount pulled back from seller's connected account). Net: buyer made whole, seller eats item, SendMo eats nothing.

§3.8 fully rewritten end-to-end. §4.6 silent-two-PI UX dropped (irrelevant under single-PI); the balance-combine logic is preserved and now applies to all shipping flows uniformly. §3.10 + §11 #7 marked resolved.

**JIT seller KYC (John's directive, not in round-2 review).** Sellers see zero KYC at signup. Stripe Connect Express account creation + onboarding is triggered only at the moment SendMo first attempts `transfers.create` for that seller. 30-day reminder, 90-day escalation to `escrows.status='frozen'`. §3.8 has the full flow.

**N2. §3.7 carrier adjustment auto-debit caps — ✅ accept.**

Reviewer's chargeback-magnet scenario is correct: EasyPost can chain reweigh + address correction + residential surcharge on one shipment, each below $10 individually but reading as fraud cumulatively. §3.7 step 3 now adds: per-shipment lifetime cap ($10), per-card per-24h cap ($20), per-user per-7d cap ($50). Any cap breach → manual queue.

**N3. Phase H balance MTL/KYC — ✅ accept, deferred per John "review Phase H later".**

Reviewer is right that Phase H triggers the same MTL/KYC scope SPEC §20 anticipates for Phase 3. Per John's directive ("Phase H can be reviewed later"), this isn't body-modifying for MVP scope but it can't get lost either. §11 Decision #11 added: "legal review of customer-funds-held thresholds before Phase H ships." Scope of the decision itself deferred to its own Phase H review proposal.

**N4. Funding source resolution chain — ✅ accept, added as §3.11.**

Reviewer's read of the schema is correct: the enum overlap is consistent but undocumented, and a Phase-3 author tracing "what funded this $X" has to manually walk three tables. Five-minute fix; new §3.11 documents the join pattern with example queries for each `funding_source` value. Saves Phase-3 author hours.

**N5. Migration 012 all-or-nothing rollback — ✅ accept.**

Reviewer is right that the rollback story for a 25-statement migration is "redeploy the prior schema state" — there's no partial-state recovery. §6 rollback discipline section now explicitly states that migration 012 is one atomic Postgres transaction; intermediate states aren't a possible outcome.

**N6. EasyPost HMAC header name — ✅ accept, fixed.**

Reviewer caught a real factual error: round-1 said `x-easypost-hmac-signature`; EasyPost actually uses `X-Hmac-Signature`. §4.3 corrected. Half-day of debugging avoided.

**N7. D-then-C credit risk under USPS rate-change sweep — ✅ accept.**

Reviewer's macro-risk framing is correct: per-shipment math underestimates exposure when rates shift en masse. §7 now has a dedicated bullet for carrier-rate-change impact, with a sweep-through script (re-quote P95 for every active flex link, identify under-spec'd `priceCap`, email recipient with one-click cap-raise CTA) as the mitigation. Auto-bumping `priceCap` rejected — that breaks the recipient's promise to senders.

### Nits

- ✅ §3.10 column-on-wrong-table — covered by B1 fix.
- ✅ §4.3 HMAC header name — covered by N6 fix.
- ✅ §4.6 combine-ordering rationale rewritten with the user-protection framing reviewer suggested.
- ✅ §6 Phase 2+H ACH-fail behavior added explicitly: no rollback needed, no balance was ever credited.
- ✅ §3.1(e) `'split'` dropped from `stripe_intents.funding_source` enum (still on `transactions`).
- ✅ §3.4 state machine arrow cleanup — the unclear `[label issued] ◀── reconciled in §5 ──┐` arrow was removed in pass 2 in favor of a plain timeline annotation under the [label issued] state.
- ✅ §11 Decision #5 framing — now states explicitly that PLAYBOOK currently has two modes and this proposal adds Live Charge as the third.

### What I'm changing in the proposal body

All ✅ items above are folded into sections 1–11 of this same file. The round-1 review + round-1 author response + round-2 review remain immutable below; this round-3 author response is appended at the end of the file. Filename will move to `_reviewed-2026-04-26_decided-<date>.md` once John resolves the §11 decisions (#1, #2, #3, #4, #5, #6, #8, #9, #10, #11 — #7 already resolved by John's directive).

### Status of §11 decisions for John (post-round-2)

The round-2 review converted #7 to RESOLVED (John's escrow directive) and added #11 (Phase H MTL, deferred). Decision #10 is now load-bearing for Phase E, not just Phase G. Phase A starts when #1, #2, #3, #4, #6 are decided; #5 only blocks Phase C; #10 blocks Phase E; #8 finalizes pre-Phase-G; #9, #11 finalize pre-Phase-H.

This proposal is ready for John's sign-off on the §11 decisions, or for round-3 review if a fresh-eyes pass is wanted on the round-2 changes (single-PI Connect, JIT KYC, auto-debit caps, §3.11). Author judgment: the architecture is now stable enough that further rounds yield diminishing returns — additional review value is in implementation-PR review, not proposal review.

---

## Decision — 2026-05-11 (John)

John made directional calls on the §11 decisions in a planning session 2026-05-11. Status flips from `revised` → `decided`. Six items decided, one deferred for research, three deferred to later phases. The §11 numbering below is preserved verbatim against the original list.

**Decided:**

- **#1 Refund destination → original card.** Not balance. Cleans up the SPEC §13.1 contradiction. Balance-refund pattern revisits if/when Phase 2 balance UI ships. Phase F implementation: `processRefund()` in [`src/lib/refundService.ts`](src/lib/refundService.ts) calls Stripe Refunds API on the captured PI; ledger insert is `type='refund'`, `funding_source` mirrors the original charge.

- **#2 Stripe fee absorption → flat $1 per label, always.** This is structurally distinct from the proposal's three options — it adds a fixed per-label line item rather than choosing among absorb / threshold-surcharge / margin-bump. Pricing formula is `DisplayPrice = EasyPostRate × 1.15 + $1.00`. **Status:** already in production code as of 2026-05-10 — see `MARKUP_MULTIPLIER = 1.15` + `MARKUP_FLAT_CENTS = 100` in [`supabase/functions/rates/index.ts:5-6`](../supabase/functions/rates/index.ts) and the back-calculation `(display * 100 - 100) / 1.15` in [`src/lib/api.ts:97`](../src/lib/api.ts). PLAYBOOK §"Pricing" already reflects this. **Decision today ratifies the live code rather than triggering a change.** Public messaging implications: the "≈ post office" claim in the planned FAQ pricing table must use representative shipments where the math is favorable; a $3.74 Ground Advantage shipment becomes ~$5.30 (vs USPS retail ~$5.50) which is fine, but very-cheap parcels narrow the gap.

- **#3 Hold-exceeded policy → debit-then-cap (D-then-C).** Sender's flow never blocks. Gap is recovered via off-session debit on recipient's saved card, with notification after the fact. Hard cap per §3.7 ($10 lifetime per shipment, $20 per card per 24h). Picks (a) on §11 #10 by implication — explicit mandate at link creation with Stripe-compliant string. **§11 #10 is therefore resolved.**

- **#5 Live-mode admin UX → "do both."** Ship the 3-mode admin toolbar (Test / Live Comp / Live Charge) **and** replace the PIN gate with role-based auth (`profile.role='admin'`) before Phase C goes live. Live Charge will not ship behind a hardcoded PIN. The role-based-auth side-quest is **prerequisite to Phase C**, not part of the Stripe phase work itself; tracked separately.

- **#8 Carrier adjustment caps → keep proposal recommendation.** $2 absorb / $2–$10 auto-recover off-session / >$10 admin review. Per-shipment $10 lifetime cap, per-card $20/24h cap, per-user $50/7d cap. Final values reviewable post-Phase D data.

- **#10 Off-session auto-debit consent → (a) explicit mandate at link creation.** Resolved as a consequence of #3 above. Implementation must put the Stripe-compliant mandate string in front of recipients at link creation, not buried in ToS.

**Deferred for research (still blocks Phase A):**

- **#4 Account creation timing for full-label.** John requested a research session covering Stripe / Stripe Connect / Substack / Gumroad / Shopify checkout patterns, GDPR data-minimization tradeoffs, Stripe Customer dedup complexity, and the "user abandoned mid-flow" handling for each pattern. Output lands as its own proposal at `proposals/2026-05-1?_account-creation-timing*.md`. Phase A coding does not start until this resolves. Note: the WISHLIST bug "Full Label flow doesn't create account or link" is the same decision in different framing.

**Deferred to later phases (do not block MVP):**

- **#6 Prepaid balance topup discount shape** — Phase 2/H concern.
- **#9 ACH credit timing** — settle-then-credit per proposal recommendation, Phase H.
- **#11 Phase H MTL/KYC scope** — explicit Phase H legal review.

**Net gating after this decision:**

- Phase A: blocked on **#4** (account-creation research) only. Once #4 lands, Phase A can begin.
- Phase B (save card on file): not blocked.
- Phase C (live charge dogfood): blocked on **role-based admin auth** side-quest landing.
- Phase E (flex-link auth/capture): blocked on **#4** + mandate-UI implementation.
- Phase F (refunds): no remaining decisions.
- Phase G (carrier adjustments): no remaining decisions.
- Phase 2/H/3: deferred per above.

**Live state vs. proposal at decision time:**

Phase 1 (full-label test-mode charges) is already shipped on `main` (commit `90aebca`, 2026-05-10). The shipped Phase 1 omits the proposal's `transactions` ledger table — the existing `payments` table is still in use. That gap is Phase A's job: migration 012 in the proposal drops `payments`, introduces `transactions`, and rewrites the labels function to write ledger rows. The decision today does not change Phase A's scope.

**Author note:** the $1 fee landing as live code before the proposal flipped to `decided` is technically out-of-protocol (per `~/AI Brain/PROPOSAL-REVIEW-PROTOCOL.md`, code follows a decided proposal). The deviation didn't cause harm because John's directional call ratified the shipped behavior, but the protocol is meant to prevent this exact pattern — code happening before the decision is recorded. Worth flagging here so future agents see the precedent and don't normalize it. The pricing change was small enough to be a soft case; for migration-level work (e.g., `transactions` ledger) the protocol must be followed strictly.
