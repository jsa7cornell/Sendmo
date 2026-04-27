---
title: Stripe Integration & Financial Systems Wiring
slug: stripe-integration-plan
project: sendmo
status: revised
created: 2026-04-26
reviewed: 2026-04-26
decided: null
author: Claude (opus-4-7) — fresh planning session, 2026-04-26
reviewer: Claude (opus-4-7) — fresh-eyes reviewer, 2026-04-26
outcome: approve-with-changes
---

## 1. Context

SendMo is collecting zero dollars today. The full-label flow ([RecipientStepPayment.tsx](src/components/recipient/RecipientStepPayment.tsx)) renders a `MockPaymentForm` that sleeps 1.5s, then calls `labels` with no Stripe involvement. The flex-link flow ([RecipientStepFlexPayment.tsx](src/components/recipient/RecipientStepFlexPayment.tsx)) is similarly stubbed. EasyPost is generating real labels (test + live), Resend is sending real email, but every cent of revenue is currently fictional. There's a `payments` table from migration 001 and a `payments/` Edge Function directory that's empty.

This proposal designs the full path from "card on file" to "money in the bank to "reconciled to the penny against Stripe and EasyPost." It is deliberately broader than just "charge a card": SendMo's value depends on margin tracking that survives refunds, comps, drift, and webhook retries. Without that, revenue is a guess.

The proposal does **not** write code. It is the planning artifact that will guide the eventual implementation PRs.

### Non-negotiable constraints (from PLAYBOOK + CLAUDE.md)

- **Rule 16:** Financial balance changes must use an immutable append-only `transactions` ledger. The current `payments` table allows `UPDATE` and is the wrong shape — it represents Stripe entities, not money movement.
- **Rule 14:** Critical decisions (live/test mode, refund eligibility, pricing) must derive from server-side state — never trust client-provided params.
- **Rule 15:** Schema must be expandable for future "escrow" states (Phase 3).
- **Rule 6:** Only Stripe Elements; never handle raw card numbers.
- **Rule 8:** Always verify webhook signatures.

### Existing surface area to preserve

- Comp-label flow (`/admin` "Live Comp" mode): real EasyPost label, no payment. Must continue to work, must show as **negative margin** in reports (open WISHLIST item).
- Admin report at `/admin` with margin tracking.
- EasyPost webhook handler at `supabase/functions/webhooks` (EasyPost-only today).
- Refund eligibility logic in `cancel-label` (already gates on `shipment.status` and `refund_status`).

---

## 2. Architecture overview

```
                       ┌────────────────────────────────────────────┐
                       │  RECIPIENT (signed in or auto-created)     │
                       │  • Has 1 stripe_customer_id (live + test)  │
                       │  • Has ≥0 saved payment_methods            │
                       └──────────────┬─────────────────────────────┘
                                      │
        ┌─────────────────────────────┼──────────────────────────────┐
        │                             │                              │
   FULL-LABEL                    FLEX-LINK                      WALLET TOPUP (post-MVP)
   (Step 11)                     (Step 22)                      (Phase 2)
        │                             │                              │
        │ PaymentIntent               │ PaymentIntent                │ PaymentIntent
        │ capture=automatic           │ capture=manual               │ capture=automatic
        │ amount = display_price      │ amount = high×1.10 + ins.    │ amount = topup
        │ confirm + save_for_future   │ confirm + save_for_future    │ destination=balance
        ▼                             ▼                              ▼
   stripe_intents row            stripe_intents row              stripe_intents row
        │                             │                              │
        ▼                             ▼                              ▼
   transactions:                 holds: status=authorized        transactions:
   +charge, -fee                 (no money movement yet)         +balance_topup, -fee
        │                             │
        │                             │  ── sender uses link, label bought ──
        │                             ▼
        │                       PaymentIntent.capture(actual_amount)
        │                       holds: status=captured
        │                       transactions: +charge, -fee, (excess auto-released)
        ▼                             ▼
   labels fn → EasyPost          labels fn → EasyPost
   shipments row                 shipments row
        │                             │
        └──────────────┬──────────────┘
                       ▼
              shipments → ledger join → /admin/reconciliation
                       │
                       │  daily cron compares to Stripe balance_transactions
                       ▼
              drift events → support@sendmo.co alert
```

Two Edge Function additions, no Edge Function deletions:

| Function | Purpose | Replaces |
|---|---|---|
| `payments/` (currently empty) | Create SetupIntents + PaymentIntents, capture, void | Mock payment form |
| `stripe-webhooks/` (new) | Stripe-signed webhook handler | n/a |
| `reconcile-stripe/` (new, cron-driven) | Daily Stripe ↔ ledger drift check | n/a |

**Why split `stripe-webhooks` from the existing `webhooks/` function?** EasyPost and Stripe use different signature schemes, different secrets, different idempotency conventions, and entirely different event taxonomies. Mixing them in one handler creates conditional sprawl and increases the chance that a Stripe-only deploy breaks EasyPost handling. Separate functions = separate blast radius.

---

## 3. Data model

### 3.1 New tables (migration 012)

```sql
-- 1. Stripe Customer pointer (test + live separation)
ALTER TABLE profiles
  ADD COLUMN stripe_customer_id_test TEXT,
  ADD COLUMN stripe_customer_id_live TEXT;
-- Why on profiles vs. separate table: 1:1 with user, no historical
-- versioning needed, simpler RLS (already user-scoped).

-- 2. Saved payment methods (one row per saved card)
CREATE TABLE payment_methods (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  stripe_payment_method_id TEXT NOT NULL,
  mode                     TEXT NOT NULL CHECK (mode IN ('test','live')),
  brand                    TEXT,                    -- 'visa','mastercard',...
  last4                    TEXT,
  exp_month                INTEGER,
  exp_year                 INTEGER,
  is_default               BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ,             -- soft delete for audit
  UNIQUE (user_id, stripe_payment_method_id)
);
-- One default per user per mode (enforced via partial unique index)
CREATE UNIQUE INDEX uniq_default_pm_per_user_mode
  ON payment_methods (user_id, mode) WHERE is_default = TRUE AND deleted_at IS NULL;

-- 3. Stripe intent state mirror (NOT the ledger — see transactions)
CREATE TABLE stripe_intents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES profiles(id),
  link_id             UUID REFERENCES sendmo_links(id),
  shipment_id         UUID REFERENCES shipments(id),
  stripe_intent_id    TEXT NOT NULL UNIQUE,        -- pi_... or seti_...
  intent_kind         TEXT NOT NULL CHECK (intent_kind IN ('payment','setup')),
  capture_method      TEXT CHECK (capture_method IN ('automatic','manual')),
  amount_cents        INTEGER,                     -- requested/auth amount
  captured_cents      INTEGER,                     -- actual captured (manual)
  status              TEXT NOT NULL,               -- mirrors Stripe status
  mode                TEXT NOT NULL CHECK (mode IN ('test','live')),
  idempotency_key     TEXT NOT NULL UNIQUE,        -- our key, not Stripe's
  last_event_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Holds (flex-link authorizations)
CREATE TABLE holds (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id             UUID NOT NULL REFERENCES sendmo_links(id),
  stripe_intent_id    TEXT NOT NULL UNIQUE,
  amount_cents        INTEGER NOT NULL,
  status              TEXT NOT NULL CHECK (status IN
                        ('authorized','captured','partially_captured','voided','expired','failed')),
  authorized_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  captured_at         TIMESTAMPTZ,
  voided_at           TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ NOT NULL,        -- Stripe auto-voids at 7d for cards
  mode                TEXT NOT NULL CHECK (mode IN ('test','live'))
);

-- 5. Refunds
CREATE TABLE refunds (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id              UUID NOT NULL REFERENCES shipments(id),
  stripe_refund_id         TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id TEXT NOT NULL,
  amount_cents             INTEGER NOT NULL,       -- positive
  reason                   TEXT,                   -- 'label_voided','duplicate','fraud',...
  status                   TEXT NOT NULL,          -- mirrors Stripe
  easypost_void_id         TEXT,                   -- ties to shipments.carrier_refund_id
  mode                     TEXT NOT NULL CHECK (mode IN ('test','live')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. THE LEDGER — append-only, never UPDATE, never DELETE
CREATE TABLE transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES profiles(id),
  shipment_id     UUID REFERENCES shipments(id),
  link_id         UUID REFERENCES sendmo_links(id),
  stripe_intent_id TEXT,                            -- pi_... if applicable
  stripe_charge_id TEXT,                            -- ch_... if applicable
  type            TEXT NOT NULL CHECK (type IN (
                    'charge',           -- customer paid
                    'fee_stripe',       -- Stripe processing fee deducted
                    'refund',           -- money back to customer
                    'refund_fee_recovered', -- Stripe returns app fee on refund (usually $0)
                    'comp_grant',       -- comp label, no payment (negative margin)
                    'balance_topup',    -- post-MVP: prepay wallet
                    'balance_redeem',   -- post-MVP: spend from wallet
                    'chargeback',       -- dispute lost
                    'adjustment'        -- manual correction by admin (rare)
                  )),
  amount_cents    INTEGER NOT NULL,                -- signed: + = SendMo gains, − = SendMo loses
  description     TEXT,
  mode            TEXT NOT NULL CHECK (mode IN ('test','live')),
  idempotency_key TEXT NOT NULL UNIQUE,             -- prevents double-write on retry
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Critical: enforce append-only via revoke + trigger
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
CREATE INDEX idx_pm_user_mode       ON payment_methods (user_id, mode) WHERE deleted_at IS NULL;
CREATE INDEX idx_holds_status       ON holds (status, expires_at);
CREATE INDEX idx_refunds_shipment   ON refunds (shipment_id);
```

### 3.2 RLS policies

- `payment_methods`: user can SELECT their own (where `deleted_at IS NULL`). INSERT/UPDATE only by service_role (writes happen in webhooks).
- `stripe_intents`, `holds`, `refunds`: SELECT by user where `user_id = auth.uid()` (or join through link/shipment). INSERT/UPDATE service_role only.
- `transactions`: SELECT by user for their own rows. INSERT service_role only. UPDATE/DELETE blocked at the role level + trigger level.
- Admin role (when role-based check ships) gets unrestricted SELECT for `/admin/reconciliation`.

### 3.3 Customer balance — derived view, not a table

```sql
CREATE VIEW user_wallet_balance AS
SELECT
  user_id,
  mode,
  SUM(CASE WHEN type IN ('balance_topup') THEN amount_cents
           WHEN type IN ('balance_redeem') THEN -amount_cents
           ELSE 0 END) AS balance_cents
FROM transactions
GROUP BY user_id, mode;
```

A view (not materialized) keeps Rule 16 honest — there's no balance to "update" — and stays cheap for MVP volumes (<10K rows). Materialize when transactions exceeds ~1M rows.

### 3.4 Disposition of the existing `payments` table

`payments` from migration 001 is the wrong shape (mutable, no idempotency, no fee tracking). Two options:

**Option A (recommended):** Stop writing to `payments` after migration 012 ships. Backfill historical rows into `transactions` (just comp labels exist today). Keep `payments` for one release cycle as a read-only mirror, then drop in migration 014.

**Option B:** Drop immediately. Acceptable because production has no real payment data — only test rows.

I recommend A; it preserves a paper trail during the cutover. Need John's call.

### 3.5 Payment state machine

```
                    ┌──────────────────────────────────────────────┐
                    │ FULL-LABEL (capture_method = automatic)      │
                    └──────────────────────────────────────────────┘
   [NONE]
     │  client: createPaymentIntent(amount, link_id, idemp_key)
     ▼
   [created] ── stripe.confirm() ──▶ [requires_action] ──▶ 3DS ──▶ [processing]
                                          │
     ┌────────────────────────────────────┴────────────┐
     ▼                                                  ▼
   [succeeded]                                      [failed]
     │  webhook: payment_intent.succeeded                │
     │  → tx.charge(+gross)                              │  → no label
     │  → tx.fee_stripe(−fee)                            │  → user retries
     │  → labels fn (real or test)                       │
     │  → shipment row                                   │
     ▼
   [completed]

                    ┌──────────────────────────────────────────────┐
                    │ FLEX-LINK (capture_method = manual)          │
                    └──────────────────────────────────────────────┘
   [NONE] → [created] → [authorized] (hold row, money on customer card)
                              │
       ┌──────────────────────┼──────────────────────┐
       │                      │                      │
       ▼                      ▼                      ▼
   sender uses link    sender never uses    rate > hold
       │                authorize expires       │
   [partial_capture]   (Stripe auto-voids)   recapture? (decision)
   actual cost charged    │
   excess released        ▼
       │              [voided]
       ▼              hold row → status=expired
   [captured]         no transactions
   tx.charge(+actual)
   tx.fee_stripe(−fee)

                    ┌──────────────────────────────────────────────┐
                    │ REFUND (label voided)                        │
                    └──────────────────────────────────────────────┘
   [captured] → admin clicks Void → cancel-label fn
       │  → EasyPost void OK
       │  → stripe.refunds.create()
       ▼
   webhook: charge.refunded
   → refunds row
   → tx.refund(−amount)  (negative because money out)
   → tx.refund_fee_recovered(+0 typically; +0.30 if Stripe returns app fee)
   shipment.refund_status = 'refunded'
```

---

## 4. Stripe integration architecture

### 4.1 Saving cards — Setup Intent vs. PaymentIntent-with-future-usage

Stripe supports two patterns:

1. **SetupIntent first, PaymentIntent later** — explicit two-step: save card now, charge later.
2. **PaymentIntent with `setup_future_usage: 'off_session'`** — single API call saves card + charges/auths in one shot.

For SendMo's flow, **option 2 is correct** for both paths. There's no UX where the user wants to save a card without paying; the card is added during the flow, not in advance. SetupIntent is reserved for the **dashboard "Add card" UI** (post-MVP) where a returning user adds a backup card without a pending shipment.

### 4.2 Customer object lifecycle

Create `stripe_customer_id_<mode>` lazily on first PaymentIntent for that user in that mode. Don't pre-create on signup — many users will browse without ever hitting payment, and an unused Customer is dead weight in Stripe's UI.

The `payments` Edge Function flow:

```
1. POST /payments/create-intent { link_id, mode_implied_by_admin_state }
2. Server resolves user_id from JWT
3. If profiles.stripe_customer_id_<mode> is NULL:
     → stripe.customers.create({ email, metadata: { sendmo_user_id }})
     → UPDATE profiles SET stripe_customer_id_<mode> = ...
4. Compute amount from sendmo_links state (NOT from request body — Rule 14)
5. Generate idempotency key: `${link_id}:${flow_step}:${mode}`
6. stripe.paymentIntents.create({
     amount, customer, capture_method,
     setup_future_usage: 'off_session',
     metadata: { link_id, shipment_id, sendmo_user_id, mode }
   }, { idempotencyKey })
7. Insert stripe_intents row
8. Return { client_secret, intent_id } to frontend
9. Frontend: stripe.confirmCardPayment(client_secret)
10. Webhook payment_intent.succeeded → write transactions
```

**Critical:** the amount in step 4 is server-computed from `sendmo_links` state. The client never tells the server how much to charge.

### 4.3 Webhook handler design

New `stripe-webhooks/` Edge Function. Endpoint: `POST /functions/v1/stripe-webhooks`. Stripe dashboard registers this URL with both test and live modes producing different webhook secrets — both stored as Supabase secrets (`STRIPE_WEBHOOK_SECRET_TEST`, `STRIPE_WEBHOOK_SECRET_LIVE`).

```
1. Read raw body (NOT parsed — signature verifies the bytes)
2. Try stripe.webhooks.constructEvent(body, sig, SECRET_LIVE)
3. On signature error: try SECRET_TEST
4. On both fail: 400 with no further processing
5. Dedup: INSERT INTO webhook_events (id=event.id, source='stripe', ...) ON CONFLICT DO NOTHING
   - If 0 rows affected, this is a retry → return 200 immediately
6. Handle by event.type:
   - payment_intent.succeeded     → upsert intent, write tx.charge + tx.fee_stripe
   - payment_intent.payment_failed → upsert intent, mark hold failed if applicable
   - payment_intent.amount_capturable_updated → upsert intent (manual auth ready)
   - payment_intent.canceled      → mark hold voided
   - charge.succeeded             → expand balance_transaction for fee details
   - charge.refunded              → upsert refund row, write tx.refund (negative)
   - charge.dispute.created       → flag shipment, email John
   - setup_intent.succeeded       → insert payment_methods row
7. Mark webhook_events.processed = true on success
8. 200 OK
```

**Stripe fee extraction:** When `charge.succeeded` arrives, retrieve the charge with `expand: ['balance_transaction']` to get the actual fee. Don't compute it from a hardcoded 2.9% + $0.30 — Stripe occasionally adjusts (international cards, ACH, etc.) and we want the truth in the ledger.

### 4.4 Test mode vs live mode

Mirrors EasyPost's pattern (Rule 14):
- Two key sets in Supabase secrets: `STRIPE_SECRET_KEY_TEST`, `STRIPE_SECRET_KEY_LIVE`, plus webhook secrets.
- Edge functions resolve mode from server-side state: `sendmo_links.is_test` (added in migration 005 for shipments, propagate to links). The client never sets the mode flag for payment.
- Mode is recorded on every `transactions`, `stripe_intents`, `holds`, and `refunds` row — reconciliation queries always filter by mode so live revenue is never polluted by test data.

### 4.5 Idempotency

Three idempotency layers:

1. **Stripe API** — every `stripe.paymentIntents.create` call passes an idempotency key derived from `${link_id}:${flow_step}:${mode}`. Stripe returns the same intent on retry.
2. **Webhook events** — `webhook_events` table with UNIQUE constraint on `event_id`. Duplicate deliveries are a no-op.
3. **Transactions ledger** — every `transactions` row has a UNIQUE `idempotency_key`. The webhook handler computes a key like `pi_xxx:succeeded:charge` and `pi_xxx:succeeded:fee` so a redelivered webhook can't double-write the ledger.

---

## 5. Reconciliation + testing systems

This is the part that determines whether John can sleep at night, so it gets the most scrutiny.

### 5.1 Admin reconciliation report

New page at `/admin/reconciliation` (PIN-gated for now, role-based later). Three views:

**Daily summary table (default view):**

| Date | Shipments | EasyPost cost | Customer charges | Stripe fees | Refunds | Net margin | Comp loss | Drift |
|---|---|---|---|---|---|---|---|---|
| 2026-04-26 | 12 | $128.40 | $147.66 | $4.58 | $0.00 | $14.68 | -$8.20 | ✅ |
| 2026-04-25 | 8 | $94.10 | $108.21 | $2.95 | -$11.20 | -$0.04 | $0.00 | ⚠️ −$0.12 |

Drift column shows a green check if reconciliation cron found nothing, red warning + exact diff otherwise.

**Per-shipment drilldown:**

| Shipment | Created | Carrier/Service | Cost | Charge | Fee | Refund | Net | Mode | Drift |
|---|---|---|---|---|---|---|---|---|---|

Sortable by drift, profit margin %, etc.

**Comp labels view:**

Shows comp shipments separately with negative margin = -EasyPost cost. (Resolves WISHLIST item "Comp labels should show negative margin.")

Implementation:

- New Edge Function `reconciliation-report` (admin-gated, returns JSON)
- Joins `shipments` ↔ `transactions` ↔ `refunds` ↔ `holds`
- Groups by date and by shipment
- React page rendered from JSON; each row link-throughs to a Stripe-side and ledger-side detail panel

### 5.2 End-to-end test harness (manual)

New page at `/admin/test-harness` (PIN-gated). Single button: **"Run end-to-end smoke test."** This is John's pre-launch sanity check.

What it does (no real money):
1. Creates synthetic test user `testharness+<timestamp>@sendmo.co` (Supabase test user, deleted at end).
2. Creates a flex link via the real `/api/links` endpoint with `is_test=true`.
3. Calls `payments/create-intent` for the auth.
4. Confirms the intent server-side using the Stripe test card token (no UI involved).
5. Polls until webhook fires `amount_capturable_updated` and `holds.status='authorized'`.
6. Acts as sender: calls `/api/labels` with `live_mode=false` against EasyPost test mode. EasyPost returns a synthetic tracking number.
7. Captures the hold via `payments/capture` for the actual rate amount.
8. Asserts: `transactions` ledger has `+charge`, `−fee_stripe` rows summing to expected net.
9. Issues a void via `/api/cancel-label`. Stripe refunds (test). EasyPost void confirmation auto-arrives.
10. Asserts: `transactions` has `−refund` row, `shipments.refund_status='refunded'`.
11. Cleans up: deletes test rows tagged `idempotency_key LIKE 'testharness%'`.
12. Outputs a pass/fail report with timing for each step and the full ledger snapshot.

This single button proves all 9 events fire in order, all signatures verify, all idempotency keys deduplicate correctly, and the math sums. John runs it before every release.

### 5.3 Automated tests

Extends the existing 3-tier pyramid (SPEC §22):

**Unit (Vitest):**
- `src/lib/pricing.test.ts`: margin formula, hold formula, fee absorption math
- `src/lib/idempotency.test.ts`: key generator collision-free over 100k inputs
- `supabase/functions/_shared/stripe-fee.test.ts`: Stripe fee extraction from balance_transaction shape

**Integration (Node scripts in `tests/integration/`):**
- `tests/integration/stripe-payment-intent.mjs`: against Stripe test API, creates + confirms + captures, asserts shape
- `tests/integration/stripe-webhook-idempotency.mjs`: replays the same event 5×, asserts only 1 ledger row
- `tests/integration/reconciliation-math.mjs`: seeds 50 shipments with known costs/charges/fees, runs reconciliation report, asserts to-the-cent match

**E2E (Playwright):**
- `tests/e2e/full-label-payment.spec.ts`: types Stripe test card 4242 in real Elements iframe, verifies success state, asserts shipment + ledger
- `tests/e2e/payment-decline.spec.ts`: card 4000-0000-0000-0002 → friendly error → no shipment

CI gating: integration tests run only when `STRIPE_SECRET_KEY_TEST` is present in CI secrets (will be added).

### 5.4 Daily reconciliation cron

`pg_cron` job runs daily at 03:00 UTC, calls the new `reconcile-stripe` Edge Function:

```
1. window = [yesterday_00:00 UTC, today_00:00 UTC)
2. stripeBalanceTxs = stripe.balanceTransactions.list({
     created: { gte, lt }, type: 'charge,refund' }) -- paginated
3. localTxs = SELECT FROM transactions WHERE created_at IN window AND mode='live'
4. Compare on stripe_charge_id:
   - In Stripe, not local: write reconciliation_drift event ('orphan_stripe_charge')
   - In local, not Stripe: write reconciliation_drift event ('orphan_local_charge')
   - Amount mismatch: write reconciliation_drift event with both values
5. If drift count > 0:
   - email support@sendmo.co (via Resend)
   - log severity=error event for monitoring alert
```

A `reconciliation_drift` log row never auto-resolves — John (or a future admin tool) must investigate and write an `adjustment` transaction if a fix is needed. **Drift is never silently corrected.**

---

## 6. Migration + rollout

The first dollar must move safely. Rollout is gated, not a flip.

| Phase | What ships | Money risk | Gating criteria before next phase |
|---|---|---|---|
| **A. Schema land** | Migration 012 (transactions, holds, refunds, payment_methods, stripe_intents, view) | None | All migrations apply clean to remote; RLS test queries pass; `/admin/reconciliation` renders existing comp labels correctly with negative margins |
| **B. Setup Intent + saved cards** | Frontend swaps MockPaymentForm → Stripe Elements with SetupIntent. Card saved, no charge. Wallet UI on dashboard. | None (no charge) | John saves his own card test+live; appears in dashboard; webhook writes `payment_methods` row; signature verification works |
| **C. Self-charge dogfood (live)** | Switch full-label flow to PaymentIntent (capture=automatic). Admin toolbar gains "Live Charge" mode (currently has Test + Live Comp). Charges John's own card. | $5–$50 per test, all to John's card | 5 successful self-charges; reconciliation shows correct cost/charge/fee/margin to the penny; drift cron clean for 48h; void→refund tested once |
| **D. Public launch — full-label** | Remove admin toolbar gating; anyone can pay. Sentry alerts on payment errors. | Real customer money | Daily reconciliation manually reviewed for first 14 days; payment failure rate <5% (SPEC §19 target); zero drift events |
| **E. Flex-link auth/capture** | Step 22 wired with manual-capture PaymentIntent. Sender path captures on label buy. Hold expiration handler. | Real money on flex links | E2E test harness covers auth → capture → release excess; one full real flex-link cycle dogfooded by John |
| **F. Refund on void** | `processRefund()` in `refundService.ts` calls Stripe Refunds API on void. User-facing void in dashboard. | Refund correctness | One real void-refund cycle on a real shipment; ledger shows `-refund` row; customer sees credit on statement |

**How John tests with his own money before opening to real users:**

- Phase B: dogfood card-save with Stripe test mode (no money) and live mode (no charge yet — Setup Intent only).
- Phase C: the admin toolbar gains a "Live Charge" mode that enables real PaymentIntent creation gated behind the PIN and `is_admin=true` server check. John charges his own card $1–$50 per shipment for ~1 week. All margin tracking validates.
- Each phase has an explicit revert path: feature-flag the payment integration via an env var (`PAYMENTS_ENABLED=full|setup_only|off`) that the Edge Function reads. If something is wrong in production, set `off`, redeploy, mock form returns.

---

## 7. Risks + open questions

### Requires John to decide

1. **Refund destination policy.** SPEC §13.1 says "credit to SendMo balance, not original payment method." But the natural Stripe `refund.create()` puts money back on the original card. Three options: (a) refund to card always (simplest, what customers expect), (b) refund to SendMo balance always (current SPEC, requires balance UI), (c) user choice at refund time (post-MVP UI). My recommendation: **(a) for MVP**, revisit when balance feature ships. SPEC needs an update either way.

2. **Stripe fee absorption.** Current 13% gross margin minus 2.9% + $0.30 Stripe fee = thin or negative on cheap shipments (e.g., $3.74 Ground Advantage label has ~$0.49 SendMo margin; Stripe takes ~$0.41 = $0.08 net). Options: (a) absorb (current path), (b) add $0.30 surcharge on labels under $10, (c) raise margin to 17–18%. RATE_ANALYSIS.md flagged this in March; no decision yet.

3. **Hold-exceeded policy on flex-link.** If sender's actual rate exceeds the recipient's authorized hold (e.g., recipient capped at $20 hold but sender ships heavy and rate is $24.50): (a) block sender + email recipient to re-authorize ("your link's hold is too low"), (b) auto-bump cap by capturing exactly the hold and surfacing the gap ("you owe $4.50, please add a card"), or (c) silently fail. Phase E is blocked on this.

4. **Account creation timing for full-label path.** Today, the full-label flow doesn't create an account at all (open WISHLIST item). Stripe Customer requires an email. Either: (a) create Supabase user before payment step using the email already collected in Step 1, (b) create an "orphan" Stripe Customer keyed on email and reconcile later when the user signs in. My recommendation: **(a)** — auto-create Supabase user, send magic link in parallel.

5. **Test/live admin UX.** Today's admin toolbar has Test | Live Comp. When real charging ships, do we (a) keep three modes (Test | Live Comp | Live Charge), (b) collapse to two and infer mode from a separate setting, or (c) replace the PIN gate entirely with role-based auth before any of this ships?

### Requires external setup (John performs)

- Create Stripe live mode account (currently using test keys only, per `.env.example`).
- Configure Stripe webhook endpoints in dashboard for `https://fkxykvzsqdjzhurntgah.supabase.co/functions/v1/stripe-webhooks` (one for test, one for live — different secrets).
- Add to Supabase secrets: `STRIPE_SECRET_KEY_LIVE`, `STRIPE_WEBHOOK_SECRET_TEST`, `STRIPE_WEBHOOK_SECRET_LIVE`. Test secret is already in 1Password.
- Add to Vercel env: `VITE_STRIPE_PUBLISHABLE_KEY_LIVE`.
- Confirm Stripe account business profile, banking, and tax info (required before live charges).

### Expensive to get wrong

- **Forgetting to filter by `mode` in reconciliation.** Test charges polluting live margin reports. Mitigation: every reconciliation query has a `WHERE mode = 'live'` clause; the report has explicit "Test" / "Live" tabs so the filter is never implicit.
- **Webhook handler not idempotent.** Double-counting a single charge as $20 instead of $10. Mitigation: 3-layer idempotency (§4.5) + integration test that replays the same webhook 5×.
- **`UPDATE` on `transactions`.** Mitigation: REVOKE + trigger (§3.1).
- **Hold expiration unhandled.** Stripe auto-voids cards holds at 7 days; if our state isn't updated, we'll show stale "authorized" status forever. Mitigation: nightly cron that queries holds with `expires_at < now() AND status='authorized'`, calls Stripe to confirm, marks `expired`.
- **Race between webhook and synchronous response.** Frontend gets `payment_intent.succeeded` from the API, calls `labels`, but the webhook hasn't written the ledger yet → reconciliation briefly shows unmatched. Mitigation: `labels` checks ledger; if not present, writes it itself (with the same idempotency key the webhook would use). Webhook arrives later → ON CONFLICT DO NOTHING.
- **Live customer data in test events.** Mitigation: Stripe enforces test/live key separation strictly; never copy a `pi_test_...` ID into a live-mode flow.

---

## 8. Out of scope

These are deliberately deferred:

- **SendMo Balance / wallet topup** — schema supports it (`balance_topup`/`balance_redeem` tx types, `balances` view), but no UI or flow ships in this proposal. Phase 2.
- **ACH via Plaid** — Phase 3 (escrow).
- **Multi-currency** — USD-only.
- **Subscription / recurring billing** — never planned.
- **3DS strong customer auth UX polish** — Stripe Elements handles the redirect, but tuning UX copy for European cards is later.
- **Apple Pay / Google Pay** — would slot in via Payment Element later; out of scope for first dollar.
- **Dispute / chargeback management UI** — schema supports `chargeback` tx type and webhook flags it, but admin UI for handling disputes is post-MVP.
- **Stripe Tax** — taxability of shipping labels is jurisdiction-dependent. Most US states exempt postage; defer until first complaint.

---

## 9. Verification (post-implementation)

End-to-end walkthrough to run after each phase:

**Phase A:** `psql -c "\d transactions"` shows the table; `INSERT` works as service_role; `UPDATE` raises an error; `/admin/reconciliation` loads and shows existing comp shipments with negative margin.

**Phase B:** Open `/onboarding`, complete steps 0–10, click Pay, type Stripe test card 4242 in real Stripe Elements, see "Card saved" UI, confirm `payment_methods` row exists and matches the brand+last4 shown.

**Phase C:** Run the test harness (`/admin/test-harness`); all 9 steps pass. Then manually charge own card live mode; reconciliation report shows the row with margin matching SendMo's 15% formula minus actual Stripe fee.

**Phase D:** After 14 days, reconciliation drift count = 0; all `transactions` rows reconcile to Stripe `balance_transactions` ± $0.

**Phase E:** Real flex link → real sender flow → captured ≤ authorized → ledger correct.

**Phase F:** Real void → real Stripe refund → ledger has `−refund` row → customer's bank statement shows credit within 5–10 business days.

---

## 10. Open questions for the reviewer

The four sharpest things I'd want a fresh-eyes reviewer to push on:

1. **Is the single-entry signed-cents ledger the right shape, or should we go full double-entry (debits and credits on separate rows)?** Single-entry is simpler and matches how engineers think about it; double-entry is the universal accounting standard and makes audits trivial. I picked single-entry for MVP simplicity but might be wrong — a payments platform likely wants double-entry from day 1, especially given Phase 3 escrow.

2. **Should I split `stripe-webhooks` from `webhooks`, or is one handler with a router actually cleaner?** I argued for split (§2). Counter-argument: a single `webhooks` function with `req.headers.get('stripe-signature')` vs `req.headers.get('x-easypost-hmac-signature')` discriminating in 3 lines is less code than two functions. I might be over-engineering.

3. **Is Phase C (self-charging via admin toolbar) actually safe enough?** This is the riskiest phase — a code bug here charges John's real card. Should we instead do all dogfooding in test mode with mocked-EasyPost-success, and skip live charging entirely until Phase D?

4. **Have I missed any failure mode in the webhook → ledger path?** The 3-layer idempotency (§4.5) feels right, but webhook handlers are notoriously where money systems break. A reviewer who's seen this fail at another company would catch what I haven't.

---

## Decisions needed from John before implementation can start

1. **Refund destination policy** — original card (recommended for MVP) or SendMo balance (current SPEC). Drives Phase F and SPEC §13.1 update.
2. **Stripe fee absorption** — absorb (status quo, thin margins on cheap labels), pass through ($0.30 surcharge under $10), or raise margin to 17–18%. Drives pricing change and marketing copy.
3. **Hold-exceeded policy on flex-link** — block-and-reauth, auto-capture-with-gap-bill, or silent-cap. Blocks Phase E.
4. **Account creation timing for full-label path** — auto-create user before payment step (recommended) or create orphan Stripe Customer.
5. **Live-mode admin UX** — keep three modes (Test | Live Comp | Live Charge) on the toolbar, or replace PIN gate with role-based auth before this ships.

Once 1–4 are decided, Phase A can start the same week. #5 only blocks Phase C onward.

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
