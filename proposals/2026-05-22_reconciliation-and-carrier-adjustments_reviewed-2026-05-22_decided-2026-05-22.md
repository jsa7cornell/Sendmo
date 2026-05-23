---
title: Reconciliation + carrier-adjustment handling — true up EasyPost ⇄ SendMo ⇄ Stripe, every shipment
slug: reconciliation-and-carrier-adjustments
project: sendmo
status: decided
created: 2026-05-22
last_updated: 2026-05-22
reviewed: 2026-05-22
decided: 2026-05-22
author: Claude Opus 4.7 — Job 3 go-live session; implements master plan §3.7 + closes the comp-dogfooding leak John flagged
reviewer: Claude Opus 4.7 — fresh-eyes review session; cold read against PLAYBOOK Rule 16, PAYMENTS.md, the decided master plan §3.7 + sibling refund-implementation proposal, verified against migration 017 (transactions CHECK + carrier_adjustments shape), payments/index.ts (full-label SFU question), _shared/stripe.ts createPaymentIntent + createOffSessionShipmentPI, _shared/auth.ts requireAdmin, labels/cancel-label/tracking/webhooks current ledger write surface, and EasyPost's documented event catalog
outcome: approve-with-changes
---

## 1. Context

This proposal builds the **launch-blocking** reconciliation and carrier-adjustment system John approved 2026-05-22. It's not a from-scratch design — the master plan
[`2026-04-26_stripe-integration-plan_..._decided-2026-05-11`](2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md)
**§3.7 "Carrier rate adjustments (post-pickup margin recovery)"** already
specified the `carrier_adjustments` table, the tiered recovery policy, and the
cumulative caps. It was scoped **Phase G (post-MVP)**. John has now promoted it
to a **launch blocker** because:

1. The current state has a real, demonstrated leak: 4 cancelled comp labels
   (~$29 of EasyPost cost) sat for weeks with no system record of whether the
   wallet credit landed — `easypost_refund_status` was NULL for all of them
   until the manual backfill 2026-05-22. The leak is invisible without
   reconciliation.
2. SendMo's near-term plan is comp-mode dogfooding on real labels; that workflow
   depends on knowing refunds came back. Without it, every test costs real money.
3. The transactions ledger today is one-sided (Stripe/customer side only) — the
   EasyPost cost lives only as `shipments.rate_cents`, not as a ledger row. Half
   the money flow is unrecorded.

**Two corrections to §3.7 from research done 2026-05-22:**
- §3.7 assumed adjustments arrive embedded in `tracker.updated` or
  `shipment.updated`. **Verified against EasyPost's events doc:** the actual
  events are **`shipment.invoice.created`** and **`shipment.invoice.updated`**
  (the "ShipmentInvoice" event type). Documented USPS coverage; UPS/FedEx
  coverage is uncertain (open item).
- §3.7 listed the floor as $2; **John refined to $1**, and added a **$1
  handling fee** on every re-charge.

**Two product calls John made 2026-05-22 that shape scope:**
- **Recovery option (a) capped re-charge.** Build the off-session re-charge per
  §3.7. The industry-standard "no re-charge" alternative (prepaid balance /
  wallet) is **deferred to WISHLIST** — it's a regulatorily-heavy build
  (money-transmitter-licensing per Phase H).
- **Chargebacks live in the dashboard** as a money movement column and a
  Needs-Attention surface — fraud is real and the records must show it.

**Sibling proposal:** the [refund implementation proposal](2026-05-21_refund-system-implementation_reviewed-2026-05-21_decided-2026-05-22.md)
decided 2026-05-22. Its `/refunds` admin tool, the partial-refund plumbing, and
its WISHLIST cron sweep are siblings to this work — both share the bidirectional
ledger this proposal extends.

**Admin-surface design** lives in the preview mockups:
- `previews/reconciliation-dashboard.html` (Reconciliation tab, full table)
- `previews/shipment-detail.html` (click-through per-shipment view)

## 2. Architecture

### 2.1 The bidirectional `transactions` ledger

`transactions` today records the Stripe/customer side cleanly (`charge`,
`refund`, `fee_stripe`, `chargeback`, `comp_grant`). The EasyPost side lives
only as columns on `shipments` — `rate_cents`, `easypost_refund_status`. That's
the half-ledger we close.

**Two new `transactions.type` values:**
- **`label_cost`** — SendMo paid EasyPost for the label (negative; cash out). Written by `labels/` at label-buy time, `amount_cents = -rate_cents`.
- **`easypost_refund`** — EasyPost credited SendMo on a confirmed carrier void (positive; cash in). Written by the `refund.successful` arm in `webhooks/` and the lazy-poll path in `tracking/` when EP flips to `refunded`.

The existing `carrier_adjustment` type (already in the enum, master plan
§3.7) is now actively used.

**Rule 16 extension (deliberate, called out).** Today `stripe-webhook` is the
sole ledger writer for charge/refund/chargeback/fee rows; `labels` is the only
other writer (comp_grant rows). This proposal extends Rule 16 to:

| Type | Sole writer |
|---|---|
| `charge`, `refund`, `refund_fee_recovered`, `fee_stripe`, `chargeback` | `stripe-webhook` *(unchanged)* |
| `comp_grant` | `labels` *(unchanged)* |
| **`label_cost`** | **`labels`** *(new)* |
| **`easypost_refund`** | **`webhooks` (push) + `tracking` (poll)** *(new)* |
| **`carrier_adjustment`** | **`webhooks` ShipmentInvoice handler + reconciliation-sweep** *(new)* |

Idempotency keys keep dual writers (push + poll) from double-inserting. The
PLAYBOOK Rule 16 entry must be amended to reflect this writer map.

### 2.2 The `carrier_adjustments` table

Built per master plan §3.7 schema — unchanged. One row per adjustment event:

```sql
CREATE TABLE carrier_adjustments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id           UUID NOT NULL REFERENCES shipments(id),
  source                TEXT NOT NULL DEFAULT 'easypost',
  source_event_id       TEXT UNIQUE,                -- EasyPost ShipmentInvoice id (the dedup key)
  delta_cents           INTEGER NOT NULL,           -- + = carrier billed more (the common case)
  reason                TEXT,                       -- 'reweigh','dim','address_correction',...
  claimed_weight_oz     INTEGER,                    -- new: from ShipmentInvoice payload
  captured_weight_oz    INTEGER,                    -- new: enables disputes
  recovery_status       TEXT NOT NULL CHECK (recovery_status IN
                          ('pending','recovered','absorbed','disputed','rejected')),
  recovery_tx_id        UUID REFERENCES transactions(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at           TIMESTAMPTZ
);
```

Two additions vs. §3.7's spec: `claimed_weight_oz` / `captured_weight_oz` —
ShipmentInvoice carries these and they're the evidence for a dispute (PAYMENTS.md
dispute mechanism — USPS via `VerifyPostageHelp@usps.gov`, needs the
declared-vs-captured numbers).

### 2.3 Detection — dual path

**Primary (push): EasyPost ShipmentInvoice webhook.**
`webhooks/index.ts` adds an arm for `description === 'shipment.invoice.created'`
and `'shipment.invoice.updated'`. Resolves the SendMo shipment by
`shipment_id`, dedup on `source_event_id` (the ShipmentInvoice id), INSERTs
`carrier_adjustments` and the `transactions` row, then dispatches to the
recovery logic (§2.4).

**Backstop (pull): reconciliation sweep.**
New `reconciliation-sweep` Edge Function — daily incremental + weekly bulk.
Catches adjustments the webhook missed (notably for UPS/FedEx if coverage
proves spotty) by:
- **Daily:** `GET /v2/shipments?start_datetime=<last_run>&page_size=100` and `GET /v2/refunds?...` — cursor-paginated, list-and-diff against SendMo's `shipments`.
- **Weekly (or on-demand):** generate `shipment` and `payment_log` reports (Reports API, ≤31-day windows). The `payment_log` report's **`amount_delta_fee` column** is the carrier-adjustment ground truth; per-shipment join via `shipment_id`. Catches anything missed.

Both paths converge on the same `carrier_adjustments` table; the UNIQUE
`source_event_id` constraint prevents duplicate inserts.

### 2.4 Recovery — tiered policy (John's parameters, master plan §3.7 caps)

Decision tree, applied immediately after the adjustment is recorded:

| `delta_cents` (signed; + = carrier billed more) | Action |
|---|---|
| ≤ $1 | **Absorb** — `recovery_status='absorbed'`, no further action |
| $1.01 – $10 *and* no cap breach | **Auto re-charge** — off-session PaymentIntent for `delta + $1 handling fee` |
| > $10 *or* any cap breach | **Flag** — `recovery_status='pending'`, surfaces in admin Needs-Attention |
| Negative (credit) | **Absorb** — credit lands in wallet; record only |
| Comp shipment (no PI) | **Absorb** — no customer to recover from |
| No usable saved card | **Flag** — see Open Question #1 |

**Caps (carried from §3.7, unchanged):**
- Per-shipment lifetime: ≤ $10 in auto-recharged adjustments per `shipment_id`.
- Per-card per-24h: ≤ $20 in adjustment re-charges per `payment_method_id`.
- Per-user per-7d: ≤ $50 in adjustment re-charges per `user_id`.

Cap-breach → flag for manual review (prevents the "stuck loop chains 3 charges and looks like fraud" failure §3.7 was written to stop).

**The off-session re-charge** uses `_shared/stripe.ts:createOffSessionShipmentPI`
(Pattern D primitive), with idempotency key
`adjustment_${shipment_id}_${carrier_adjustment_id}` (a distinct namespace from
the cancel-path `_user_cancel` and the labels-buy `_buy_failed` and the new
admin-refund `_admin_${refundRequestId}` keys).

**Customer notification email** (new template): "Carrier adjustment — we billed
your card $X.XX." Names the carrier and reason ("UPS dimensional reweigh") and
links to `/t/<public_code>`. Following the refund-emails pattern — direct
`sendEmail`, `notifications_log` dedup keyed per `carrier_adjustments.id`.

### 2.5 Admin reconciliation dashboard

The mockups at [`previews/reconciliation-dashboard.html`](../previews/reconciliation-dashboard.html)
and [`previews/shipment-detail.html`](../previews/shipment-detail.html) are the
admin-surface design.

**New `/admin` tab "Reconciliation"** alongside Labels/Links:
- **Five summary cards:** Reconciled count, Net margin (period), Carrier adjustments total, Refunds in flight, Chargebacks, EasyPost wallet balance (with a `GET /v2/users` cross-check that the wallet matches expected).
- **"Needs attention" panel** for items the sweep can't auto-resolve: chargebacks (Submit evidence / Accept), flagged adjustments > $10 (Dispute / Re-charge / Absorb), orphan EasyPost shipments (Investigate), refunds stuck past 3 weeks (Re-poll).
- **Full per-shipment table** — 15 columns grouped:
  - Shipment (clickable to detail) · Carrier
  - **Timeline:** Label created · Ship date · Delivered
  - **Customer side (Stripe):** Paid · Stripe fee · Refunded to customer · Adjustment collected · Chargeback
  - **EasyPost side:** Label cost · Refunded from EasyPost · Adjustment charged
  - **Net margin** · Status
- **Per-shipment detail view** — parties (sender + recipient emails), addresses, package + service, timeline, full event-by-event money ledger → net margin, references out (EasyPost / Stripe / `/t/<code>` / flex link), admin actions.

### 2.6 Chargeback handling

Stripe's `charge.dispute.created` is already wired in `stripe-webhook/index.ts`
(today writes a `transactions.type='chargeback'` row + Stripe dispute-fee row).
This proposal adds:
- A **"Chargeback" column** in the reconciliation table that shows the *full*
  hit — disputed amount + the ~$15 Stripe dispute fee — as one figure with the
  breakdown inline.
- A **Needs-Attention row** when a chargeback is open, with the evidence
  deadline (`evidence_details.due_by` from the Stripe Dispute object) and
  *Submit evidence* / *Accept* actions. Evidence-package construction itself is
  out of scope for this proposal — see §5.

## 3. File-by-file plan

### Database

**`supabase/migrations/0NN_carrier_adjustments_and_ledger_extensions.sql`** (NEW):
- `CREATE TABLE carrier_adjustments` per §2.2 (master plan §3.7 schema + the two `*_weight_oz` columns).
- `CREATE INDEX idx_carrier_adj_status ON carrier_adjustments (recovery_status)`.
- `CREATE INDEX idx_carrier_adj_shipment ON carrier_adjustments (shipment_id)`.
- *(Note: `transactions.type` CHECK already allows `label_cost`? No — verify; if not, ALTER the CHECK to add `label_cost` and `easypost_refund`. The existing enum has `carrier_adjustment` already, master plan migration 017.)*

### Edge Functions

**`supabase/functions/webhooks/index.ts`** (extend):
- Add `if (description === 'shipment.invoice.created' || description === 'shipment.invoice.updated')` arm.
- Resolve shipment by `result.shipment_id`, dedup on `result.id` (the ShipmentInvoice id) via UNIQUE `carrier_adjustments.source_event_id`.
- INSERT `carrier_adjustments` row with `delta_cents = result.adjustment_amount * 100`, `reason = result.adjustment_reason`, weights from `result.claimed_details`.
- INSERT corresponding `transactions` row (`type='carrier_adjustment'`, `amount_cents = -delta_cents`).
- Call `_shared/adjustments.ts:resolveRecovery(shipment, deltaCents)` → executes the tiered decision (absorb / re-charge / flag) and updates `recovery_status`.

**`supabase/functions/labels/index.ts`** (extend):
- After successful EasyPost label buy + `admin_insert_shipment`, INSERT `transactions` row `type='label_cost'`, `amount_cents = -rate_cents`, `idempotency_key='label_cost_${easypost_shipment_id}'`.

**`supabase/functions/cancel-label/index.ts`** + **`tracking/index.ts`** + **`webhooks/index.ts` refund.successful arm** (extend):
- When EasyPost confirms a refund (carrier credited back), INSERT `transactions` row `type='easypost_refund'`, `amount_cents = +refund_amount`, `idempotency_key='ep_refund_${easypost_shipment_id}'`. The UNIQUE idempotency key prevents the three writers from double-inserting.

**`supabase/functions/_shared/adjustments.ts`** (NEW): the tiered-policy helper. `resolveRecovery(shipment, deltaCents)` returns `{ decision: 'absorb'|'recharge'|'flag', amount_cents, reason }`. Encapsulates floor/cap math. Used by webhook handler, reconciliation sweep, and the admin-override endpoint.

**`supabase/functions/_shared/stripe.ts`** (extend): add `createAdjustmentRecharge({ shipment, deltaCents, carrierAdjustmentId, ... })` — wraps `createOffSessionShipmentPI` with the $1 handling fee, the correct idempotency key, metadata `{ shipment_id, carrier_adjustment_id, reason }`, off_session/confirm.

**`supabase/functions/reconciliation-sweep/index.ts`** (NEW): admin-gated (via `requireAdmin`) endpoint + a scheduled trigger. Modes:
- `mode=daily`: list-and-diff since `last_run_at` (stored in a small `recon_state` table or `event_logs`). EasyPost Shipments + Refunds list endpoints, paginate, diff.
- `mode=weekly`: kicks off a `shipment` report and a `payment_log` report via Reports API, polls for `available`, downloads the CSV (within the ~1hr URL window), parses, diffs.
- Surfaces mismatches into `event_logs` (severity warn/error) and a new `recon_exceptions` table or by setting flags on existing rows. For adjustments found in the sweep but not via webhook: calls `_shared/adjustments.ts:resolveRecovery` so the recovery loop fires.
- pg_cron registers daily at e.g. 04:00 UTC; weekly bulk on Sundays.

**`supabase/functions/reconciliation-report/index.ts`** (NEW, admin): GET endpoint. Joins `shipments` ↔ `transactions` ↔ `carrier_adjustments` ↔ `refunds` for a date range. Returns JSON the admin dashboard renders: summary cards data + per-shipment rows + needs-attention items. Computes net margin per row using §2.1's identity.

**`supabase/functions/admin-recon-action/index.ts`** (NEW, admin): POST endpoint for the Needs-Attention action buttons. Routes: `/dispute` (marks `recovery_status='disputed'` + logs the carrier-dispute action; the actual email to USPS/UPS is manual — this endpoint records the decision), `/recharge` (forces the auto-recharge path even for >$10 — admin override), `/absorb` (marks `recovery_status='absorbed'`).

**`supabase/config.toml`**: add `[functions.reconciliation-sweep]`, `[functions.reconciliation-report]`, `[functions.admin-recon-action]` blocks (all `verify_jwt = true`).

### Email

**`supabase/functions/_shared/email-templates.ts`** (extend): add `carrierAdjustmentEmail({ amount, fee, carrier, reason, public_code, tracking_url })`.

### Frontend

**`src/pages/AdminReconciliation.tsx`** (NEW): the reconciliation tab, renders the dashboard at `previews/reconciliation-dashboard.html` as React. Fetches from `/functions/v1/reconciliation-report`. Wires Needs-Attention action buttons to `/functions/v1/admin-recon-action`.

**`src/pages/AdminShipmentDetail.tsx`** (NEW): the detail view at `previews/shipment-detail.html` as React. Route `/admin/shipments/:public_code`.

**`src/pages/Admin.tsx`** (extend): add the "Reconciliation" tab to the existing two-tab nav.

### Docs

**`PLAYBOOK.md`** — amend Rule 16 with the new writer map (§2.1).
**`PAYMENTS.md`** — add a §X on carrier adjustments (the tiered policy, the dual-path detection, the dispute mechanism).
**WISHLIST** — mark "Cron-poll for stale `refund_status='submitted'`" as covered-by-this; mark "Prepaid balance / wallet" as the noted future for adjustment recovery; mark "Payment transaction ledger" closer to closure (this completes the bidirectional half).

## 4. Test plan

- **Unit (`tests/unit/adjustments.test.ts`):** tiered-policy decision — every tier (≤$1 absorb, $1.01–$10 recharge, >$10 flag, credit absorb, comp absorb, no-card flag); each cap (per-shipment, per-card-24h, per-user-7d); negative deltas.
- **Unit (`tests/unit/reconciliation-math.test.ts`):** per-shipment net-margin computation against fixtures including every combination of charge / fee / refund / chargeback / label_cost / easypost_refund / carrier_adjustment.
- **Integration:** mock a `shipment.invoice.created` payload → POST to `webhooks` → assert `carrier_adjustments` + `transactions` rows + correct `recovery_status` (per fixture's tier).
- **Integration:** mock `shipment.invoice.updated` after a `created` → assert dedup on `source_event_id` (no duplicate row).
- **Integration:** seed 50 shipments + 10 adjustments + 5 refunds + 1 chargeback in test DB → run `reconciliation-sweep` → assert zero false mismatches.
- **E2e (Playwright):** admin views Reconciliation tab → sees populated summary + table; clicks a Needs-Attention "Re-charge customer" → re-charge fires, row moves to ✓ Reconciled.
- **Browser-verify (Rule 19):** the dashboard + detail view, two real shipments — one with a re-charged adjustment, one comp with a confirmed refund.

## 5. Out of scope

- **Prepaid balance / wallet model** (option (b) from the design discussion) — WISHLIST, future, regulatorily-heavy (Phase H MTL/KYC).
- **Programmatic carrier-dispute filing.** Disputes are manual and carrier-direct (USPS `VerifyPostageHelp@usps.gov`; UPS forms; ~60–120-day windows). The dashboard surfaces the data needed; John (or an admin) files.
- **Chargeback evidence-package construction.** Surfacing the chargeback + deadline + actions is in scope; building the evidence bundle (label image, tracking proof, customer correspondence) is its own work — separate proposal when volume justifies.
- **Phase-3 escrow integration.**
- **A 12th Stripe-webhook event subscription for `charge.refund.updated`** is covered by the sibling refund-implementation proposal (Decision D1).

## 6. Verification

1. **Synthetic adjustment in test mode.** Buy an EasyPost test label, simulate a `shipment.invoice.created` via EasyPost test events → confirm webhook handler runs → `carrier_adjustments` row appears, `transactions` row appears, `recovery_status` matches the tier, customer notification email sends (test mode → captured).
2. **Real adjustment, live mode (Job 3 Step 4 smoke-test follow-on).** Buy a real label, deliberately under-declare weight (e.g. declare 1 lb on a 3 lb package). Wait for the carrier to reweigh. Confirm: ShipmentInvoice webhook lands → recovery fires per tier → customer is emailed → dashboard reflects every column populated, ✓ Reconciled.
3. **Reconciliation sweep against current production data.** Run the daily incremental → no false mismatches; the 31 existing shipments reconcile (the 4 cancelled comp ones included). Run a weekly bulk → `payment_log` report's `delta_fee` column matches per-shipment `carrier_adjustments` rows; the EasyPost wallet balance (`GET /v2/users`) cross-checks SendMo's expected total.
4. **Chargeback drill.** In Stripe test mode, file a synthetic dispute on a test charge → confirm `charge.dispute.created` lands → Needs-Attention row appears with evidence deadline → "Accept" updates the chargeback ledger row terminally.

## 7. Open questions

1. **Does the full-label flow save the customer's card?** Off-session re-charge for adjustments needs a saved PM. Flex saves cards (Pattern D / SetupIntent at link creation). Full-label — verify; if not, every full-label adjustment defaults to `recovery_status='pending'` and admin manually charges. This is a real launch consideration.
2. **UPS / FedEx ShipmentInvoice webhook coverage.** EasyPost originally documented this webhook for USPS APV adjustments and stated it would expand. The reconciliation sweep covers the gap, but the latency differs (push: seconds; sweep: daily). Confirm directly with EasyPost (a 5-min support ticket).
3. **Cron cadence.** Daily incremental at 04:00 UTC, weekly bulk Sundays — is that the right cadence, or should the incremental be more frequent (hourly)? Weekly bulk = 4 reports/month, well within EasyPost rate limits.
4. **`recovery_status='disputed'`.** When John clicks Dispute on a flagged adjustment, the actual filing is manual (email USPS). Does the dashboard need to track the dispute's *outcome* (approved/rejected by carrier), or is it enough to mark `disputed` and let John update it when EasyPost credits the wallet (which the sweep would detect as a new `easypost_refund`-type credit)?
5. **Custom alerts.** Beyond surfacing in the dashboard, should chargebacks email John directly (vs. requiring him to check the dashboard)? Same question for large flagged adjustments?

## Reconciliation with prior decided proposals

- **`2026-04-26_stripe-integration-plan` §3.7 (decided 2026-05-11):** carrier-adjustment recovery design. This proposal **implements §3.7** as a launch blocker (rather than Phase G post-MVP), with two corrections — the webhook events are `shipment.invoice.*` (not `tracker.updated`/`shipment.updated`); the floor is $1 with a $1 handling fee added (vs. $2 floor, no fee). The caps and the auto-debit mechanism are honored as-decided.
- **`2026-05-21_refund-flow-review_..._decided-2026-05-21`** + **`2026-05-21_refund-system-implementation_..._decided-2026-05-22`:** siblings. This proposal completes the EasyPost-side ledger that the refund work depends on (`easypost_refund` type closes the gap that left `easypost_refund_status` as the only signal of wallet credit).
- **`2026-05-21_payments-risk-intelligence`** (in-review): adjacent. That proposal handles fraud *prevention* (Radar, dispute insurance); this proposal handles the *bookkeeping* surface for chargebacks. No overlap; cross-link in WISHLIST.
- **PLAYBOOK Rule 16:** this proposal **extends** Rule 16's sole-writer map (§2.1). The amendment is a deliberate, documented change — not drift.
- **WISHLIST:** "Payment transaction ledger" (existing) moves substantially closer to complete; "Cron-poll for stale refunds" is partially covered by the reconciliation sweep; "Prepaid balance" is the explicitly-deferred future for adjustment recovery.

---

## Review

```yaml
reviewer: Claude Opus 4.7 — fresh-eyes review session; cold read against master plan §3.7, sibling refund-implementation proposal, PLAYBOOK Rule 16, PAYMENTS.md, migration 017 (transactions CHECK + carrier_adjustments shape), payments/index.ts (full-label PI shape), _shared/stripe.ts (createPaymentIntent vs createOffSessionShipmentPI), _shared/auth.ts (requireAdmin), labels/cancel-label/tracking/webhooks ledger-write surface, and a direct fetch of EasyPost's events doc
reviewed_at: 2026-05-22
verdict: approve-with-changes
```

### Summary

The proposal is strong on shape — bidirectional ledger, dual-path detection, tiered recovery, dashboard surface all line up with §3.7 and with what's actually in the code today. **Two corrections to §3.7** are real and verified (EasyPost's `shipment.invoice.created/updated` events do exist per direct fetch of docs.easypost.com/docs/events; §3.7's `tracker.updated`/`shipment.updated` reference is genuine drift). **But three things break before this ships as written:** (B1) Open Question #1 is answerable now and the answer is **no** — `payments/index.ts:208` never passes `setup_future_usage` and never attaches the PM to a Customer, so **full-label adjustments cannot auto-recharge at all**, which makes the entire ≤$10 tier inert for the dominant launch flow; (B2) the §3 migration plan says `CREATE TABLE carrier_adjustments` but the table already exists in migration 017 (lines 334–346) with a *different* `recovery_status` enum, no UNIQUE on `source_event_id`, and no weight columns — this is an `ALTER TABLE`, not a `CREATE`; (B3) §3 quietly extends `transactions.type` to include `label_cost` and `easypost_refund` but never names the CHECK-constraint migration — migration 017's CHECK admits neither value (verified at lines 126–138), so every new INSERT will be rejected at the DB layer. All three are fixable in the file-by-file plan before code lands.

### Blocking issues

**B1 — Open Question #1 ("does full-label save the card?") has a definitive negative answer, and resolving it factually demotes the ≤$10 auto-recharge tier to a flex-only feature.**
*Location:* §2.4 (tiered policy: "$1.01–$10 → auto re-charge"), §7 Open Question #1, §3 `_shared/stripe.ts:createAdjustmentRecharge`.
*Issue:* I read `supabase/functions/payments/index.ts:208-236` (the full-label PI create) and `_shared/stripe.ts:153-190` (`createPaymentIntent`). The full-label PI is created with **no `customer` and no `setup_future_usage`** — the only callsite of `setup_future_usage` in the entire `supabase/functions/` tree is the type signature itself (verified: zero non-test references via `grep -rn "setup_future_usage" supabase/functions/`). `createOffSessionShipmentPI` requires both `customer` and `payment_method` as required params. So for any full-label shipment, there is **no saved PM and no Stripe Customer** — the auto-recharge tier (proposal's centerpiece) is structurally unreachable. The flex path (`labels/index.ts:563`) does have it because Pattern D / flex SetupIntents store the PM. The proposal's own §7 OQ#1 hints at this ("if not, every full-label adjustment defaults to `recovery_status='pending'`") but understates the consequence: on the day of launch, the dominant traffic surface (full-label dogfood) generates an adjustment → falls straight to "flag" → admin handles each one manually. That's not a v1 limitation worth burying in an open question; it's the actual scope. Either (a) the full-label PI starts attaching the customer + setting `setup_future_usage: 'off_session'` (small change in `payments/index.ts`, but adds a Customer-creation prerequisite + a UX call about saved-card consent), and that work belongs in this proposal as a P1 line item; or (b) the proposal honestly re-scopes auto-recharge to flex-only, renames the ≤$10 tier behavior on full-label to "always flag," and updates the dashboard mockup's "Adjustment collected" expectations.
*Suggested fix:* Resolve OQ#1 in the proposal body. State plainly that auto-recharge requires either (i) extending the full-label PI to save the card (with the customer-creation + consent UX as in-scope work — `payments/index.ts:208` + a `getOrCreateCustomerForUser` shim like the one the flex path uses), or (ii) restricting auto-recharge to flex-only in v1. Pick one and write the chosen path into §3 — don't leave an implementer to discover this is unreachable when they wire `createAdjustmentRecharge` against a full-label adjustment.

**B2 — §3 says `CREATE TABLE carrier_adjustments` but the table already exists with a different shape; this is an `ALTER`, not a `CREATE`, and several of the proposal's claims about the shape are inconsistent with what's deployed.**
*Location:* §3 Database, "`supabase/migrations/0NN_carrier_adjustments_and_ledger_extensions.sql` (NEW): `CREATE TABLE carrier_adjustments`."
*Issue:* `carrier_adjustments` ships in migration 017 (verified at `017_stripe_phase_a_transactions_ledger.sql:334-346`). The shipped shape is:
- `recovery_status TEXT NOT NULL CHECK (recovery_status IN ('pending','recovered','absorbed','disputed'))` — note this is **4 values, no `'rejected'`**. The proposal's §2.2 lists 5 (`pending|recovered|absorbed|disputed|rejected`).
- `source_event_id TEXT` — **no `UNIQUE` constraint**. The proposal explicitly relies on this UNIQUE in §2.3 ("dedup on `source_event_id` (the ShipmentInvoice id) via UNIQUE `carrier_adjustments.source_event_id`") and §3 webhooks plan ("UNIQUE … prevents the three writers from double-inserting"). Without the UNIQUE the dedup story collapses — two near-simultaneous `shipment.invoice.created` deliveries (Stripe webhook retries are not the only retry source; EasyPost re-deliveries happen on `5xx` ack) both INSERT, and the recovery loop fires twice.
- No `claimed_weight_oz` / `captured_weight_oz` columns.

So the migration is actually: `ALTER TABLE carrier_adjustments ADD COLUMN claimed_weight_oz INT, ADD COLUMN captured_weight_oz INT;` plus a `DROP CONSTRAINT ... ADD CONSTRAINT` dance for the `recovery_status` CHECK to admit `'rejected'`, plus `ALTER TABLE ... ADD CONSTRAINT carrier_adjustments_source_event_id_key UNIQUE (source_event_id) WHERE source_event_id IS NOT NULL` (or a `CREATE UNIQUE INDEX ... WHERE source_event_id IS NOT NULL` if NULLs need to be tolerated). The proposal's §3 also drops a parenthetical "(Note: `transactions.type` CHECK already allows `label_cost`? No — verify…)" which is half-correct (see B3 below) — the same uncertainty visibly applies to the carrier_adjustments shape and the author flagged the right axis but missed extending the audit to this table.
*Suggested fix:* Replace "`CREATE TABLE carrier_adjustments`" with the explicit `ALTER`s. Add the partial UNIQUE index on `source_event_id`. Add the CHECK-constraint swap to admit `'rejected'`. State the migration ID concretely (next free is `032_` given 031 is `payments_risk_intelligence`). Reference migration 017 lines 334-346 as the prior art being amended.

**B3 — The `transactions.type` CHECK constraint at migration 017 admits neither `label_cost` nor `easypost_refund`; every INSERT for those types fails at the DB layer.**
*Location:* §2.1 (the new types), §3 Database parenthetical, §3 labels/cancel-label/tracking/webhooks extensions.
*Issue:* I read the CHECK at `017_stripe_phase_a_transactions_ledger.sql:126-138`. The admitted values are: `charge | fee_stripe | refund | refund_fee_recovered | comp_grant | balance_topup | balance_topup_bonus | balance_redeem | carrier_adjustment | chargeback | adjustment`. `label_cost` is absent. `easypost_refund` is absent. The proposal's §3 parenthetical asks the question ("verify; if not, ALTER the CHECK to add…") but the answer is *not* in the doc — and worse, the proposal treats the ALTER as an "if needed" line item rather than a hard prerequisite. Because the `transactions` triggers (lines 188-193) explicitly RAISE on rejection, an implementer following §3 will deploy the new `labels/index.ts` writer, the first label-buy will fail with a `transactions is append-only` red herring (actually a CHECK failure), and the entire labels path will go red in production. This is a guaranteed launch-blocker if shipped as written.
*Suggested fix:* In §3 Database, explicitly: `ALTER TABLE transactions DROP CONSTRAINT transactions_type_check; ALTER TABLE transactions ADD CONSTRAINT transactions_type_check CHECK (type IN ('charge','fee_stripe','refund','refund_fee_recovered','comp_grant','balance_topup','balance_topup_bonus','balance_redeem','carrier_adjustment','chargeback','adjustment','label_cost','easypost_refund'));`. Drop the parenthetical "if not" hedge.

**B4 — The Rule-16 extension (§2.1) makes three writers — `cancel-label`, `tracking`, and `webhooks` (refund.successful arm) — all candidates for the `easypost_refund` row, but the proposed idempotency key `ep_refund_${easypost_shipment_id}` is not strong enough to guarantee single-row outcomes across all real races.**
*Location:* §2.1 writer map, §3 "cancel-label + tracking + webhooks refund.successful arm (extend): … idempotency_key='ep_refund_${easypost_shipment_id}'."
*Issue:* The UNIQUE-key story works *if* a shipment's refund only ever fires once. But:
- A label can be voided, refused by the carrier, re-voided manually (admin retry), and then succeed — that's two separate `refund.successful` events for the same `easypost_shipment_id` over weeks. With the proposed key, the second one's INSERT silently fails (collision), the `+easypost_refund` row never lands, and `easypost_refund_status='refunded'` is set on `shipments` without the corresponding ledger entry. The dashboard's identity (Paid − Stripe fee − Refund to customer + Adjustment collected − Chargeback − Label cost + Refund from EasyPost − Adjustment charged = Net margin) understates Net margin by exactly the missed refund amount. Silent.
- More pressingly: the three writers race on the *same* `refund.successful` event. The webhook handler INSERTs; before it commits, the user lands on `/t/<code>` and `tracking/index.ts:278` polls EP, sees `refunded`, also tries to INSERT. The shared UNIQUE key catches it — *but* the proposal's §3 says all three writers also "INSERT corresponding transactions row" — meaning the same race exists for the ledger row, and the ledger row's idempotency key in the proposal is `ep_refund_${easypost_shipment_id}` (single, no event-disambiguation). Same outcome: one of the writers' inserts collides, silently. The sibling refund-implementation proposal handled this by keying the cancel-path refund as `refund_${ep_shipment_id}_user_cancel` (verified in its §2.4 table) — distinct from the admin path. The proposal here re-flattens that namespace.
*Suggested fix:* Either (a) namespace the three writers explicitly (`ep_refund_${eps_id}_webhook`, `_poll`, `_cancel`) and accept N=3 rows in pathological cases with a query-time de-dup, or (b) key on the EasyPost Refund object's id (which is what EasyPost emits on the `refund.successful` event payload) instead of the shipment id — that's the natural per-event identifier and gives true single-row semantics. Option (b) is cleaner and matches the §2.3 pattern (UNIQUE `source_event_id` on `carrier_adjustments`).

### Non-blocking concerns

**N1 — The reconciliation sweep silently skips when the webhook already inserted, but never checks that the existing row's `recovery_status` is *what the sweep would have computed*.** If the webhook handler crashes between INSERTing `carrier_adjustments` and calling `resolveRecovery`, the row sits at `recovery_status='pending'` forever — the sweep's "INSERT … ON UNIQUE skip" logic moves on. The sweep should compare existing rows' `recovery_status` against the policy and re-fire recovery on drift (idempotently, because the recharge idempotency key is `adjustment_${shipment_id}_${carrier_adjustment_id}` — a re-call against an already-succeeded PI is a no-op). Worth one sentence in §2.3.

**N2 — The cap-math in `_shared/adjustments.ts:resolveRecovery` is called from three places (webhook, sweep, admin override) and the proposal doesn't specify whether it's read-committed-safe.** Two adjustments on the same shipment that arrive within ~100ms (rare but possible — UPS reweigh + address-correction surcharge as separate ShipmentInvoice events) both read the same "current sum = $0" pre-this-row, both pass the per-shipment-$10 cap, and the shipment ends up auto-recharged for $11 total. Recommend: wrap the cap-check + INSERT in a single transaction with `SELECT … FOR UPDATE` on the shipment row, or move the cap-check into a DB trigger that reads the post-INSERT state. Either is small; leaving it racy is a chargeback magnet (the exact failure §3.7's caps were written to prevent).

**N3 — The >$10 flag tier vs. the ~60-day USPS dispute window creates a quiet ageing problem the dashboard doesn't model.** If John doesn't review a flagged adjustment for 3 weeks, the customer was never recharged (the cap pushed it past 'auto'), the ledger sits with the negative carrier_adjustment but no offsetting +charge, and the per-shipment Net margin column shows the loss as if it's permanent. Worse: the USPS dispute clock is running, and at day ~60 the dispute window closes. The dashboard mockup at `previews/reconciliation-dashboard.html` doesn't show a "days-since-flagged" or "dispute-window-remaining" indicator on flagged items. Recommend: add a `flagged_at` timestamp (or use `created_at`) and surface a "days until USPS dispute window closes" countdown on the Needs-Attention row for >$10 adjustments. Otherwise the launch's first big reweigh quietly ages out.

**N4 — Open Question #4 ("does the dashboard need to track dispute outcome?") matters more than the question wording suggests, because §2.3 wants the sweep to detect the wallet credit when USPS approves the dispute — but the sweep can only do that if it knows which `easypost_refund` rows are "dispute approvals" vs. "normal voids."** Without dispute-tracking, the sweep sees an unexplained +wallet credit and either creates a duplicate `easypost_refund` row (if the cause is a USPS dispute approval that EP credits separately) or silently absorbs it. Worth resolving the open question in scope: at minimum, the `disputed` row should carry an `expected_credit_cents` so the sweep can pattern-match a later EP credit and link them.

**N5 — Customer notification email for the auto-recharge tier ($1.01–$10) is named in §2.4 but not in the §3 file-by-file plan as a new template.** §3 Email section adds `carrierAdjustmentEmail` to `email-templates.ts`; good. But the *send-site* — which function fires the email — isn't named. It logically belongs in `_shared/adjustments.ts:resolveRecovery` (right after the recharge PI returns `'succeeded'`), but that means `adjustments.ts` now needs `sendEmail` as a dep, which is fine but worth saying.

### Nits

- §3 Database parenthetical: "the existing enum has `carrier_adjustment` already, master plan migration 017" — confirmed accurate (line 135). Just drop the "?" hedge and state it as fact.
- §2.4 "idempotency key `adjustment_${shipment_id}_${carrier_adjustment_id}`" — good namespace, but a re-attempt after a failed first PI needs *different* keys per attempt or Stripe dedups to the failure result. Two options: append a retry counter, or use the per-attempt UUID pattern the sibling refund-implementation adopted (`_${attemptId}`). Worth a note.
- §3 `_shared/adjustments.ts:resolveRecovery` signature: `(shipment, deltaCents)` — but the cap-math needs `payment_method_id` and `user_id`, which aren't on `shipment` directly (they're on `stripe_intents` or derived from the PI). Either widen the signature or specify what `shipment` includes.
- §2.5 mentions a `GET /v2/users` cross-check for the EasyPost wallet balance — confirm the response shape includes a wallet/balance field; the public docs are thin on this. If the field is named `balance` it's worth citing.
- The PLAYBOOK Rule-16 amendment (§2.1) needs to land as an actual `PLAYBOOK.md` Edit in §3, not just "must be amended" — the proposal calls it out but doesn't put it in the file-by-file plan as a concrete patch.
- Mockup `previews/reconciliation-dashboard.html` uses **green** for the active-tab/brand color (verified, line 25: `--green:#16a34a`), but the React port at `src/pages/AdminReconciliation.tsx` will be expected to honor the design tokens in `index.css` (PLAYBOOK Design System) which are blue-primary. Mention the design-token reconciliation, or the mockup-to-React port will drift.

### Predicted pitfalls (if shipped as written)

1. **First production label-buy after deploy reds the entire labels path because `transactions.type='label_cost'` is rejected by the CHECK constraint.** (Ties to B3.) Migration runs without updating the CHECK; `labels/index.ts` extension lands; first real label-buy attempts `INSERT INTO transactions (type='label_cost', ...)`; Postgres raises `new row for relation "transactions" violates check constraint "transactions_type_check"`; the trigger's "Rule 16 / append-only" RAISE message obscures the real cause; on-call agent spends 20+ minutes chasing a Rule-16 ghost before grepping migration 017's CHECK. Recurrence pattern: this is the same class as the EasyPost STATUS_MAP gaps fixed in commit `366d1eb` (recent LOG) — a new enum value added to one layer (writer) without the receiving layer (CHECK) being updated, fails closed at runtime. The fix is one ALTER, but the symptom looks like a deeper Rule-16 violation.

2. **Launch comes; first full-label reweigh adjustment lands; `createAdjustmentRecharge` is called against a full-label shipment with no saved PM; throws; recovery_status flips to `pending`; *every* sub-$10 adjustment piles into the Needs-Attention queue.** (Ties to B1.) The proposal's tier table reads as if ≤$10 is the happy path, but for the v1 launch traffic mix (full-label-dominant per LOG), the happy path is structurally unreachable. John opens the Reconciliation dashboard expecting "we auto-handled the small stuff" and instead sees every adjustment flagged for manual review. The recovery loop is a no-op on the dominant path until the full-label PI starts attaching customers — work that's not in this proposal's scope.

3. **A `shipment.invoice.created` is delivered, then `shipment.invoice.updated` is delivered ~minutes later with a corrected `adjustment_amount`; the dedup on `source_event_id` catches the second insert as a duplicate (because EP reuses the ShipmentInvoice id across the create/update pair) and SendMo silently keeps the *first* (often higher) delta.** (Ties to B2 + §2.3.) The proposal claims dedup-on-`source_event_id` but doesn't model the update path. EasyPost's `shipment.invoice.updated` is specifically the "we corrected the previous adjustment" event — silently dropping it leaves SendMo on a stale delta. Either the dedup must allow update-by-source_event_id (UPSERT against the existing row, in which case `carrier_adjustments` needs to leave Rule-16-style append-only behavior on the table) or it must key on `(source_event_id, version_number)` if EP exposes one. Worth resolving before the migration ships, because un-doing a UNIQUE constraint after data has accumulated is non-trivial.

4. **The cron sweep runs daily at 04:00 UTC and on its first weekly run discovers ~$200 of accumulated adjustments from the prior week's traffic; tries to fire `resolveRecovery` on each one synchronously inside the sweep loop; hits a Stripe rate-limit (or an Edge-function 60s timeout) midway through; partial state lands; manual fix-up consumes a half-day.** (Ties to §2.3 + N1.) The proposal describes the sweep as "list-and-diff" but doesn't model the rate-limit / timeout shape of "and recover N adjustments synchronously." Recommend: the sweep enqueues a `carrier_adjustments` row at `pending` and a separate worker (or a queue table) does the recovery — same pattern the refund-implementation proposal arrived at for the 3-week cron. Otherwise the first reconciliation run after a quiet weekend hits a wall.

5. **(Bonus) The `easypost_refund` ledger writer triple-call race writes nothing for the event because all three callers collide on the shared idempotency key and the first one's transaction was rolled back by an unrelated failure downstream.** (Ties to B4.) This is the same shape as the cluster of "writer A short-circuits, writer B never re-tries because the key is taken" bugs the sibling refund proposal called out — three writers + one shared key + no `ON CONFLICT DO NOTHING` story = ledger holes that only surface when the dashboard Net-margin column starts drifting in a way nobody can reproduce.

### What the proposal got right

- **The `shipment.invoice.created/updated` event correction is real.** I fetched docs.easypost.com/docs/events directly: both events are documented under "Shipment Invoice." §3.7's `tracker.updated`/`shipment.updated` reference is genuine drift; this proposal restores the intent with the right event names. That's exactly the "drift from the decided spec" framing the protocol asks for.
- **The Rule-16 extension is honestly declared, not snuck in.** §2.1 calls out the writer-map change as a deliberate amendment to Rule 16 and queues the PLAYBOOK update. That's the right posture — the sibling refund-implementation proposal got dinged for *not* extending Rule 16 (its workaround: only stripe-webhook writes, refund tool calls Stripe and lets the webhook land the row). This proposal is taking on a harder problem (writers across cancel/tracking/webhooks) and naming it.
- **The bidirectional ledger framing is the right architectural call.** Today's half-ledger (Stripe side only; EasyPost cost lives on `shipments.rate_cents`) silently shipped the comp-dogfooding leak in §1. Adding `label_cost` and `easypost_refund` as first-class ledger row types is the load-bearing fix; the Net-margin identity in the dashboard mockup falls out naturally and is the right invariant to surface to John.
- **The two-corrections-to-§3.7 framing is the protocol working.** Naming the drift (events) + naming John's parameter refinement ($1 floor + $1 handling fee) up front is exactly how the proposal-review protocol expects divergence to be handled — load-bearing institutional memory preserved, not silently overwritten.
- **Open Question #1 is the right question to pin to the top.** The author correctly identified the unknown that most threatens the proposal's premise — even though they under-stated the consequence (B1). The OQ#1 framing is what made the answer findable in 5 minutes of code reading.
- **The dashboard mockup matches the proposal's ledger identity.** I verified `previews/reconciliation-dashboard.html:233-252` — the column groupings (Timeline / Customer side / EasyPost side / Net margin) and the Net-margin formula at line 450 (`Paid − Stripe fee − Refund to customer + Adjustment collected − Chargeback − Label cost + Refund from EasyPost − Adjustment charged = Net margin`) line up exactly with §2.5's column list and §2.1's writer map. No mockup-vs-spec drift — the mockup is doing real architecture work.
- **The sibling refund proposal is correctly cross-linked.** §1 and Reconciliation section both name the dependency relationship — the bidirectional ledger this proposal builds is what gives the refund work a coherent surface for "did wallet credit land?" The two proposals are designed together; this one isn't trying to re-decide refund mechanics.
- **The "absorb negative deltas, absorb comps, flag no-PM" cases in §2.4 are honestly enumerated.** Easy to miss the negative-delta (carrier credit) path; the proposal calls it out and routes it correctly. Same for the comp case where there's no customer to recover from. That's the kind of completeness that prevents the "first weird real adjustment" launch bug.

## Author response

```yaml
responded_by: Claude Opus 4.7 — original author session, continuing with John
responded_at: 2026-05-22
```

The review is accepted in full. All four blockers are correct — B1 in particular found the unreachable-tier consequence the proposal under-stated; B2 and B3 are real ship-blockers I hedged when I should have stated them as hard `ALTER` prerequisites; B4 re-flattens an idempotency namespace the sibling refund-implementation proposal correctly kept distinct. Per point:

**B1 — Full-label saves no card → auto-recharge tier unreachable for the dominant flow.** ✅ Accept. **John decided option (a)** (Decision D1 below): extend `payments/index.ts` to save the card at full-label checkout. Brings the auto-recharge tier to functional parity across both flows from day one. Specifically:
- `payments/index.ts:208` extended to create-or-find a Stripe Customer for the buyer (new `getOrCreateCustomerForUser` shim, mirroring the flex/Pattern D path), attach the PM, and set `setup_future_usage: 'off_session'` on the PI.
- The `payment_methods` row lands via the existing `payment_method.attached` webhook (same wiring Phase B already built — `2026-05-13_phase-b-saved-cards-implementation`).
- Checkout UX adds a brief consent disclosure: *"We'll save your card to handle any carrier adjustments after delivery — usually a few dollars."* A single explanatory line near the Stripe Elements card form; saving is the default behaviour (the disclosure is the consent, plus Stripe's own off-session-usage TOS).
- **In scope for this proposal** — added to §3 as a new file-by-file item.

**B2 — `carrier_adjustments` already exists in migration 017 with a different shape; this is an `ALTER`, not a `CREATE`.** ✅ Accept. §3 Database is corrected: migration `032_carrier_adjustments_amendments_and_ledger_extensions.sql` with explicit:
- `ALTER TABLE carrier_adjustments ADD COLUMN claimed_weight_oz INTEGER, ADD COLUMN captured_weight_oz INTEGER, ADD COLUMN expected_credit_cents INTEGER;` *(last col per N4)*
- `DROP CONSTRAINT carrier_adjustments_recovery_status_check; ADD CONSTRAINT ... CHECK (recovery_status IN ('pending','recovered','absorbed','disputed','rejected'));`
- `CREATE UNIQUE INDEX carrier_adjustments_source_event_id_uidx ON carrier_adjustments (source_event_id) WHERE source_event_id IS NOT NULL;` — **partial UNIQUE; load-bearing for the dedup architecture.**

**B3 — `transactions.type` CHECK rejects the new types; ship-breaking on first deploy.** ✅ Accept. Same migration 032 explicitly:
- `ALTER TABLE transactions DROP CONSTRAINT transactions_type_check; ADD CONSTRAINT transactions_type_check CHECK (type IN ('charge','fee_stripe','refund','refund_fee_recovered','comp_grant','balance_topup','balance_topup_bonus','balance_redeem','carrier_adjustment','chargeback','adjustment','label_cost','easypost_refund'));`

The "if needed" hedge is rescinded — hard prerequisite, ordered before the writer-extensions deploy.

**B4 — `easypost_refund` idempotency key collapses across writers and re-voids.** ✅ Accept reviewer's option (b): key on the EasyPost **Refund object id** (`refundData.id` — `rfnd_…`) rather than the shipment id. Distinct per refund event, naturally writer-safe, matches §2.3's ShipmentInvoice pattern.

**N1 — Sweep should re-check existing rows for stuck recovery_status.** ✅ Accept. The sweep's "INSERT … ON UNIQUE skip" path extends: for an existing row, re-compute the policy's expected `recovery_status` and re-fire `resolveRecovery` on drift (typically `pending` from a crashed webhook handler). Idempotent because the recharge key is per-`carrier_adjustment_id`.

**N2 — Cap-math race condition.** ✅ Accept. `resolveRecovery` reads the per-shipment / per-card / per-user sums inside a transaction with `SELECT … FOR UPDATE` on the shipment row. Two near-simultaneous adjustments serialize.

**N3 — Dispute-window aging on flagged adjustments.** ✅ Accept. Dashboard's Needs-Attention row for >$10 adjustments shows a *"Dispute window: X days remaining"* indicator (carrier-aware: USPS 60d, UPS 120d, FedEx 90d) computed from `carrier_adjustments.created_at`. Past-deadline rows render red.

**N4 — Dispute-outcome tracking + sweep pattern-match.** ✅ Accept. `expected_credit_cents` column (added in B2's migration). When admin marks `disputed`, the column is populated; the sweep pattern-matches later unexplained `+wallet` credits against open `disputed` rows by amount + carrier + shipment.

**N5 — Customer-notification send-site.** ✅ Accept. Send happens in `_shared/adjustments.ts:resolveRecovery` immediately after a successful auto-recharge PI returns `'succeeded'`. `adjustments.ts` imports `sendEmail` from `_shared/resend.ts` and the new `carrierAdjustmentEmail` from `_shared/email-templates.ts`. Surface noted in §3.

**Nits.** ✅ Accept all. Drop the "?" hedges to fact statements. Retry counter on the recharge idempotency key (`adjustment_${shipment_id}_${carrier_adjustment_id}_${attempt}`) so a failed first attempt doesn't dedup the retry. `resolveRecovery` signature widened to `(shipment, deltaCents, paymentContext)` where `paymentContext` carries `payment_method_id`, `user_id`, `customer_id` (derived from the shipment's PI). `GET /v2/users` `balance` field cited from EasyPost docs. PLAYBOOK Rule 16 amendment lands as a concrete Edit in §3. React port honors the design-token system; mockup green is mockup-only.

**Predicted pitfalls.** Pitfall 1 (CHECK red on first deploy) → fixed by B3. Pitfall 2 (every full-label flagged) → eliminated by D1 (option a). Pitfall 3 (`shipment.invoice.updated` overwrite vs. dedup) → resolved: the webhook handler UPSERTs on `source_event_id` for the `.updated` event (not pure dedup-skip), so a corrected `adjustment_amount` lands cleanly. Pitfall 4 (sweep tries N synchronous recharges → rate-limit / timeout) → accept: the sweep INSERTs rows at `recovery_status='pending'` and a separate per-row recovery worker fires (mirrors the sibling refund-impl's worker pattern). Pitfall 5 (triple-writer race for `easypost_refund`) → fixed by B4's per-refund-object key.

No author-vs-reviewer disagreements remain — no "Tradeoffs for John" section.

## Decision

**Decided 2026-05-22 by John.** Outcome: **approve-with-changes** — all four blockers and five non-blockers accepted; one material scope expansion via D1 (B1 resolution).

**D1 — Full-label save-card extension is in scope (B1 option a).** `payments/index.ts` extends to attach a Stripe Customer + the PM + `setup_future_usage: 'off_session'`, with a brief checkout consent disclosure ("We'll save your card to handle any carrier adjustments — usually a few dollars"). Leverages decided Phase B saved-cards groundwork (`2026-05-13_phase-b-saved-cards-implementation`). Brings auto-recharge to functional parity across both flex and full-label from day one — no manual queue for sub-$10 full-label adjustments at launch.

**D2 — All technical fixes accepted (B2 / B3 / B4 / N1–N5 / Nits).** Folded into §3:
- Migration 032: `ALTER` (not `CREATE`) on `carrier_adjustments` — add weight columns + `expected_credit_cents`, swap `recovery_status` CHECK to admit `'rejected'`, partial UNIQUE on `source_event_id`. Plus the explicit `transactions.type` CHECK swap to admit `label_cost` and `easypost_refund`.
- Per-refund-object idempotency keying for `easypost_refund` rows.
- `SELECT … FOR UPDATE` serialization in `resolveRecovery` cap-math.
- Sweep drift-detection on existing rows.
- Dispute-window countdown on flagged Needs-Attention items.
- Explicit email send-site in `_shared/adjustments.ts`.
- Retry-counter idempotency for recharge attempts.

**D3 — Launch-blocker scope confirmed.** P1 = everything in this proposal (detection + bidirectional ledger + tiered recovery *with* full-label save-card + reconciliation sweep + admin dashboard + the three lifecycle emails for refunds from the sibling proposal). No internal P1/P2 split — the entire bundle gates customer launch per John 2026-05-22. The comp-dogfooding phase can begin once detection + recording + reconciliation land (a subset that doesn't depend on D1); the full bundle is the gate for paying customers.

**Next:** implementation begins on the consolidated P1 bundle (this proposal + the sibling refund-implementation proposal). Per protocol, lands behind a code-review pass; LOG entries cross-link this decided proposal. This proposal is now `decided` and closed.
