# Handoff — pre-launch P1 build

> Paste the relevant **Package** section's "spawn prompt" into a fresh Claude Code
> session at `~/AI Brain/sendmo/`. This doc partitions the launch-blocking
> implementation into **5 self-contained packages** so agents can work in waves.
> Author's context window is full — this is the dispatch artifact.

---

## Where things stand (2026-05-23)

Three big design loops landed in the last 72 hours:

| Decided proposal | What it decided | Status |
|---|---|---|
| [`2026-05-21_refund-flow-review`](2026-05-21_refund-flow-review_reviewed-2026-05-21_decided-2026-05-21.md) | Two-step (EasyPost-gated) refund, terminal "denied" state, partial-capable, admin `/refunds` tool as go-live blocker, three lifecycle emails. | decided |
| [`2026-05-21_refund-system-implementation`](2026-05-21_refund-system-implementation_reviewed-2026-05-21_decided-2026-05-22.md) | The /refunds Edge Function, partial plumbing, `charge.refund.updated` failure detection in P1; emails + cron sweep + admin queue in P2. | decided |
| [`2026-05-22_reconciliation-and-carrier-adjustments`](2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_decided-2026-05-22.md) | Bidirectional ledger + `shipment.invoice.*` webhook + tiered recovery ($1 floor / $1 fee / $10 flag) + reconciliation sweep + admin dashboard + **D1: full-label save-card extension** in `payments/`. | decided |

Already shipped to `main` (parallel risk-intel work — out of these packages' scope but coordinate against):
- **`397530c`** — Account Budget, PM-add breaker, Radar-block routing, B2 Radar metadata, $50 default per-shipment cap, migration 031 (applied to prod ✓).
- **`dbf2254`** — Admin Account-Budget setter UI + PAYMENTS.md §10 + handoff doc.
- **`60e09b3`** — 16 unit + 3 e2e tests for risk-intel.
- **`f2aecae`** — `RISKMANAGEMENT.html` reference page + SPEC §13.2 pointer.

**Migration numbering:** risk-intel shipped 031; the next free number for H1's migration is **032**.

---

## Read first (every package agent — common reads)

1. **`~/AI Brain/sendmo/CLAUDE.md`** + `PLAYBOOK.md` — project entry + rules. **Especially Rule 16** (`transactions` is append-only, sole-writer; the two decided proposals here amend the writer map — read the amendments).
2. **`~/AI Brain/sendmo/PAYMENTS.md`** — operational reference, all 10 sections. §10 covers the risk-intel that just shipped and matters for coordination.
3. **`~/AI Brain/sendmo/RISKMANAGEMENT.html`** — browser-friendly overview of the risk-intel controls that are already live.
4. **The decided proposal(s) cited in the package** — each package lists which ones to read in full.
5. **`~/AI Brain/sendmo/LOG.md`** top entries (last ~10) — recent shipped work + the test-writing pattern (`import type` from `_shared/` for Vitest; see 2026-05-23 entry).

---

## Dependency graph + wave plan

```
H1 (ledger foundation)
  ├──> H2 (carrier-adjustment recovery)
  └──> H4 (reconciliation dashboard)

H3 (refund /refunds tool) ──> H5 (refund emails + cron + queue)

H4 coordinates with H3 on Admin.tsx (both add UI surfaces).
```

**Wave 1 (parallel, day-1):** H1 + H3
**Wave 2 (after H1 lands):** H2
**Wave 3 (after H1 + H3 land):** H4, then H5

Total: ~2–3 weeks if 2 agents alternate waves.

---

## Package H1 — Bidirectional ledger foundation

**Goal:** Migration 032 + ledger writers that record `label_cost` (SendMo → EasyPost) and `easypost_refund` (EasyPost → SendMo) as first-class `transactions` rows.

**Effort:** ~2–3 days. **Depends on:** nothing (must land first). **Blocks:** H2, H4.

**Read first:** decided proposal `2026-05-22_reconciliation-and-carrier-adjustments_..._decided.md` — §2.1 (writer map), §2.2 (carrier_adjustments shape), §3 Database + Edge Functions sections, plus the `## Decision` D2 list.

**Build:**
- **`supabase/migrations/032_carrier_adjustments_amendments_and_ledger_extensions.sql`** (NEW):
  - `ALTER TABLE carrier_adjustments ADD COLUMN claimed_weight_oz INT, ADD COLUMN captured_weight_oz INT, ADD COLUMN expected_credit_cents INT;`
  - `DROP CONSTRAINT carrier_adjustments_recovery_status_check; ADD CONSTRAINT … CHECK (recovery_status IN ('pending','recovered','absorbed','disputed','rejected'));` (adds `'rejected'`)
  - `CREATE UNIQUE INDEX carrier_adjustments_source_event_id_uidx ON carrier_adjustments (source_event_id) WHERE source_event_id IS NOT NULL;` *(partial UNIQUE — load-bearing)*
  - `ALTER TABLE transactions DROP CONSTRAINT transactions_type_check; ADD CONSTRAINT … CHECK (type IN ('charge','fee_stripe','refund','refund_fee_recovered','comp_grant','balance_topup','balance_topup_bonus','balance_redeem','carrier_adjustment','chargeback','adjustment','label_cost','easypost_refund'));` *(admits the two new types)*
- **`supabase/functions/labels/index.ts`**: at successful EasyPost label buy (after the `admin_insert_shipment` call), INSERT one `transactions` row — `type='label_cost'`, `amount_cents = -rate_cents`, `idempotency_key='label_cost_${easypost_shipment_id}'`, `mode = is_test ? 'test' : 'live'`, `funding_source = isComp ? 'comp' : null`.
- **`supabase/functions/cancel-label/index.ts`** *(no change to ledger here — cancel-label submits the void; the credit lands later)*. Just verify nothing here writes `easypost_refund` (it doesn't today; just don't add it).
- **`supabase/functions/tracking/index.ts`** (~line 240, the refund-poll branch where `epRefundStatus === 'refunded'` and amount confirmed): INSERT `transactions` row `type='easypost_refund'`, `amount_cents = +refund_amount_cents` (positive). **Idempotency key: keyed on EasyPost Refund object id (`rfnd_…`)**, e.g. `easypost_refund_${refundObject.id}`. (Per B4 fix in the decided proposal — NOT the shipment id.)
- **`supabase/functions/webhooks/index.ts`** `refund.successful` arm: same INSERT, same idempotency key shape (`easypost_refund_${refundObject.id}`). Three writers (tracking poll + this webhook + a hypothetical cancel retry) all converge on the same key — UNIQUE collision = safe no-op.
- **PLAYBOOK.md** — amend Rule 16's writer-map table to add the three new rows (`label_cost`, `easypost_refund`, `carrier_adjustment`) and their writers, per §2.1 of the decided proposal.

**Tests:**
- `tests/unit/ledger-writes.test.ts` — for each writer, assert the row shape + idempotency-key behavior (re-call → no duplicate).
- Use the **`import type`** pattern for `SupabaseClient` (see 2026-05-23 LOG — `tests/unit/budget.test.ts` is the precedent).

**Verification:** Apply migration 032 to a fresh DB; buy a comp label → assert `label_cost` row; cancel a (live) label and let EasyPost confirm → assert `easypost_refund` row. Verify `_prisma_migrations` table is clean (no `finished_at IS NULL`).

**Coordination notes:**
- **No file conflict** with H3 (refunds tool touches different files).
- H2 + H4 wait for this. Push as a single coherent commit — the deploy workflow's `git diff HEAD^ HEAD` only sees the tip commit, so one push = one deploy.
- **Apply migration 032 to prod BEFORE pushing the edge-function code** — same deploy-order lesson from migration 031 (see followups handoff "Critical: deploy-order check").

**Spawn prompt:**
> You're picking up Handoff Package **H1 — Bidirectional ledger foundation** from `~/AI Brain/sendmo/proposals/2026-05-23_pre-launch-handoff-plan.md`. Read that doc's "Read first" + the H1 section, plus the decided proposal `2026-05-22_reconciliation-and-carrier-adjustments_..._decided.md` §2.1 / §2.2 / §3 Database + Edge Functions sections + `## Decision` D2 (the blocker fixes). Build migration 032 + the ledger writers. Apply 032 to prod first, then push the edge-function code as a single commit. End with a LOG.md entry cross-linking the decided proposal + the migration ID. Don't touch H2, H3, H4, H5 scope.

---

## Package H2 — Carrier-adjustment detection + recovery + full-label save-card

**Goal:** the `shipment.invoice.*` webhook handler, the tiered recovery engine (`$1` floor / `$1` fee / `$10` flag / caps), `createAdjustmentRecharge`, and **D1 — extending `payments/index.ts` to save the card** so full-label adjustments can auto-recharge.

**Effort:** ~4–5 days (the biggest package). **Depends on:** H1 must land. **Blocks:** (full launch readiness).

**Read first:** decided `2026-05-22_reconciliation-and-carrier-adjustments_..._decided.md` end-to-end (especially §2.3 detection, §2.4 recovery, §3 the `_shared/adjustments.ts` + `_shared/stripe.ts` + `payments/index.ts` + `webhooks/index.ts` items, and `## Decision` D1). Plus PAYMENTS.md §10 (Account Budget / Radar interaction). Plus the dashboard mockup `previews/reconciliation-dashboard.html` to ground the policy values.

**Build:**
- **`supabase/functions/_shared/adjustments.ts`** (NEW): `resolveRecovery(shipment, deltaCents, paymentContext)` — tiered decision with the $1/$10 thresholds + the three caps (per-shipment $10 lifetime, per-card $20/24h, per-user $50/7d). Reads sums inside a transaction with `SELECT … FOR UPDATE` on the shipment row (N2 fix). Returns `{ decision, amount_cents, blocked_by_cap?, reason }`.
- **`supabase/functions/_shared/stripe.ts`** (extend): `createAdjustmentRecharge({ shipment, deltaCents, carrierAdjustmentId, attempt, paymentMethodId, customerId, liveMode })` — wraps `createOffSessionShipmentPI` with the `+$1` handling fee and the idempotency key `adjustment_${shipment_id}_${carrier_adjustment_id}_${attempt}` (retry-safe).
- **`supabase/functions/webhooks/index.ts`** — new arm: `if (description === 'shipment.invoice.created' || 'shipment.invoice.updated')` → resolve shipment by `result.shipment_id`, UPSERT `carrier_adjustments` on `source_event_id` (the `.updated` event corrects prior amounts — see Pitfall 3 in the proposal's review), INSERT `transactions.carrier_adjustment` row, call `resolveRecovery` → fire `createAdjustmentRecharge` if `decision === 'recharge'`, send `carrierAdjustmentEmail` on success.
- **`supabase/functions/payments/index.ts`** — **D1: extend the full-label PI create.**
  - Add `getOrCreateCustomerForUser(userId, mode)` helper (mirror the flex/Pattern-D path).
  - On `createPaymentIntent` call: add `customer: customerId`, `setup_future_usage: 'off_session'`.
  - **Ordering** (critical): `checkAccountBudget` (already shipped — keep) → `getOrCreateCustomerForUser` → `createPaymentIntent`. Risk-intel's budget check MUST run before the PI create per §10.2.
  - **Bundle Job 3** (risk-intel deferred): fetch the EasyPost shipment by `easypost_shipment_id` mid-flow, map `to_address` into Stripe's `shipping` field, pass to `createPaymentIntent`. One EasyPost GET; saves a second pass at this file.
  - **Checkout consent disclosure:** add a brief explanatory line near the Stripe Elements card form: *"We'll save your card to handle any carrier adjustments after delivery — usually a few dollars."* Frontend change in whichever component renders that step.
- **`supabase/functions/_shared/email-templates.ts`** — add `carrierAdjustmentEmail({ amount_cents, fee_cents, carrier, reason, public_code, tracking_url })`.
- **Send-site:** in `_shared/adjustments.ts:resolveRecovery` immediately after a successful `createAdjustmentRecharge` returns `'succeeded'` (N5).

**Tests:**
- `tests/unit/adjustments.test.ts` — every tier (≤$1 absorb, $1.01–$10 recharge, >$10 flag, negative delta, comp absorb, no-card flag); each cap; race-condition guard via mock concurrent calls.
- `tests/integration/shipment-invoice-webhook.test.ts` — mock the EasyPost payload → assert `carrier_adjustments` + `transactions` rows + `recovery_status`.
- `tests/e2e/full-label-save-card.spec.ts` — buy a full-label, assert `payment_methods` row written.

**Verification:** Test mode — synthetic `shipment.invoice.created` POST → recovery fires per tier → email captured. Buy a full-label end-to-end → Stripe Dashboard shows saved card on the Customer + the consent flow. Then the live smoke test (Job 3 Step 4 — John's task).

**Coordination notes:**
- **`payments/index.ts` is shared with risk-intel's budget/Radar work.** Read the current file carefully; preserve `checkAccountBudget` ordering. Don't bypass it.
- **`webhooks/index.ts` is shared with risk-intel's Radar-block routing.** New arm is additive — distinct event type. Don't break the existing `tracker.updated` / `refund.successful` / Radar branches.
- **`_shared/stripe.ts` is shared with risk-intel's `retrieveCharge`** — purely additive, no overlap.
- **Adjustment recharges bypass `checkAccountBudget`** per the build-LOG amendment from the proposal close-out — the adjustment-specific caps govern; document this in the LOG entry that lands H2.

**Spawn prompt:**
> You're picking up Handoff Package **H2 — Carrier-adjustment detection + recovery + full-label save-card** from `~/AI Brain/sendmo/proposals/2026-05-23_pre-launch-handoff-plan.md`. **Confirm H1 has landed first** (migration 032 applied + `label_cost`/`easypost_refund` writers deployed). Read the H1 + H2 sections, the full decided proposal `2026-05-22_reconciliation-and-carrier-adjustments_..._decided.md`, PAYMENTS.md §10 (risk-intel context), and the dashboard mockup `previews/reconciliation-dashboard.html`. Build per the H2 file-by-file plan. Bundle the risk-intel Job 3 `shipping` field while you're in `payments/index.ts`. End with a LOG.md entry cross-linking the decided proposal + noting the "adjustment recharges bypass `checkAccountBudget`" design call.

---

## Package H3 — Refund admin `/refunds` tool + partial-refund plumbing

**Goal:** the launch-blocker piece of the refund implementation — admin `/refunds` Edge Function, per-PI partial-refund plumbing, `charge.refund.updated` failure-detection handler.

**Effort:** ~2–3 days. **Depends on:** nothing in this set (independent code paths). **Blocks:** H5.

**Read first:** decided `2026-05-21_refund-system-implementation_..._decided-2026-05-22.md` end-to-end (Architecture, File-by-file plan, especially the `## Author response` B1/B2/B3/B4 fixes and `## Decision` D1).

**Build:**
- **`supabase/functions/_shared/refunds.ts`** (NEW): `getRefundableBalanceForPI(supabase, stripe_payment_intent_id)` — sums `transactions` rows whose `stripe_intent_id` matches the PI (per-PI scoping per B1 fix).
- **`supabase/functions/refunds/index.ts`** (NEW): admin endpoint. Body `{ shipment_id, chargeTransactionId, amount_cents?, reason }`. Auth via `_shared/auth.ts:requireAdmin`. Resolves PI from the named charge row (B2 fix), computes remaining via the helper, calls `createRefund` with `idempotency_key='refund_admin_${shipment_id}_${refundRequestId}'`, returns expected post-refund balance for optimistic UI.
- **`supabase/config.toml`** — add `[functions.refunds]` block with `verify_jwt = true`.
- **`src/lib/refundService.ts`** — replace the throwing stub. `RefundRequest` type updates: keep `chargeTransactionId` as required, `amountCents` becomes optional, `reason` widens to Stripe's enum.
- **`supabase/functions/tracking/index.ts`** (~line 223) and **`supabase/functions/webhooks/index.ts`** `refund.successful` arm (~line 269): existing `createRefund` calls gain `amount_cents = getRefundableBalanceForPI(...)` (the N3 fix — partial-aware).
- **`supabase/functions/stripe-webhook/index.ts`** — NEW `case 'charge.refund.updated':` — on `refund.status === 'failed'` (the customer's card couldn't accept the refund), write a `severity='error'` `event_logs` row + an alert email to John. **Records the failure** — no customer-side comms per D1 (those are P2).
- **`src/components/admin/RefundModal.tsx`** (NEW) + **`src/pages/Admin.tsx`** extension: "Refund" button on a shipment row → modal (amount prefilled to remaining, editable, reason dropdown) → calls `processRefund`. Disables button ~10s after a successful call (N1 — async ledger window).

**Tests:**
- `tests/unit/getRefundableBalanceForPI.test.ts` — full / partial / fully-refunded / no-charge / over-balance.
- `tests/integration/refunds-endpoint.test.ts` — full + partial + over-balance + non-admin 403.
- `tests/e2e/admin-refund-flow.spec.ts` — admin issues a partial refund via the modal.

**Verification:** Test-mode Stripe PI → admin issues partial refund → Stripe Dashboard shows partial, `transactions` ledger gets the `−refund` row (written by existing `charge.refunded` webhook — Rule 16 honored). Cancel a shipment with a prior partial admin refund → cancel-path `createRefund` fires for remaining only (the N3 race). Trigger `charge.refund.updated` with `status='failed'` → `event_logs` error row appears + admin alert.

**Coordination notes:**
- **`Admin.tsx`** is shared with H4 (Reconciliation tab) and the existing Account-Budget setter. All three coexist — the Refund button is a row-level action; the Reconciliation tab is a top-level tab; the Budget setter is a collapsible form. No conflict, but agents should rebase if Admin.tsx changed since they branched.
- **`stripe-webhook/index.ts`** shared with risk-intel's Radar-block routing — new `charge.refund.updated` case is additive.

**Spawn prompt:**
> You're picking up Handoff Package **H3 — Refund admin `/refunds` tool + partial-refund plumbing** from `~/AI Brain/sendmo/proposals/2026-05-23_pre-launch-handoff-plan.md`. Independent of H1/H2 in code paths; can start day one. Read the H3 section + the decided proposal `2026-05-21_refund-system-implementation_..._decided-2026-05-22.md` end-to-end. Build per the H3 plan. End with a LOG entry cross-linking the decided proposal. Don't touch H5 scope (emails / cron / rejected queue) — that's a separate package.

---

## Package H4 — Reconciliation dashboard + sweep + admin actions

**Goal:** the `/admin` Reconciliation tab + the shipment detail view + the `reconciliation-sweep` Edge Function (daily + weekly Reports) + the `admin-recon-action` endpoint (Dispute / Re-charge / Absorb).

**Effort:** ~4–5 days. **Depends on:** H1 (the ledger writers); coordinates with H3 on Admin.tsx.

**Read first:** decided `2026-05-22_reconciliation-and-carrier-adjustments_..._decided.md` — §2.5 admin dashboard, §3 reconciliation-sweep / reconciliation-report / admin-recon-action Edge Functions. The mockups: `previews/reconciliation-dashboard.html` + `previews/shipment-detail.html` — **port these to React preserving the column structure and the Net-margin identity in the legend.**

**Build:**
- **`supabase/functions/reconciliation-report/index.ts`** (NEW, admin): GET endpoint. Joins `shipments` ↔ `transactions` ↔ `carrier_adjustments` ↔ `refunds` for the period. Returns JSON for the dashboard — summary cards + per-shipment rows (computed Net margin per the identity) + Needs-Attention items.
- **`supabase/functions/reconciliation-sweep/index.ts`** (NEW, admin + scheduled): `mode=daily` (list-and-diff since last run via `GET /v2/shipments?start_datetime=…&page_size=100` + `GET /v2/refunds?…`); `mode=weekly` (generate `shipment` + `payment_log` reports via the Reports API, ≤31-day windows, poll until `available`, download CSV, parse, diff). Mismatches → `event_logs`. For adjustments found in sweep but not via webhook → call `_shared/adjustments.ts:resolveRecovery` (from H2). **N1 fix:** for existing `carrier_adjustments` rows with `recovery_status='pending'`, re-fire `resolveRecovery` (idempotent — recharge key is per-adjustment-id).
- **`supabase/functions/admin-recon-action/index.ts`** (NEW, admin): POST endpoint for the dashboard action buttons. Routes: `dispute` (sets `recovery_status='disputed'`, captures `expected_credit_cents`), `recharge` (calls `createAdjustmentRecharge` even for >$10), `absorb` (sets `recovery_status='absorbed'`).
- **`supabase/config.toml`** — three new function blocks (`verify_jwt = true` each).
- **`src/pages/AdminReconciliation.tsx`** (NEW): port the dashboard mockup to React. Fetches from `/functions/v1/reconciliation-report`. Wires Needs-Attention buttons to `/functions/v1/admin-recon-action`. Honor the app's design tokens (the mockup's green is mockup-only).
- **`src/pages/AdminShipmentDetail.tsx`** (NEW): port the detail-view mockup. Route `/admin/shipments/:public_code`.
- **`src/pages/Admin.tsx`** — add the Reconciliation tab as a third tab alongside Labels / Links. **Small bonus** (N1 deferred-nicety from risk-intel handoff Job 1): show the per-owner current budget in the Reconciliation/Links view since `admin-report` is already being extended for reconciliation data — closes that gap.
- **pg_cron registration:** daily at 04:00 UTC for incremental sweep; weekly Sundays for bulk. Migration or one-off SQL.

**Tests:**
- `tests/unit/reconciliation-math.test.ts` — Net-margin identity against fixtures covering every combination.
- `tests/integration/reconciliation-sweep.test.ts` — seed 50 shipments + 10 adjustments + 5 refunds + 1 chargeback → assert zero false mismatches.
- `tests/e2e/admin-reconciliation.spec.ts` — admin opens the tab, sees summary populated, clicks a Needs-Attention action.

**Verification:** Run the dashboard against current prod data → 31 known shipments reconcile. Run the weekly sweep → `payment_log.delta_fee` rows match `carrier_adjustments` 1-to-1.

**Coordination notes:**
- **`Admin.tsx`** shared with H3 (Refund button) + existing Account-Budget setter. Rebase if H3 lands first.
- **The dashboard's Chargeback column** assumes `transactions.type='chargeback'` rows are written by the existing `stripe-webhook` `charge.dispute.created` handler — verify before relying on it (read `stripe-webhook/index.ts` ~line 594).
- The reviewer's N3 finding — **add "Dispute window: X days remaining"** to >$10 flagged Needs-Attention rows (USPS 60d, UPS 120d, FedEx 90d, computed from `carrier_adjustments.created_at`).

**Spawn prompt:**
> You're picking up Handoff Package **H4 — Reconciliation dashboard + sweep + admin actions** from `~/AI Brain/sendmo/proposals/2026-05-23_pre-launch-handoff-plan.md`. **Confirm H1 has landed** (the ledger writers); H3 ideally landed too so Admin.tsx coordination is one-pass. Read the H4 section, the full decided proposal `2026-05-22_reconciliation-and-carrier-adjustments_..._decided.md`, and **open `previews/reconciliation-dashboard.html` + `previews/shipment-detail.html` in a browser** to ground the design — port them to React preserving the column structure + Net-margin identity. End with LOG entry cross-linking the decided proposal.

---

## Package H5 — Refund lifecycle emails + cron sweep + admin rejected queue

**Goal:** the P2 of refund implementation — three customer-facing emails at refund-status transitions, the 21-day cron sweep that finalizes stuck `submitted` refunds, and a rejected-refunds view in the admin Reconciliation tab.

**Effort:** ~2–3 days. **Depends on:** H3 (refund state machine).

**Read first:** decided `2026-05-21_refund-system-implementation_..._decided-2026-05-22.md` — `## Decision` D3 (cron), D4 (terminal `rejected`), **D5 (the three emails — full approved copy is referenced)**. The customer-facing word: **"Refund unsuccessful."**

**Build:**
- **`supabase/functions/_shared/email-templates.ts`** — add three templates:
  - `refundSubmittedEmail` — fires at `refund_status → submitted` (Email A; sets the 1–2-week expectation; **carrier-aware** USPS-slow vs UPS/FedEx-faster).
  - `refundCompletedEmail` — fires at `refund_status → refunded` (Email B; 5–10 business days bank-posting note).
  - `refundUnsuccessfulEmail` — fires at `refund_status → rejected` (Email C; soft framing per John's draft).
  Full approved copy is in the decided proposal's `## Author response` (B3, D5) — use it verbatim or near-verbatim.
- **Send-sites + dedup:**
  - Email A: `supabase/functions/cancel-label/index.ts` after the void is submitted.
  - Email B: `supabase/functions/stripe-webhook/index.ts` `charge.refunded` handler, after the `refund_status` advances `submitted → refunded`.
  - Email C: wherever `rejected` is set — `tracking/index.ts:290` poll branch + the new cron-sweep below.
  - Dedup keyed per refund event: `notifications_log` row with `(shipment_id, event_type='refund.X', stripe_refund_id)`.
- **`supabase/functions/cron-refund-sweep/index.ts`** (NEW, admin + scheduled): finds `refund_status='submitted'` shipments older than 21 days → polls EasyPost one last time → resolves:
  - EasyPost `refunded` → fire missed `createRefund` (catches missed webhook).
  - EasyPost `rejected` → mark `refund_status='rejected'` + send Email C.
  - EasyPost still `submitted` → mark `refund_status='rejected'` (timeout terminal), leave `easypost_refund_status='submitted'` as the timeout signature + send Email C.
- **pg_cron registration:** daily at 04:30 UTC (offset from H4's 04:00 to avoid concurrent sweep load).
- **`src/pages/AdminReconciliation.tsx`** (extends H4's work): add a "Rejected refunds" filter/sub-view showing all `refund_status='rejected'` shipments. Acts as the manual queue when an EasyPost rejection or timeout needs your eyes.

**Tests:**
- `tests/unit/refund-emails.test.ts` — each template renders, carrier-aware lines correct, `tracking_url` correct.
- `tests/integration/refund-cron-sweep.test.ts` — fixtures for each branch (refunded / rejected / timeout) → assert state machine.

**Verification:** Cancel a test-mode shipment with a Stripe PI → Email A captured. Simulate `charge.refunded` → Email B captured. Force a rejection in the tracking poll → Email C captured. Time-travel a `refund_status='submitted'` row 22 days back → run cron-sweep → row terminates correctly.

**Coordination notes:**
- **`_shared/email-templates.ts`** shared with risk-intel's `budgetReachedEmail` / `radarBlockedPayerEmail` and H2's `carrierAdjustmentEmail`. All additive.
- **`stripe-webhook/index.ts`** shared with H3 (`charge.refund.updated`) and risk-intel (Radar-block routing). Email B is added inside the existing `charge.refunded` arm — be careful not to break Radar-block logic.

**Spawn prompt:**
> You're picking up Handoff Package **H5 — Refund lifecycle emails + cron sweep + admin rejected queue** from `~/AI Brain/sendmo/proposals/2026-05-23_pre-launch-handoff-plan.md`. **Confirm H3 has landed** (the refund state machine). Read the H5 section + the decided proposal `2026-05-21_refund-system-implementation_..._decided-2026-05-22.md`, especially the `## Author response` B3/D5 (approved email copy). Build per the H5 plan. End with LOG entry cross-linking the decided proposal.

---

## John's parallel tasks (not agent work)

- **Risk-intel B1** — Stripe Dashboard config (block rules + card-testing protection, both modes). ~1 hr. From the risk-intel followups handoff Job 4.
- **Job 3 Step 4** — Live smoke test (buy one real ~$7–12 label end-to-end after H2 lands). Was task #4 in the original task list.
- **Job 3 Step 5** — Live refund test (cancel + refund a live label after H3 lands).
- **Wrap-up** — LOG entry crossing the launch line + supersede `proposals/2026-05-19_payments-golive-followups-handoff.md` (the original Job 3 handoff that started this whole arc).

---

## Deferred / coverage-owed (not launch-blocking)

A separate fast-follow agent can pick these up after launch:

- **`tests/e2e/label-flow.spec.ts`** — pre-existing breakage from the 2026-05-20 `/label-test` 5-step refactor. Documented in the 2026-05-23 LOG entry.
- **Risk-intel T3/T4** — `flex-budget-breach.spec.ts` and `flex-radar-block.spec.ts`. Both need a sender-wizard mock harness that doesn't exist yet (mocks for `links`/`autocomplete`/`place-details`/`rates`). Each is ~50 LOC once the harness exists.
- **Real-service B4 spec** — Stripe test card `4100 0000 0000 0019` triggers a Radar block; needs a `buy_label_debug.spec.ts`-style real-service spec (outside the mocked default suite per `playwright.config.ts` `testIgnore`).

---

## Reference architecture

The full pre-launch system, once all five packages land:

```
Customer pays → Stripe charge → [Account Budget gate (risk-intel, already live)]
                             ↓
              [Stripe Customer + saved PM (H2 D1)]
                             ↓
              [transactions.charge + .fee_stripe rows]

EasyPost label buy → transactions.label_cost (H1) → wallet debit

Carrier reweighs ↓ days later
              shipment.invoice.created (H2 webhook arm)
              → carrier_adjustments row
              → resolveRecovery (H2)
                  ├─ ≤$1 absorb
                  ├─ $1–$10 auto-recharge (createAdjustmentRecharge + $1 fee)
                  └─ >$10 flag → Admin Reconciliation tab (H4)

Customer cancels → cancel-label submits EP void
              ↓ days/weeks later
              EP confirms refund:
                  → tracking poll (H1 writes easypost_refund row)
                  → webhook (H1 writes easypost_refund row, idempotent by Refund object id)
                  → /refunds tool (H3) for admin goodwill refunds
              → charge.refunded webhook → refund row + email B (H5)
              → charge.refund.updated → if failed, alert (H3 detection)

Daily: reconciliation-sweep (H4) + refund-cron-sweep (H5) catch anything missed.

Admin: Reconciliation tab (H4) + Refund button (H3) + Account-Budget setter (already live).
```

---

## Spawn-prompt template (generic — for any package)

> You're picking up Handoff Package **HX** from `~/AI Brain/sendmo/proposals/2026-05-23_pre-launch-handoff-plan.md`. Read that doc's framing + the HX section + the decided proposal(s) it cites. Verify HX's dependencies have landed (per the dependency graph). Build per the file-by-file plan. Write the listed tests. Verify per the listed steps. End with a LOG.md entry that cross-links the decided proposal + names what shipped. Don't expand into other packages' scope.

---

*Master plan ends here. Author's session at end of context. All decisions captured in the cited decided proposals; this doc is the dispatch artifact.*
