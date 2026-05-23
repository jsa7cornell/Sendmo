# Handoff — Payments risk-intelligence follow-ups

> Paste the body below into a fresh Claude Code session at `~/AI Brain/sendmo/`.
> This continues the payments work after the 2026-05-22 risk-intelligence push
> (commit `397530c`). The decided proposal shipped end-to-end; what remains is
> a small set of fast-follows.

---

## Where things stand (2026-05-22 end of session)

The payments risk-intelligence proposal
([`proposals/2026-05-21_payments-risk-intelligence_reviewed-2026-05-22_decided-2026-05-22.md`](2026-05-21_payments-risk-intelligence_reviewed-2026-05-22_decided-2026-05-22.md))
went from triage → proposal → fresh-eyes review (verdict `approve-with-changes`)
→ rework → decided → implementation (Increments 1–3) → independent code review
(`approve-with-changes`, 2 blocking findings fixed) → push (`397530c`) — all
in one stretch. The architectural summary lives in
[`PAYMENTS.md`](../PAYMENTS.md) **§10 Risk intelligence (2026-05-22)** — read
that first.

**What shipped (already on `main`, push `397530c`):**
- **Migration 031** — `sendmo_links.max_price_cents` default $100→$50;
  `profiles.daily_budget_cents` / `weekly_budget_cents` defaults $200/$500;
  `set_account_budget` RPC (admin-only); column-level `REVOKE UPDATE` so the
  "Users can update own profile" RLS policy doesn't let users self-raise;
  `link_state_events.event` enum gains `radar_blocked`.
- **B2** — Radar metadata (`txn_kind`, `link_type`, sender IP, sender/recipient
  emails) + `shipping` on the flex off_session PI.
- **B5** — `_shared/budget.ts` `checkAccountBudget()`; budget enforcement in
  `labels/` (flex) and `payments/` (full-label, authenticated); PM-add breaker
  (5/day) in `payment-methods/`; `velocity.limit_hit` log + `budgetReachedEmail`
  on breach.
- **B4** — `retrieveCharge` + `Charge`/`ChargeOutcome` in `_shared/stripe.ts`;
  `stripe-webhook` detects `outcome.type === 'blocked'` and routes away from
  the decline-recovery path; writes `radar_blocked` `link_state_events`;
  notifies payer via `radarBlockedPayerEmail` (O7); logs `stripe.radar_blocked`.
- LOG.md, WISHLIST.md, PAYMENTS.md §10, and the decided proposal updated.

## Read first, in order

1. **[`PAYMENTS.md`](../PAYMENTS.md)** — especially the new **§10 (Risk
   intelligence)**. Operational summary of the three controls, the data
   contract, and the event-log surface.
2. **The decided proposal** (link above) — full design rationale, the §4.4
   "make the account unable to move money" framing, the embedded fresh-eyes
   review and author response.
3. **[`LOG.md`](../LOG.md)** — the two 2026-05-22 entries: "Payments
   risk-intelligence proposal — decided" and "Payments risk-intelligence —
   implementation shipped." The implementation entry's `Browser-verified:`
   block lists exactly what end-to-end verification should cover (the
   `mcp-session: PENDING` is the open work).
4. **[Execution plan](file:///Users/ja/.claude/plans/pure-gliding-babbage.md)** — the approved file-level plan implementation followed.

## Critical: deploy-order check

**Has migration 031 been applied to prod?** The edge functions (already
auto-deployed via push-to-main) reference:
- `profiles.daily_budget_cents` / `weekly_budget_cents` columns
- `link_state_events.radar_blocked` enum value

In the gap between code-deploy and migration-apply:
- Budget reads fail *open* (no enforcement; per-shipment cap + Radar still
  apply — backstop only).
- A Radar-block `link_state_events` insert would violate the CHECK and
  silently drop (caught as `flex_decline_handler_error`).

**First task at session start:** confirm migration 031 ran. If not, paste the
SQL from `supabase/migrations/031_payments_risk_intelligence.sql` into
Supabase Studio → SQL editor (or ask John to).

## Jobs

### Job 1 (lead fast-follow) — Admin UI for `set_account_budget`

Today an admin raises a budget by calling the RPC directly (Supabase Studio
or `supabase.rpc('set_account_budget', {target_user_id, daily_cents,
weekly_cents})`). The RPC is the secure primitive; the missing piece is a
**minimal admin control in the existing `/admin` page** so John doesn't have
to leave the app.

Scope (truly minimal):
- A small form section on the Admin page: `target_user_id` (text), `daily`
  ($), `weekly` ($), Submit button. Calls `supabase.rpc('set_account_budget',
  …)`. Display the error on failure, a toast/success on success.
- The Links tab already lists owners (by email, not by user_id). Showing the
  current budget per owner would be nicer UX but requires extending the
  `admin-report` Edge Function — defer that.

Files: `src/pages/Admin.tsx`. The `AuthContext` is **not** the right home for
the RPC call — budget isn't auth state, and the RPC is admin-only / one-off.
Inline the `supabase.rpc(...)` call in the form handler.

Effort: ~1–2 hours.

### Job 2 — Tests for B5 + B4

**Partially shipped 2026-05-23.** What's done vs. remaining:

- **✅ Done:** `tests/unit/budget.test.ts` — 16 Vitest unit tests for
  `_shared/budget.ts checkAccountBudget` (window math, fail-open, per-mode,
  24h/7d boundary, null defaults, abs on amount_cents). Pattern: TYPE-ONLY
  import of `SupabaseClient` so Vitest's TS transform erases the remote URL
  and we import the real helper directly + feed it a typed mock client.
- **✅ Done:** `tests/e2e/account-budget-admin.spec.ts` — 3 mocked Playwright
  tests for the `/admin` Account Budget UI (success path, RPC error
  surfacing, client-side validation). Mocks `/rest/v1/profiles*` to return
  `role:'admin'` so the seeded test user clears the admin gate (same
  workaround `admin.spec.ts` flagged as the coverage path forward).
- **⏳ Remaining — `tests/e2e/flex-budget-breach.spec.ts`:** drive the
  sender flow at `/s/<code>` to Confirm with a mock `labels` Edge Function
  response of `{ status: 402, body: "this link has reached its spending
  limit…" }`; assert the sender sees the "contact us" message.
- **⏳ Remaining — `tests/e2e/flex-radar-block.spec.ts`:** same harness, mock
  `labels` to return `{ status: 402, body: "this payment was declined by our
  fraud protection…" }`; assert the distinct fraud-protection wording.

**Why T3/T4 weren't shipped this round:** the existing `sender-flow.spec.ts`
only covers the link-fetch *error* path. Driving the multi-step sender wizard
(intro → from address + package → rates → confirm) to the Confirm step needs
mocking `links`/`autocomplete`/`place-details`/`rates` plus accurate UI
navigation through each step — that harness doesn't exist yet in the repo
and is real work. T3/T4 are **stepwise straightforward once that harness
exists**: each is a ~50-LOC append to that base spec, just changing the
`labels` mock response.

**Real-service e2e for the server-side routing** (the actual
charge-fetch-and-route in `stripe-webhook`, with Stripe test card
`4100 0000 0000 0019`) is the most honest verification of B4 but lives
outside the mocked default suite (per `playwright.config.ts`'s `testIgnore`).
Worth adding as a `buy_label_debug.spec.ts`-style real-service spec.

**Pre-existing breakage noted (NOT from this work):**
`tests/e2e/label-flow.spec.ts` is **stale relative to the 2026-05-20
`/label-test` 5-step refactor** that inserted a Stripe payment step between
Rates and Label. The spec clicks "Select a Rate" then expects the "Label
Ready!" heading, but the page now renders the Payment step in between. Spec
last touched at commit `56029c1` (de-rot); `LabelTest.tsx` has been touched
since. **Fix path:** mock Stripe Elements (or skip the payment step via
test mode) and update the spec to drive through Payment. ~½ day. Not caused
by the risk-intel work — surfaced when I ran the full e2e suite for Job 2.

Effort remaining for Job 2: ~½ day for T3/T4 (with harness), ~½ day for the
real-service B4 verification spec, ~½ day for the `label-flow.spec.ts` fix.

### Job 3 (optional, low-priority) — `shipping` on the full-label PI

`payments/index.ts` currently sets `txn_kind:'cit_full_label'` metadata but
does NOT pass Stripe's top-level `shipping` field (the destination address as
a Radar signal). Reason: `payments/` only receives `easypost_shipment_id`
in its request body, not addresses; Radar at 2b is already strong on-session.

To implement: fetch the EasyPost shipment by id at the start of the handler
(carrier-side `GET /v2/shipments/<id>`), map `to_address` into the Stripe
`shipping` shape (already typed in `_shared/stripe.ts` as `ShippingDetails`),
pass it to `createPaymentIntent`. Cost is one EasyPost API call per
full-label charge. Defer unless Fraud Teams custom rules want the
destination signal.

Effort: ~½ day.

### Job 4 — B1 (John) — Stripe Radar Dashboard config

Not code; John's task. In the Stripe Dashboard (both test and live):
- Enable recommended block rules: block if CVC verification fails; block if
  postal-code verification fails; block at risk level "highest."
- Verify card-testing protection is on (covers SetupIntents too — Context 1).

Once done, append a brief LOG entry confirming. ~1 hr.

## Cross-cutting context

### Radar-block testing in test mode
Stripe test card **`4100 0000 0000 0019`** ("always blocked by Radar")
triggers `outcome.type === 'blocked'` on the charge — directly exercises the
B4 webhook routing.

### `velocity.limit_hit` event shape
Layer-tagged so future dashboards can pivot on it:
- `properties.layer = 'account_budget'` (labels + payments) — carries
  `window` (`daily`|`weekly`), `limit_cents`, `spent_cents`, `attempted_cents`.
- `properties.layer = 'pm_add'` (payment-methods) — carries `window:'daily'`,
  `limit`, `count`. (Different shape because pm_add isn't a $ amount.)

### Telemetry-gated ZDA reconsideration (O2)
The proposal kept ZDA/Pattern D′ telemetry-gated. Revisit ~2 weeks
post-launch by running the decline-rate query in `PAYMENTS.md` §4 against
live flex charges. If `card_declined` / `insufficient_funds` rates are
meaningful (>5% sustained), bring ZDA forward.

### Known gap — concurrency
`checkAccountBudget` sums `transactions` (webhook-lagged) and so two
near-simultaneous charges could both pass the gate. Acceptable at SendMo's
volume. Documented in `_shared/budget.ts` lines 12–17. Revisit if real
concurrency emerges.

### Plan deviations on file
- Admin UI deferred (Job 1 above) — the RPC is the secure primitive and
  works without UI.
- `shipping` deferred on the full-label PI (Job 3 above) — Radar at 2b is
  already strong on-session.
- Tests deferred (Job 2 above) — verification was code-review-based pre-push
  per John's explicit pipeline.

## Wrap-up protocol when done

1. LOG entries for each fast-follow shipped, with `Browser-verified:` blocks
   (the test card / mcp-session / `n/a-category` shape per PLAYBOOK Rule 19).
2. Update `PAYMENTS.md` §10.7 (deferred list) as items move to done.
3. If `set_account_budget` UI lands, the lead fast-follow line in §10.7 closes.

Good luck.