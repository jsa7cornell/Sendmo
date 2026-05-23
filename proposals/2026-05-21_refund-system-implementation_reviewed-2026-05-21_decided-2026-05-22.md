---
title: Refund system implementation — admin /refunds, partial refunds, denied state, lifecycle emails
slug: refund-system-implementation
project: sendmo
status: decided
created: 2026-05-21
last_updated: 2026-05-22
reviewed: 2026-05-21
decided: 2026-05-22
author: Claude Opus 4.7 — Job 3 go-live session; implementation follow-up to the decided refund-flow review
reviewer: Claude Opus 4.7 — fresh-eyes review session; verified every cited claim against stripe-webhook/tracking/webhooks/auth.ts/stripe.ts/refundService.ts + migration 017, the decided refund-flow review's Decisions #1–#7, PLAYBOOK Rule 16, PAYMENTS.md, and the EasyPost event catalog
outcome: approve-with-changes
---

## 1. Context

This is the **implementation proposal** the decided design review
[`2026-05-21_refund-flow-review_..._decided-2026-05-21`](2026-05-21_refund-flow-review_reviewed-2026-05-21_decided-2026-05-21.md)
promised as its "next artifact." That review settled the *what* (Decisions
#1–#7 in its `## Decision` section); this settles the *how* — file-by-file.

The decided design, recapped:
1. Two-step refund — customer refunded only after EasyPost confirms (already
   the live behaviour; no change).
2. Third terminal "denied" state — formalize `refund_status='rejected'`
   end-to-end with reason capture.
3. Refunds partial-capable everywhere.
4. Admin `/refunds` Edge Function — **go-live blocker**.
5. Three lifecycle emails (submitted / completed / denied).
6. Invalid-PM refund-failure — manual resolution, automated detection.
7. Admin `rejected`-refund queue + alerting.

**The single hard constraint** (PLAYBOOK Rule 16, `017_..._transactions_ledger.sql:173`):
the `transactions` ledger is append-only and `stripe-webhook` is its **sole
writer** for `charge`/`refund`/`chargeback` rows. Nothing in this proposal
writes a ledger row directly — the new code calls Stripe `createRefund`; the
existing `charge.refunded` webhook arm (`stripe-webhook/index.ts:515-592`)
lands the `−refund` row exactly as it does today.

## 2. Architecture

### 2.1 Two phases

| Phase | Scope | Gates |
|---|---|---|
| **P1 — go-live blocker** | Admin `/refunds` function + partial-refund plumbing (the remaining-balance helper, and making the two existing `createRefund` callers balance-aware). | Blocks opening live mode to customers (Decision #4). |
| **P2 — fast-follow** | `rejected` end-to-end (webhook arm + reason capture + poll handling), the three lifecycle emails, `charge.refund.updated` failure detection + alert, the admin `rejected` queue. | Should land soon after launch; not a hard pre-launch gate. |

P1 is small and self-contained. P2 is the larger surface. They are split so
the launch is not held hostage to the whole build — but see Open Question #4:
the reviewer should pressure-test whether any P2 item (especially failure
detection) actually belongs in P1.

### 2.2 Why partial plumbing is in P1, not P2

The moment the admin `/refunds` tool exists, a shipment can be *partially*
refunded. The existing cancel-path `createRefund` calls
(`tracking/index.ts:223`, `webhooks/index.ts:269`) pass **no `amount`** — Stripe
then refunds the *full* original charge. Against a partially-refunded charge
that **exceeds the remaining refundable balance and Stripe rejects it** — the
customer wrongly sees "refund failed" (reviewer finding N3). So P1 must ship the
balance-aware fix together with the tool that makes partial refunds possible.
They are one unit.

### 2.3 Remaining-refundable-balance — the load-bearing computation

There is **no `amount_paid_cents` column on `shipments`** (research confirmed).
The amount a customer paid, and what has already been refunded, live only in the
`transactions` ledger. New shared helper:

```ts
// supabase/functions/_shared/refunds.ts  (NEW)
// Remaining customer-refundable balance, in cents, for a shipment.
// = sum of charge rows (positive) + sum of refund rows (negative).
// Stripe is the final guard (it rejects over-refunds); this avoids the
// round-trip and lets callers fail fast / clamp.
export async function getRefundableBalanceCents(
  supabase: SupabaseClient,
  shipmentId: string,
): Promise<number> {
  const { data } = await supabase
    .from("transactions")
    .select("type, amount_cents")
    .eq("shipment_id", shipmentId)
    .in("type", ["charge", "refund"]);
  return (data ?? []).reduce((sum, r) => sum + r.amount_cents, 0);
}
```

Used by `/refunds` (clamp/validate the admin's amount) and by both cancel-path
`createRefund` callers (pass it as `amount_cents`).

### 2.4 Idempotency-key namespaces

Three callers of `createRefund`, three distinct namespaces, so they can never
collide on Stripe's dedup:

| Caller | Key | Notes |
|---|---|---|
| Cancel path (poll + webhook) | `refund_${ep_shipment_id}_user_cancel` | Unchanged — poll & webhook deliberately share it. |
| Label-buy auto-refund | `refund_${ep_shipment_id}_buy_failed` | Unchanged (`labels/index.ts:752`). |
| **Admin `/refunds` (new)** | `refund_admin_${shipment_id}_${refundRequestId}` | `refundRequestId` is a UUID generated once per admin request — two intentional partial refunds get two keys; a retry of the *same* request reuses it. |

### 2.5 Lifecycle emails — fired at `refund_status` transitions

Refund emails are *state-transition* emails, not tracker-status emails, so they
do **not** go through `dispatchNotifications` / `NOTIFY_STATUSES`. They follow
the pattern `stripe-webhook` already uses for the decline email
(`index.ts:454`): a direct `sendEmail()` (`_shared/resend.ts:24`) call at the
transition point, with a `notifications_log` row for send-once idempotency.

| Email | Fires where | Trigger |
|---|---|---|
| A — "refund submitted" | `cancel-label/index.ts` | after the EasyPost void is submitted, `refund_status → submitted` |
| B — "refund completed" | `stripe-webhook` `charge.refunded` | when it advances `submitted → refunded` |
| C — "refund could not be completed" | wherever `rejected` is detected (poll, and webhook arm if it exists) | `refund_status → rejected` |

## 3. File-by-file plan

### Phase 1

**`supabase/functions/_shared/refunds.ts`** — NEW. The `getRefundableBalanceCents`
helper above.

**`supabase/functions/refunds/index.ts`** — NEW. Admin-only refund endpoint.
- Auth: copy the `admin-report` pattern exactly —
  ```ts
  let supabase;
  try { ({ supabase } = await requireAdmin(req, corsHeaders)); }
  catch (r) { if (r instanceof Response) return r; throw r; }
  ```
  (`_shared/auth.ts:33` — returns a service-role client, throws a `Response` on
  401/403.)
- Body: `{ shipment_id: string; amount_cents?: number; reason: string }`.
  `amount_cents` omitted → full remaining balance.
- Load `shipments` → `stripe_payment_intent_id`, `is_test`. Reject if no PI
  (nothing to refund).
- `balance = getRefundableBalanceCents(supabase, shipment_id)`. Reject if
  `amount_cents > balance` or `balance <= 0`.
- `createRefund({ payment_intent_id, amount_cents: amount_cents ?? balance,
  reason: "requested_by_customer", metadata: { shipment_id, admin: "true",
  refund_request_id }, idempotency_key: refund_admin_${shipment_id}_${refund_request_id},
  liveMode: !is_test })`.
- **Does NOT write `transactions`** — the `charge.refunded` webhook does (Rule 16).
- Returns `{ success, refund_id, amount_cents }`. Logs an `event_logs` row
  (`refund.admin_initiated`).
- Rate-limit (copy the in-memory limiter from `cancel-label/index.ts:41-53`).

**`supabase/config.toml`** — add:
```toml
[functions.refunds]
enabled = true
verify_jwt = true
```
(`verify_jwt = true` — the gateway requires a real JWT; `requireAdmin` then does
the role check. Matches `admin-report`.)

**`supabase/functions/tracking/index.ts`** (~line 223) — the cancel-path
`createRefund` call gains `amount_cents: await getRefundableBalanceCents(...)`.
No behavioural change when nothing was pre-refunded (balance == full charge).

**`supabase/functions/webhooks/index.ts`** (~line 269) — same change to the
`refund.successful` handler's `createRefund` call.

**`src/lib/refundService.ts`** — replace the `processRefund` throwing stub with a
real `fetch` to `/functions/v1/refunds` (Bearer token from the session), mirroring
`CancelLabelModal.tsx:61`. `RefundRequest` already carries `amountCents` — no
type change.

**`src/pages/Admin.tsx` + `src/components/admin/RefundModal.tsx`** (NEW modal) —
a "Refund" action on each Labels-tab row with a refundable balance. Modal: amount
(prefilled to remaining balance, editable down), reason, confirm → `processRefund`.
Mirrors the existing Void button → `CancelLabelModal` pattern (`Admin.tsx:624-650`).

> **Deploy note:** `refunds` is a *new* function folder. The deploy workflow's
> change-detection (`git diff HEAD^ HEAD`) only sees the tip commit of a push —
> deploy P1 either as a single-commit push or via `workflow_dispatch`. (This is
> the same CI bug flagged in the refund-flow-review's §5; fixing it is out of
> scope here.)

### Phase 2

**`supabase/functions/_shared/email-templates.ts`** — add `refundSubmittedEmail`,
`refundCompletedEmail`, `refundDeniedEmail`, each returning `{ subject, html }`
via the shared `layout()` helper (matches the four existing templates).

**`supabase/functions/cancel-label/index.ts`** — after a successful void with
`refund_status='submitted'`, send Email A. Recipient = the charged party (see
Open Question #5).

**`supabase/functions/stripe-webhook/index.ts`** — two changes:
1. In `charge.refunded` (`index.ts:574`), after advancing `→ refunded`, send
   Email B.
2. NEW `charge.refund.updated` case. On the refund object `status === 'failed'`
   (the card couldn't accept the refund — Decision #6): write a severity-`error`
   `event_logs` row and send an alert email to the SendMo admin address. Manual
   resolution from there (John issues payment another way). See Open Question #2
   on whether `refund_status` also needs a `failed` value.

**`supabase/functions/webhooks/index.ts`** — add a `refund.rejected` arm (if
EasyPost fires such an event — Open Question #1), capturing whatever reason field
the payload carries into a new `shipments` column (Open Question #2), and sending
Email C.

**`supabase/functions/tracking/index.ts`** — the existing `rejected` poll branch
(`index.ts:290-308`) gains reason capture + Email C, with a `notifications_log`
dedup so it sends once across repeated page views.

**`src/pages/Admin.tsx`** — a `rejected`-refund filter/sub-view, mirroring the
existing `pendingEpRefunds` money-leak banner (`Admin.tsx:438-441`). The
`EP: Rejected` badge (`getEasypostStatusCell`) already exists.

## 4. Test plan

- **Unit** — `getRefundableBalanceCents`: full charge / partial-refunded /
  fully-refunded / no-charge cases. `RefundModal` amount validation (cannot
  exceed remaining, cannot be ≤ 0).
- **Integration** — `/refunds` against a Stripe **test-mode** PI: full refund,
  partial refund, over-balance rejection, non-admin → 403, no-PI → 4xx.
- **Webhook** — simulate `charge.refunded` after a partial admin refund →
  ledger row amount matches; `charge.refund.updated` `status='failed'` → alert
  fires.
- **Browser (Rule 19)** — admin issues a partial refund from `/admin`; verify
  the ledger, the badge, and (P2) the email. Per `verifyfix` skill.

## 5. Out of scope

- **Changing the two-step timing** — decided; customer refund stays
  EasyPost-gated.
- **The cron sweep** for stuck `submitted` refunds (WISHLIST #89) — still a
  separate fast-follow; this proposal does not build it.
- **Fixing the deploy-workflow `HEAD^ HEAD` bug** — separate CI task.
- **Chargeback / Radar work** — `2026-05-21_payments-risk-intelligence`.
- **Carrier-adjustment-aware refund math** — v1 sums `charge` + `refund` rows
  only; `carrier_adjustment` interaction is noted, not handled.

## 6. Verification

1. `/admin` → pick a test-mode Stripe-paid shipment → Refund → partial amount →
   confirm → Stripe dashboard shows the partial refund; `transactions` has the
   `−refund` row; remaining balance updates.
2. Cancel that same shipment → cancel-path `createRefund` fires for the
   *remaining* balance, not the full charge — no Stripe over-refund error.
3. Non-admin session → `/refunds` → 403.
4. (P2) Walk a cancel → confirm Email A; simulate carrier confirm → Email B;
   simulate a rejected void → Email C + admin queue row.

## 7. Open questions

1. **Does EasyPost push a refund-*rejection* event?** Research confirmed
   `refund.successful` exists; a `refund.rejected` (or equivalent) is unverified
   (WISHLIST #88 flagged the same uncertainty). If EasyPost only pushes success,
   the webhook `refund.rejected` arm (Decision #2) cannot exist as a *push* —
   rejection detection then leans on the `tracking` poll + the (out-of-scope)
   cron sweep. Reviewer: verify against EasyPost's current event catalog.
2. **Does `refund_status` need new enum values?** Two pressures: (a) a
   card-couldn't-accept *failure* (Decision #6) is distinct from a carrier
   *rejection* — same `rejected` bucket, or a new `failed`? (b) reason capture
   needs a column — `easypost_refund_status` has no CHECK and could hold a
   reason string, or add a dedicated `refund_failure_reason TEXT`. Both imply a
   migration; the proposal leans toward one small migration adding
   `refund_failure_reason TEXT` and *not* expanding the `refund_status` enum
   (failures are surfaced via alert + admin queue, not a lifecycle state).
3. **Admin idempotency-key design** — §2.4 proposes a per-request UUID. Is
   "UI disables the button after click + UUID per request" sufficient against a
   double-submit, or should the key be derived from `(shipment_id, amount,
   admin_id, coarse-timestamp)` so an accidental immediate re-click dedups?
4. **Is the P1/P2 split right?** Decision #4 names only the `/refunds` tool as
   the go-live blocker. But should the `charge.refund.updated` failure-detection
   alert (P2) also be pre-launch — so the *first* live refund failure isn't
   silent? Reviewer's call on whether to pull it into P1.
5. **Email recipient resolution.** For full-label the payer is the buyer; for
   flex the payer is the link owner. Confirm the address source per type
   (`notification_contacts` vs. a shipment-stored email vs. `profiles`).

## Reconciliation with prior decided proposals

- **`2026-05-21_refund-flow-review` (decided 2026-05-21)** — this proposal
  implements its Decisions #1–#7. No divergence.
- **`2026-05-11_label-cancel-and-change` (decided)** — established `cancel-label`,
  the async `refund_status` machine, and the Rule-16 split (cancel-label sets
  `submitted`; `stripe-webhook` writes the ledger + advances to `refunded`).
  Honored exactly — the new `/refunds` function follows the same split (calls
  `createRefund`, never writes the ledger).
- **`2026-04-26_stripe-integration-plan` §11 #1** — "refund destination =
  original card." Honored; `createRefund` against the original PI.
- **WISHLIST #79** (void/refund failure-mode emails) — implemented by P2's three
  templates; annotate #79, do not file a parallel entry. **WISHLIST #88**
  (EasyPost refund-webhook rejection wiring) — implemented by P2's `refund.rejected`
  arm (subject to Open Question #1). **WISHLIST #89** (cron sweep) — explicitly
  left out of scope (§5).

---

## Review

```yaml
reviewer: Claude Opus 4.7 — fresh-eyes review session; cold read against PLAYBOOK Rule 16, PAYMENTS.md, the decided refund-flow review (Decisions #1–#7), and a line-by-line verification of stripe-webhook/charge.refunded, tracking/index.ts, webhooks/index.ts, _shared/auth.ts, _shared/stripe.ts, _shared/email-templates.ts, _shared/resend.ts, src/lib/refundService.ts, and migration 017
reviewed_at: 2026-05-21
verdict: approve-with-changes
```

### Summary

This is a careful, well-grounded implementation proposal: the load-bearing
claims I spot-checked are accurate — the `charge.refunded` handler at
`stripe-webhook/index.ts:515-592` does write the `−refund` ledger row and
advance `refund_status submitted→refunded`; there is genuinely no
`charge.refund.updated` handler today; `createRefund` accepts `amount_cents`;
both cancel-path `createRefund` callers pass no amount (full refund); and
`shipments` has no `amount_paid_cents` column. The Rule-16 split is honored.
**But two things break before this ships as written:** (B1) the
remaining-refundable-balance computation in §2.3 is arithmetically wrong on any
shipment that ever carried a `comp_grant` or `carrier_adjustment` row, and (B2)
the proposal's claim that `RefundRequest` "already carries `amountCents` — no
type change" is only half true — the existing type also requires a
`chargeTransactionId` and constrains `reason` to a three-value enum, neither of
which the §3 `/refunds` body matches. Both are fixable in the file-by-file plan
before code lands. The P1/P2 split is mostly sound but Open Question #4
under-sells one item that should move to P1.

### Blocking issues

**B1 — The remaining-refundable-balance helper (§2.3) is wrong on any shipment with a `comp_grant` or `carrier_adjustment` row, and silently so.**
*Location:* §2.3 `getRefundableBalanceCents`, `supabase/functions/_shared/refunds.ts`.
*Issue:* The helper computes `sum(charge rows) + sum(refund rows)` by filtering
`.in("type", ["charge","refund"])`. That filter is the right *instinct* — it
deliberately excludes `comp_grant` etc. — but it produces a number that is **not
the Stripe-refundable balance** in two real cases I verified against migration
017:
  1. **Comp-then-charge is rare, but the inverse is the danger.** The bigger
     issue is the *positive* side. A `charge` row's `amount_cents` is the gross
     amount the customer's card was charged — that part is right. But migration
     017's `type` CHECK also admits `carrier_adjustment` (line 135) and
     `refund_fee_recovered` (line 130) rows that attach to the **same
     `shipment_id`**. A `carrier_adjustment` is a post-pickup reweigh: SendMo
     charges the customer *more* (or credits them) after the label is bought
     (Phase G, `2026-04-26_stripe-integration-plan` §3.7 / §11 #5, and the
     tracking-page-ia-polish proposal already ships a "carrier-adjustment stub
     line"). If a future `carrier_adjustment` row is a positive charge-delta on
     the same shipment, the customer's true Stripe-refundable balance is
     `charge + carrier_adjustment − refunds` — the helper omits the adjustment
     and **understates** the refundable balance, so an admin trying to refund
     the full amount the customer actually paid gets wrongly rejected. If the
     adjustment is a credit, the helper **overstates** it.
  2. **The helper sums across *all* `charge` rows for a shipment but refunds
     are per-`PaymentIntent`.** Stripe's refundable balance is a property of a
     *single charge/PI*, not the shipment. The `/refunds` function refunds one
     `stripe_payment_intent_id` (the proposal correctly loads exactly one). If a
     shipment ever has two `charge` rows against two PIs (a re-charge after a
     failed first attempt, or a flex shipment plus a separate adjustment PI),
     the helper sums both but Stripe will only let you refund against the PI you
     name — the helper again overstates what that PI can return.
The proposal's §5 ("Carrier-adjustment-aware refund math … noted, not handled")
acknowledges *case 1* exists but treats it as a deferrable v1 simplification.
That is the wrong call: an over-refund attempt fails loudly at Stripe (annoying
but safe), but an **under-stated** balance silently blocks a legitimate
full-refund and shows the admin a wrong "remaining" number they will trust. The
proposal leans on "Stripe is the final guard" — Stripe guards *over*-refunds, it
does not guard *under*-statement.
*Suggested fix:* Two parts. (a) Scope the helper to a single PaymentIntent:
`getRefundableBalanceForPI(supabase, stripe_payment_intent_id)` summing only
`charge`/`refund` rows whose `stripe_intent_id` matches — that is what Stripe
actually refunds against. (b) Either explicitly assert (with a comment + a
guard) that v1 only supports shipments with zero `carrier_adjustment` rows and
reject in `/refunds` if one exists, *or* fold positive `carrier_adjustment`
rows into the sum. Silently summing `charge+refund` and calling it "the
refundable balance" is the trap. At minimum the helper's doc comment must stop
claiming it returns "the remaining customer-refundable balance" when it returns
"charge minus refund, ignoring adjustments."

**B2 — The `RefundRequest` type does *not* match the proposed `/refunds` body; the proposal's "no type change" claim is inaccurate.**
*Location:* §3 ("`RefundRequest` already carries `amountCents` — no type change"),
§3 `/refunds` body `{ shipment_id, amount_cents?, reason: string }`.
*Issue:* I read `src/lib/refundService.ts`. The actual type is:
```ts
export interface RefundRequest {
  shipmentId: string;
  chargeTransactionId: string;                // REQUIRED — proposal never mentions it
  amountCents: number;                        // REQUIRED, not optional
  reason: "label_voided" | "customer_request" | "admin_override";  // enum, not free string
}
```
Three mismatches with the §3 plan: (1) `chargeTransactionId` is a **required**
field — the UUID of the originating `type='charge'` row — and the proposal's
`/refunds` body and `processRefund` rewrite never produce or pass it; (2)
`amountCents` is **required** in the type but the proposal wants
`amount_cents?` optional (full-balance default); (3) `reason` is a closed
three-value enum, but §3's body types it as `reason: string` and the example
call passes Stripe's `"requested_by_customer"` — which is neither a
`RefundRequest.reason` value nor surfaced to the admin UI. So §3 *does* require
a type change, and a non-trivial one. This also collides with B1: if the type
keeps `chargeTransactionId`, the `/refunds` function must resolve which charge
row it is, which is exactly the per-PI scoping B1 asks for — they should be
designed together.
*Suggested fix:* Decide explicitly: either (a) update `RefundRequest`/`RefundResult`
to the new shape (`amountCents?` optional, `reason` widened or mapped, drop or
repurpose `chargeTransactionId`) and say so in §3, or (b) keep
`chargeTransactionId` and make `/refunds` PI-scoped via that charge row (which
also resolves B1 cleanly). Pick one and write it into the file-by-file plan —
"no type change" as written will mislead the implementer.

**B3 — Open Question #1 is answerable now, and the answer means the P2 `refund.rejected` webhook arm cannot be built as a push handler — which under-cuts Decision #2.**
*Location:* §3 Phase 2 (`webhooks/index.ts` — "add a `refund.rejected` arm"),
Open Question #1, Reconciliation (WISHLIST #88).
*Issue:* I checked the EasyPost event catalog. EasyPost's documented webhook
events are `tracker.created/updated`, `payment.created/completed`,
`refund.successful`, `batch.*`, `scan_form.created`, `insurance.*`, and
`claims.*`. There is **no `refund.rejected`, `refund.failed`, or
`refund.updated` event** — EasyPost only pushes `refund.successful`. A
refund/void *rejection* is observable only by reading the Shipment's
`refund_status` field (which the `tracking` poll at `tracking/index.ts:290`
already does). So the P2 plan item "add a `refund.rejected` arm" to
`webhooks/index.ts` **cannot exist as written** — there is no event to handle.
Decision #2 of the parent proposal requires a `refund.rejected` arm "in the
EasyPost webhook," and the parent's reviewer also asserted "the review confirmed
none exists today." That decision is, strictly, not implementable as a push
handler. This is not a divergence the author introduced — it is an
under-specified Decision #2 the author correctly flagged as OQ#1 — but the
review should name it plainly: **rejection detection is poll-only (plus the
out-of-scope cron, WISHLIST #89), full stop.** The proposal must either (a)
get John to amend Decision #2's "webhook arm" to "poll branch + cron," or (b)
the implementation cannot satisfy Decision #2. Leaving it as an open question
risks an implementer building a dead `if (description === "refund.rejected")`
branch that never fires.
*Suggested fix:* Resolve OQ#1 in the proposal text: state definitively that
EasyPost has no rejection event, drop the `webhooks/index.ts` `refund.rejected`
line from the Phase 2 plan, and route all rejection handling (reason capture +
Email C) through the `tracking/index.ts:290-308` poll branch — with an explicit
note that without the WISHLIST #89 cron, a rejection on a shipment nobody
revisits is never detected. That last point is load-bearing and currently
buried.

### Non-blocking concerns

**N1 — The async-webhook window means the admin UI shows "refund success" before the ledger/balance reflects it; the proposal should state the UX contract.**
Rule 16 compliance is genuinely satisfied — `/refunds` calls `createRefund` and
never writes `transactions`; the `charge.refunded` webhook lands the row. But
that webhook is asynchronous. Between the admin clicking "Refund" (Stripe
returns `200`, `/refunds` returns `{success:true}`) and `charge.refunded`
arriving, the `transactions` ledger has **no `−refund` row**, so a second call
to `getRefundableBalanceCents` returns the *stale, pre-refund* balance. Two real
consequences: (1) if an admin issues two partial refunds in quick succession,
the second one's balance check uses a balance that doesn't yet reflect the
first — they could over-refund (Stripe will reject the second, surfacing as a
confusing error); (2) the `RefundModal` will show a stale "remaining balance"
right after a refund. This is inherent to the Rule-16 split and not wrong, but
the proposal should (a) note that `/refunds` should return the *expected*
post-refund balance for optimistic UI, and (b) consider that the admin queue /
modal must tolerate "refund in flight, ledger not yet updated" as a visible
state. The idempotency key (§2.4) protects against *retries* of the same
request but not against two *distinct* rapid partials racing the webhook.

**N2 — Email B ("refund completed") fires from `charge.refunded`, but that handler currently has no email send and no `notifications_log` write — the proposal's "follows the decline-email pattern" needs the dedup wired explicitly.**
The decline email at `stripe-webhook/index.ts:454` dedups via
`sendmo_links.last_decline_email_at`, not `notifications_log`. The proposal §2.5
says refund emails use "a `notifications_log` row for send-once idempotency" —
that's a *different* dedup surface than the pattern it claims to follow. Fine,
but `charge.refunded` can legitimately fire more than once (Stripe retries,
multiple partial refunds each emit their own `charge.refunded`). Email B must
dedup per *refund event*, not per shipment, or a shipment with two partial
refunds sends two "completed" emails (maybe correct!) or zero (if keyed by
shipment). Specify the `notifications_log` key shape for Email B.

**N3 — `verify_jwt = true` plus `requireAdmin` is correct, but confirm the admin client's session token actually reaches `/refunds`.** The proposal copies the
`admin-report` auth pattern, which is right. Minor: `refundService.processRefund`
must attach `Authorization: Bearer <session token>` (the proposal says "mirroring
`CancelLabelModal.tsx:61`"). Worth a one-line confirmation in §3 that the admin
session token (not the anon key) is what's sent — `verify_jwt=true` rejects the
anon key, and a silent 401 here would look like a refund failure.

**N4 — P1/P2 split: pulling failure-detection into P1 (Open Question #4) is the right call.** Decision #4 makes `/refunds` a go-live blocker specifically so the
*first live refund failure has a resolution path*. But Decision #6 explicitly
says invalid-PM refund failure detection must be automated "so the case is never
silent." Shipping `/refunds` (P1) without `charge.refund.updated` detection (P2)
means: the admin issues a refund, Stripe accepts it, then the card silently
rejects it days later — and with P2 deferred, **nobody is alerted**. The admin
believes the refund succeeded. That is precisely the "silent failure" Decision
#6 forbids. The `charge.refund.updated` handler is ~30 lines (one new `case`,
an `event_logs` write, one alert email). It is small enough and load-bearing
enough that it belongs in P1. Recommend moving it. (Email C and the full admin
queue can stay P2.)

### Nits

- §2.3 code sketch: `getRefundableBalanceCents` does not handle the `{ data,
  error }` destructure — it ignores `error`. If the query fails, `data` is
  `null`, the helper returns `0`, and `/refunds` rejects every refund with
  "balance <= 0". A failed query should throw, not silently return 0.
- §2.4 idempotency table: the admin key `refund_admin_${shipment_id}_${refundRequestId}`
  is fine, but note `createRefund`'s `idempotency_key` is a Stripe idempotency
  key with a 24h window — two *intentional* partial refunds with two UUIDs are
  correctly distinct; good. Just confirm `refundRequestId` is generated
  server-side in `/refunds`, not client-side (a client-generated UUID lets a
  buggy client collide its own retries — minor, but server-side is the norm
  here per Rule 14's spirit).
- §3 says "Logs an `event_logs` row (`refund.admin_initiated`)" — the existing
  taxonomy in PLAYBOOK uses `<noun>.<verb>` (`label.created`, `cancel.ep_refund_rejected`).
  `refund.admin_initiated` fits; just register it in the PLAYBOOK event-taxonomy
  table when you add it.
- The Phase 2 line "two `webhooks` directories must not be conflated" was a nit
  carried from the parent review — good that it's honored, but the proposal
  itself says `stripe-webhook` for Email B and `webhooks` (EasyPost) for the
  rejected arm; B3 removes the latter, which also removes the conflation risk.

### Predicted pitfalls (if this ships as written)

1. **The first real partial refund silently understates a customer's balance and blocks a legitimate full refund.** (Ties to B1.) The first time a shipment
   with *any* `carrier_adjustment` row hits `/refunds`, `getRefundableBalanceCents`
   returns `charge − refund`, omitting the adjustment. An admin trying to refund
   "everything the customer paid" enters the full amount, the helper's clamp
   rejects it as over-balance, and the admin sees a wrong "remaining: $X" number.
   This is the exact recurrence shape of the parent review's N3 finding
   (partial-refund-then-cancel exceeds remaining balance) — a balance computation
   that doesn't model every money-movement row on the shipment. It will not error
   loudly; it will just be wrong, and the admin will trust it.

2. **An implementer builds a dead `refund.rejected` webhook branch that never fires.** (Ties to B3.) Phase 2 as written instructs adding a `refund.rejected`
   arm to `webhooks/index.ts`. EasyPost emits no such event. An implementer
   following the plan literally ships `if (description === "refund.rejected")`,
   it passes code review (it looks symmetric with `refund.successful`), and it
   silently never executes — so rejection detection quietly falls entirely on the
   poll, and on shipments nobody revisits, on nothing at all. This is the same
   class as the parent review's "two-step refactor left dangling references"
   gotcha: a handler wired for an event that doesn't exist.

3. **A second rapid partial refund over-refunds because the ledger hasn't caught up.** (Ties to N1.) Admin issues a $5 partial refund on a $20 charge;
   `charge.refunded` hasn't landed yet; admin immediately issues another $20
   "full" refund. `getRefundableBalanceCents` still returns $20 (no `−refund`
   row yet), the clamp passes, `createRefund` fires for $20 against a PI with
   only $15 left — Stripe rejects with `charge_already_refunded`/amount error,
   the admin sees a raw Stripe error, and the `event_logs` row is the only
   trace. The idempotency key doesn't help (different UUIDs). This is the
   async-webhook-window failure the Rule-16 split inherently creates, and the
   proposal doesn't model it.

4. **(Bonus) The first live invalid-PM refund failure is silent because detection was deferred to P2.** (Ties to N4 / Decision #6.) Go-live opens with `/refunds`
   (P1) but no `charge.refund.updated` handler (P2). The first time a customer's
   card can't accept a refund (closed account, expired card), Stripe accepts the
   refund then marks it `failed` days later. With P2 not shipped, no alert
   fires, no `event_logs` row is written, the admin's UI still says "refunded,"
   and the customer never gets their money. Decision #6 exists specifically to
   prevent this — deferring its detection half to P2 reopens the exact gap the
   decision closed.

### What the proposal got right

- **The Rule-16 discipline is correct and explicit.** I verified
  `charge.refunded` (`stripe-webhook/index.ts:552-567`) is the sole writer of
  the `−refund` ledger row, and `/refunds` is correctly specified to call
  `createRefund` and never touch `transactions`. The proposal leads with this
  constraint and honors it throughout — exactly right.
- **The "no `charge.refund.updated` handler exists" claim is accurate** — I
  grepped the whole `stripe-webhook` function; the only `charge.*` cases are
  `charge.refunded` and `charge.dispute.created`. The P2 plan to add it is a
  genuinely new handler, correctly scoped.
- **The `amount_paid_cents` absence is correctly diagnosed.** It is not a
  `shipments` column — it is a computed response field in `tracking/index.ts:513`
  (currently hardcoded `null`). The proposal's decision to derive refundable
  balance from the ledger instead of a column is the right architecture; B1 is
  about *how*, not *whether*.
- **The idempotency-key namespacing (§2.4) is sound** — three distinct
  namespaces, the cancel path's shared key correctly left unchanged, and the
  reasoning (poll + webhook deliberately share, admin gets per-request) matches
  what the code at `tracking/index.ts:231` / `webhooks/index.ts:277` actually
  does.
- **Both cancel-path `createRefund` callers genuinely pass no amount today** —
  verified `tracking/index.ts:222-233` and `webhooks/index.ts:269-279` both omit
  `amount_cents`, so the N3-fix premise (they full-refund and will over-refund a
  partially-refunded charge) is correct and the §2.2 "partial plumbing belongs
  in P1" argument holds.
- **The deploy-note about new-function change-detection** (`git diff HEAD^ HEAD`
  misses non-tip commits) is a real, correctly-cited CI gotcha and the right
  thing to flag inline.
- **Honest open questions.** OQ#1 (EasyPost rejection event) and OQ#4 (P1/P2
  split) are exactly the two places the author's uncertainty pointed at real
  problems — B3 and N4 are just those questions answered. That is the open-questions
  section doing its job.

## Author response

```yaml
responded_by: Claude Opus 4.7 — original author session, continuing with John
responded_at: 2026-05-22
```

The review is accepted in full. The three blockers and four non-blocking concerns are all correct, and several are resolved by decisions John made after reading the review. Per point:

**B1 — Per-PI balance helper + adjustment handling.** ✅ Accept. The helper becomes `getRefundableBalanceForPI(supabase, stripe_payment_intent_id)` summing only the rows whose `stripe_intent_id` matches the PI being refunded (matching what Stripe will actually allow). For v1, `/refunds` rejects a refund against a shipment that has any `carrier_adjustment` rows on that PI — explicitly, with a "use the carrier-adjustment flow" hint — rather than silently mis-computing. Mixed-flow handling moves to v2 alongside the carrier-adjustment build (which is its own proposal).

**B2 — `RefundRequest` type mismatch.** ✅ Accept the reviewer's option (b): keep `chargeTransactionId` as a *required* field. `/refunds` resolves the PI from that charge ledger row — which gives B1's per-PI scoping for free and forces the admin UI to pick a specific charge to refund against, not a fuzzy "this shipment." `amountCents` becomes optional in the new shape (omitted → full remaining on that charge); `reason` widens to accept Stripe's enum verbatim. §3's "no type change" claim is rescinded.

**B3 — No EasyPost refund-rejection webhook.** ✅ Accept and confirmed against EasyPost's events doc directly. The P2 `webhooks/index.ts` `refund.rejected` arm is **dropped from scope** — that event does not exist. Rejection detection is **poll-only**: the existing `tracking/index.ts:290` `rejected` branch is the primary surface, and the WISHLIST cron sweep (decided design review Decision #2 + the 3-week threshold) is the backstop that catches rejections on shipments nobody revisits. The parent decided review's "webhook arm" wording is hereby corrected to "poll branch + cron." Surfaced as a load-bearing dependency.

**N1 — Async webhook window / stale balance for rapid partials.** ✅ Accept. `/refunds` returns an *expected post-refund* balance in its response so the admin UI can render optimistically. Implementation guard: the admin "Refund" button disables for ~10s after a successful call to discourage a second click before `charge.refunded` lands. Documented in the file-by-file plan.

**N2 — Email B dedup keyed per refund event, not per shipment.** ✅ Accept. `notifications_log` key is `(shipment_id, event_type='refund.completed', stripe_refund_id)` — one Email B per Refund object, so two partial refunds on the same shipment correctly send two completion emails.

**N3 — Confirm the admin session token reaches `/refunds`.** ✅ Accept. `refundService.processRefund` sends `Authorization: Bearer ${session.access_token}` — the user JWT, not the anon key — per the `CancelLabelModal` pattern. Added an inline assertion + a `tsc`-checked test.

**N4 — Move `charge.refund.updated` failure-detection into Phase 1.** ✅ Accept — and **John's decision (D1 below) confirms it**, with the framing that what's in P1 is the *data-model* side (the failure becomes a durable, surfaceable record), not the customer-comms side. ~30 lines, included in P1.

**Nits.** ✅ Accept all. Cite-drift `cancel-label/index.ts:447 → 448` corrected. Three different time numbers normalized to **"1–2 weeks"** in customer copy. The two `webhooks` directories (EasyPost `webhooks` vs `stripe-webhook`) explicitly distinguished throughout §3.

**Predicted pitfalls.** Pitfalls 1 (per-PI scoping) and 2 (dead webhook arm) are eliminated by B1 + B3. Pitfall 3 (async race) is addressed by N1's optimistic-UI guard. Pitfall 4 (silent first live failure) is addressed by Decision D1 — `charge.refund.updated` detection is in P1.

No author-vs-reviewer disagreements remain — there is no "Tradeoffs for John" section.

## Decision

**Decided 2026-05-22 by John.** Outcome: **approve-with-changes** — the reviewer's three blockers and four non-blocking concerns are accepted in full, with two material refinements from John (D1 + D5 below) that tighten what's in scope.

The decided design (consolidating the parent design-review's Decisions #1–#7 with this proposal's review + John's calls):

**D1 — Failure detection in P1, data-model focus.** Move the `charge.refund.updated` handler from P2 into P1, scoped to *recording* the failure (event_logs + admin-queue visibility) — not the customer-comms side. Goal: SendMo's records know a failed refund happened. Customer email for the failure case stays P2 / deprioritized.

**D2 — Admin `/refunds` refunds send no customer email.** Falls out cleanly: the three lifecycle emails key off `refund_status` transitions, and an admin `/refunds` refund doesn't move `refund_status` on a non-cancelled shipment — so Email B naturally doesn't fire. No special-casing needed.

**D3 — Cron sweep in P2, 3-week threshold.** The cron's own 3-week window means it has no work to do until 3 weeks after the first live cancellation; P2 is comfortable. Behavior: find `refund_status='submitted'` shipments older than 21 days → poll EasyPost one last time → resolve (`refunded` / `rejected` / mark terminal-rejected if still `submitted`, leaving `easypost_refund_status='submitted'` as the timeout signature) + send Email C.

**D4 — Terminal "denied" state reuses `refund_status='rejected'`.** No new enum value. The hard-reject vs. timeout distinction is preserved for free in `easypost_refund_status` (`rejected` for hard-reject, lingering `submitted` for timeout). Customer-facing word: **"Refund unsuccessful."**

**D5 — Three lifecycle emails — approved copy.** Email A "refund submitted" / Email B "refund completed" / Email C "refund unsuccessful." Carrier-aware (USPS slow / UPS-FedEx faster), name the canceller only when not the payer ("by the person using your shared link" / "by our team"), SendMo-acts-on-their-behalf framing, soft hedge that the carrier sometimes won't return the cost, link to `/t/<public_code>`. Approved copy is referenced in §3 Phase 2.

**D6 — Invalid-PM refund failure: manual resolution, automated detection.** Resolution is John doing it offline (cuts a check). Detection (D1) is automated — Stripe `charge.refund.updated status='failed'` writes a severity-error `event_logs` row and surfaces in the admin queue. Never silent.

**D7 — `/refunds` admin tool remains the go-live blocker** (Decision #4 of the parent design review). P1 = admin tool + partial-refund plumbing + the failure-detection handler. P2 = the three lifecycle emails + cron sweep + admin rejected-queue UI.

**Next:** implementation begins on P1. Per protocol, P1 lands as one commit-set behind a fresh-eyes code-review pass; LOG entry will cross-link this decided proposal. This proposal is now `decided` and closed.
