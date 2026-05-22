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

The 2026-05-22 implementation shipped without new tests; the LOG entry flags
this as owed. Per the approved plan:

- **Unit / integration tests for `checkAccountBudget`** (`_shared/budget.ts`).
  Pure logic; mock the supabase client. Cover: trailing-window math (24h vs
  7d split), the empty-transactions case, the "missing profile fails open"
  case, the per-mode segregation.
- **E2e test (Playwright) for the budget breach path:** drive a flex link
  past `weekly_budget_cents=50000` (admin-set it low first), confirm the
  402 + the contact-us copy + a `velocity.limit_hit` event_log row.
- **E2e test for Radar-block routing:** Stripe test card
  `4100 0000 0000 0019` triggers a Radar block. Confirm `label.flex_radar_blocked`
  is logged, `radar_blocked` `link_state_events` is written, the decline
  email is NOT sent (check `sendmo_links.last_decline_email_at` doesn't
  bump), the link stays `active`, and `radarBlockedPayerEmail` is sent to
  the payer.

The existing `tests/e2e/phone-gate.spec.ts` is a good model for the
authenticated-spec harness pattern (`playwright/.auth/user.json` from
`global-setup.ts`).

Effort: ~1 day.

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