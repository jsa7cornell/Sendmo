---
title: Refund flow review — the two-step refund, admin cancellations, and admin reimbursements
slug: refund-flow-review
project: sendmo
status: decided
created: 2026-05-21
last_updated: 2026-05-21
reviewed: 2026-05-21
decided: 2026-05-21
author: Claude Opus 4.7 — Job 3 live-mode go-live session; surfaced the review while walking John through the live smoke-test plan
reviewer: Claude Opus 4.7 — fresh-eyes review session; verified all claims against cancel-label/tracking/webhooks/stripe.ts and both cited prior proposals
outcome: approve-with-changes
---

> **Proposal type — design review, not an implementation spec.** John asked for a
> review of the two-step refund design before live money flows through it. The
> usual "File-by-file plan" section is therefore replaced by **§3 Findings** and
> **§4 Options** — the design itself is the open question, so a concrete
> file-by-file plan is premature until John picks a direction. A follow-up
> implementation proposal will carry the file-by-file detail once §4 is decided.

## 1. Context

SendMo's Job 3 (Stripe + EasyPost go-live) is the trigger for this review. The
refund path has **never run against a real charge** — every shipment to date is
comp or test mode (`tracking/index.ts:200`: *"zero Stripe-paid exist, so the
Stripe-refund branch is dormant"*). Going live exercises the entire refund
machinery for the first time, with real customer money.

The current design is **two-step**: cancelling a label does *not* refund the
customer's card. It submits the carrier void and waits for the carrier to
*confirm* that void (USPS: up to ~15 days) before issuing the Stripe refund.

That two-step shape is **a post-decision drift, never proposal-reviewed.** The
reviewed-and-decided proposal [`2026-05-11_label-cancel-and-change`](2026-05-11_label-cancel-and-change_reviewed-2026-05-12_decided-2026-05-12.md)
§2.3 specified the *opposite*: `cancel-label` fires `createRefund`
**immediately** on cancel, sets `refund_status='submitted'`, and the
`stripe-webhook` advances it to `refunded`. The wait-for-carrier-confirmation
behaviour was introduced two days later — "decided 2026-05-13 in a dogfood
follow-up" per the comment block in `cancel-label/index.ts:299-329` — recorded
only in LOG.md and code comments. It was a fast call, not a reviewed one. With
real money about to flow, it deserves the fresh-eyes pass it never got.

**Scope (set by John):**
1. The two-step refund itself (customer self-cancellations).
2. **Admin-driven cancellations** — admins cancel via the same `cancel-label`
   path; same two-step delay applies.
3. **Admin reimbursements** — goodwill / partial / dispute-resolution refunds
   *not* tied to voiding a label. These have **no implementation today.**

## 2. Architecture — the current refund design

### 2.1 Two status columns, deliberately decoupled

| Column | Migration | Meaning |
|---|---|---|
| `shipments.refund_status` | 002 | SendMo's **internal customer-refund lifecycle**: `none → submitted → refunded` (or `rejected` / `not_applicable`). Drives customer-facing copy. |
| `shipments.easypost_refund_status` | 030 | The **carrier/EasyPost-side ground truth**, copied verbatim from EasyPost: `submitted → refunded \| rejected \| not_applicable`. Tells SendMo whether *it* recovered the label cost. |

A comp shipment can sit at `refund_status='not_applicable'` (no customer to
refund) while `easypost_refund_status` goes `submitted → refunded` (SendMo still
recovers its EasyPost cost). The two are intentionally independent.

### 2.2 The four writers

| Step | Function | What it does | Fires `createRefund`? |
|---|---|---|---|
| **Cancel** | `cancel-label/index.ts` | Submits the EasyPost void. Sets `refund_status` (`submitted` if a Stripe PI exists, else `not_applicable`; `rejected` if EP rejects on the spot) + `easypost_refund_status`. | **No** — never calls Stripe. |
| **Carrier confirms (pull)** | `tracking/index.ts:202-284` | On any `/t/<code>` page view for a `refund_status='submitted'` shipment, polls EasyPost. If EP flipped to `refunded` **and** a Stripe PI exists → fires `createRefund` (full amount). | **Yes** |
| **Carrier confirms (push)** | `webhooks/index.ts:206-330` | EasyPost `refund.successful` webhook. Same logic: if a Stripe PI exists → fires `createRefund`. | **Yes** |
| **Stripe confirms** | `stripe-webhook` `charge.refunded` | Writes the −refund row to the `transactions` ledger (sole ledger writer) and advances `refund_status` `submitted → refunded`. | n/a |

Both `createRefund` callers use the **same idempotency key** —
`refund_${easypost_shipment_id}_user_cancel` (`tracking/index.ts:231`,
`webhooks/index.ts:278`) — so the pull and push paths cannot double-refund;
Stripe dedupes. `createRefund` is called with **no `amount`**, so it is always a
**full** reversal of the original charge.

### 2.3 What a real customer experiences

```
Day 0      cancels label. Card NOT refunded. Sees:
           "Cancellation in progress. The carrier typically confirms within
            1–2 weeks; once confirmed, your refund will be issued automatically."
Day ~7–14  carrier confirms the void → EasyPost refund.successful webhook
           → createRefund fires → Stripe processes
Day ~7–14  charge.refunded webhook → ledger row + refund_status='refunded'
+5–10 days bank posts the credit to the customer's statement
```

End to end: **~2–3 weeks** from cancel to money back.

### 2.4 Admin paths today

- **Admin cancellation** flows through the *same* `cancel-label` function
  (`actor='admin'`, `cancelReason='admin'`) — identical two-step, identical
  2–3 week customer wait.
- **Admin reimbursement** has no path. `src/lib/refundService.ts:40`
  `processRefund()` is a stub that `throw`s *"Admin-initiated refunds not
  implemented yet (Phase F)."* No `/refunds` Edge Function exists. An admin
  cannot issue a goodwill, partial, or dispute-resolution refund without
  voiding a label — and voiding a label they may not want to void.

## 3. Findings

**F1 — The two-step *delay* is the real cost, and it is unavoidable in the
current design.** The `refund.successful` webhook removed the old "refund only
fires if the customer revisits `/t/<code>`" dependency — good. But neither the
webhook nor the poll removes the **carrier-confirmation wait**. The customer is
out their money for 2–3 weeks on a label they may have cancelled *minutes* after
buying.

**F2 — The delay's justification is unmeasured.** The two-step exists so SendMo
doesn't refund the customer and *then* discover the carrier rejected the void
(label was actually scanned) — SendMo would eat the label cost. The honest
question: **how often does that happen** for a label cancelled while still
`status='label_created'` (never scanned — already an enforced precondition,
`cancel-label/index.ts:208`)? Plausibly rare. Nobody has the data. The design
imposes a certain cost (every customer waits) to avoid an uncertain one.

**F3 — Both refund code paths are untested in production.** Zero live charges
have ever existed. Go-live makes `createRefund` — via the poll *and* the webhook
— execute for the first time. Two first-runs, on real money.

**F4 — No admin reimbursement path (`processRefund` throws).** This is a
flat gap, not a tradeoff. Real support scenarios — damaged package, customer
complaint, partial goodwill, an overcharge — have zero tooling. The only
admin refund lever is "void the label," which is the wrong tool for most of
these.

**F5 — Admin cancellations inherit the customer delay.** When an admin cancels
to *resolve* a problem, the customer still waits 2–3 weeks. An admin making a
deliberate judgement call cannot expedite the refund — even though the
loss-aversion rationale (F2) is weakest exactly when a human has chosen to act.

**F6 — `rejected` voids dead-end.** If EasyPost rejects the void, `refund_status`
becomes `rejected` and the customer sees *"the void was processed but the refund
failed. We'll follow up — please contact support"* (`cancel-label/index.ts:447`).
There is no admin queue, no alert, and — per F4 — no admin refund tool to
actually resolve it. "Contact support" routes to a process that does not exist.

**F7 — Chargeback exposure scales with the delay.** A customer who cancels and
waits 2–3 weeks may dispute the charge with their bank instead. A dispute costs
SendMo a fee (~$15) and operational time, and can collide with the pending
refund. The two-step trades a *rare* void-rejection loss for a *recurring*
dispute-risk premium. Adjacent: [`2026-05-21_payments-risk-intelligence`](2026-05-21_payments-risk-intelligence.md)
covers chargeback protection but does not address refund latency as a dispute
*driver* — that belongs here.

**F8 — The push trigger is only as reliable as webhook config.** The
`refund.successful` path depends on (a) the EasyPost webhook staying registered
for the production environment and (b) HMAC verification matching. Job 3
registers it now; if it is ever dropped or the secret drifts, the system
silently falls back to poll-only (page-visit-dependent). The cron backstop
(WISHLIST "Cron-poll for stale `refund_status='submitted'`") is **not built**.

## 4. Options

### 4.1 Core design — when does the customer get refunded?

**Option A — Keep the two-step; close only the tooling gaps.**
Customer refund stays gated on carrier confirmation. Build the admin
reimbursement path (§4.2) and the `rejected` queue (§4.3); add the cron
backstop (F8). Does *not* address F1/F5/F7.
- *Pro:* SendMo never eats a rejected-void loss. Preserves John's 2026-05-13 call.
- *Con:* Every refund is a 2–3 week customer wait. Highest dispute risk. Keeps an
  async state machine that is more code and two untested paths.

**Option B — Refund immediately on cancel; absorb the rare rejected-void loss.**
`cancel-label` fires `createRefund` at cancel time (what
`2026-05-11_label-cancel-and-change` §2.3 originally specified). If EasyPost
later rejects the void, SendMo eats that one label cost (~$7–12) and logs it.
The poll/webhook become a reconciliation check, not the refund trigger.
- *Pro:* Best UX — money back in days, not weeks. Eliminates F1, F5, F7 by
  construction; removes an entire async path and its first-run risk. Simplest
  code. Standard practice for shipping resellers, who carry the float.
- *Con:* SendMo carries loss exposure on rejected voids. Bounded per-incident
  (~$7–12) and gated by the existing `label_created`-only precondition, but
  real. Reverses the 2026-05-13 decision — needs John's explicit sign-off.
- *Mitigation:* log every rejected-void-after-refund; if the monthly total is
  material, revisit toward A. (Same "ship simple, measure, escalate" posture
  the project took with Pattern D vs. Pattern D'.)

**Option C — Hybrid: refund immediately for low-risk cancels, two-step otherwise.**
Immediate for admin cancellations and small amounts / very fresh labels;
two-step for the rest.
- *Pro:* Targets the loss exposure narrowly.
- *Con:* Two refund state machines to maintain and test. Likely over-engineered
  for current volume — adds the complexity B removes without B's simplicity.

### 4.2 Admin reimbursement — needed under A, B, or C

Build the `/refunds` Edge Function `refundService.ts` already anticipates
(`processRefund()`, the `RefundRequest`/`RefundResult` types). Requirements:
- Admin-auth'd (JWT + `role='admin'`), rate-limited.
- Supports **partial** amounts — `createRefund` already accepts `amount_cents`
  (`_shared/stripe.ts:414`); the constraint is purely that no caller passes it.
- Routes through the existing ledger discipline: it calls `createRefund`;
  `stripe-webhook` remains the sole writer of the `transactions` −refund row
  (the split-brain rule from Stripe Phase A, reaffirmed in
  `2026-05-11_label-cancel-and-change` §Reconciliation).
- Distinct idempotency key namespace from the cancel path (e.g.
  `refund_${shipment_id}_admin_${chargeTxnId}`) so an admin reimbursement and a
  cancel refund on the same shipment cannot collide.

### 4.3 `rejected` void handling (F6)

Independent of §4.1: a `rejected` refund needs an admin-visible queue (the new
two-tab `/admin` is the natural home) and an alert on the `refund_status →
rejected` transition. Without §4.2's admin refund tool, "contact support" has
no resolution path.

## 5. Out of scope

- **The cron-poll backstop** (WISHLIST "Cron-poll for stale
  `refund_status='submitted'`") — real, but a separate build; this proposal only
  flags it (F8). Cross-link, don't duplicate.
- **Fraud / Radar / chargeback *prevention*** — owned by
  [`2026-05-21_payments-risk-intelligence`](2026-05-21_payments-risk-intelligence.md).
  This proposal only notes refund *latency* as a dispute driver (F7).
- **Phase 3 escrow / `holds` table** — unrelated.
- **The Job 3 edge-function redeploy gap** — an unrelated CI bug (the deploy
  workflow's `git diff HEAD^ HEAD` change-detection misses non-tip commits of a
  batched push); tracked separately, not a refund-design question.

## 6. Recommendation

**Option B + §4.2 + §4.3.** At current volume the rejected-void loss is small,
bounded, and probably rare (F2); paying weeks of customer-wait and dispute risk
(F1/F7) to insure against it is the wrong trade *now*. B also deletes the most
fragile, least-tested part of the system (the async refund path, F3) right
before it would run on real money for the first time. Keep the poll + webhook as
a **reconciliation** layer — they still update `easypost_refund_status` so SendMo
knows whether it recovered its own cost — just not as the customer-refund
trigger. Revisit toward A only if logged rejected-void losses prove material.

This is offered as a genuine lean, not a settled call. Option A was John's
deliberate 2026-05-13 decision and the reviewer should pressure-test whether B's
loss exposure is actually acceptable before John re-decides.

§4.2 (admin reimbursement) and §4.3 (`rejected` queue) are needed regardless and
should ship whichever core option wins.

## 7. Open questions — what the reviewer should weigh in on

1. **Is the rejected-void loss actually rare?** Option B lives or dies on this.
   Is there EasyPost data, an industry benchmark, or a sound first-principles
   argument for how often a void is rejected on a label cancelled while still
   `label_created` (never scanned)? If rejections are common, B is wrong.
2. **Does Option B reopen a closed decision improperly?** The two-step was a
   conscious 2026-05-13 call. Is "it was a LOG-only follow-up, never reviewed"
   enough justification to re-litigate it — or is there a rationale in that
   follow-up this proposal is missing?
3. **Is full-refund-only the right scope for the cancel path?** Even under B, a
   cancel always refunds 100%. Are there cases (carrier-adjustment already
   billed, partial-use) where the cancel refund should be partial — or is that
   strictly the admin-reimbursement path's job?
4. **Idempotency across cancel + admin refund.** §4.2 proposes separate key
   namespaces. Is there a sequence — admin partial refund, *then* a cancel, or
   vice versa — that still double-refunds or leaves `refund_status` wrong?

---

## Review

```yaml
reviewer: Claude Opus 4.7 — fresh-eyes review session; cold read against PAYMENTS.md, PLAYBOOK Rule 16, LOG 2026-05-13→05-21, and a line-by-line verification of cancel-label/tracking/webhooks/stripe.ts plus both cited prior proposals
reviewed_at: 2026-05-21
verdict: approve-with-changes
```

### Summary

This is a strong, honest review-proposal: the architecture section matches the code
exactly (I verified the four-writer table, the shared idempotency key, the
`label_created`-only precondition, `createRefund`'s `amount_cents` capability, and the
`processRefund` throwing stub — all accurate), and the drift framing is correctly
substantiated. F1–F8 are real and the Option B recommendation is defensible. **But the
proposal under-states the loss exposure of Option B in three ways that change the
trade**, and it presents Option B's customer-UX win as larger than the code actually
delivers today. Both are fixable in the proposal text before John decides — hence
approve-with-changes, not approve. The core recommendation (B + §4.2 + §4.3) is likely
still right, but John should decide on corrected numbers.

### Blocking issues

**B1 — The drift claim is *directionally* right but the §2.3 citation is overstated; this matters because the whole "re-litigate freely" license rests on it.**
*Location:* §1 ("§2.3 specified the *opposite*… fires `createRefund` **immediately**"), Open Question #2.
*Issue:* I read `2026-05-11_label-cancel-and-change` §2.3 in full. Its code sketch *does*
fire `createRefund` at cancel time and set `refund_status='submitted'` — so "the two-step
is later drift" is **true**. But §2.3 and its Round-2 Q&A also explicitly built an
**async state machine** where `submitted` is "the legitimate 'cancellation in progress'
state" and the customer "sees a pending banner during the window (minutes to days
depending on Stripe's clearing speed)." The decided proposal already anticipated a
*pending* customer experience — it just budgeted *Stripe clearing* days, not *carrier
confirmation* weeks. So Option B is not "restoring §2.3 verbatim"; it is "restoring
§2.3's *trigger* while keeping §2.3's async webhook reconciliation." The proposal's
framing ("§2.3 specified the opposite") invites John to think B is a clean revert when
it is actually a third design. Also: §2.3's `rejected` branch was defined as "carrier
rejected void OR Stripe refund failed" — under B, `rejected` can now occur *after* the
customer has already been refunded, which §2.3 never contemplated. That is a genuinely
new state-machine case, not a restoration.
*Suggested fix:* Reword §1 and Option B to "Option B restores §2.3's immediate
`createRefund` trigger; the carrier poll/webhook stay as §2.3's reconciliation layer.
The novel-vs-§2.3 part is the post-refund `rejected` case (B2 below)." This is a
two-sentence change and it keeps the proposal honest about scope.

**B2 — Option B creates a refund-then-reject state the current `refund_status` enum and code cannot represent, and the proposal does not name it.**
*Location:* §4.1 Option B, §4.3.
*Issue:* Today `refund_status` flows `none → submitted → refunded` with `rejected` as an
*alternative to* `refunded`. Under B, the sequence becomes: cancel → `createRefund` fires
→ `charge.refunded` webhook → `refund_status='refunded'` (customer has their money) →
*then*, days later, EasyPost `refund.successful` returns `refund_status='rejected'` (the
carrier rejected the void). The shipment is now `refund_status='refunded'` **and**
`easypost_refund_status='rejected'` — SendMo paid the customer *and* ate the label cost.
The current `webhooks/index.ts` `refund.successful` handler (lines 206–336) only knows
how to handle `refunded`; there is **no `refund.rejected` / `refund_status='rejected'`
arm in the webhook at all** — I checked. The poll path in `tracking/index.ts:290` does
handle `epRefundStatus === 'rejected'`, but under B that branch would overwrite a
legitimate `refund_status='refunded'` with `'rejected'`, corrupting the customer-facing
state. Option B is not just "absorb the loss" — it requires (a) a new terminal state
like `easypost_refund_status='rejected'` being the *sole* loss signal while
`refund_status` stays `refunded`, and (b) the `tracking` poll's rejected-branch being
made conditional on `refund_status != 'refunded'`. None of this is in §4. The "loss" is
not just dollars; it is an unhandled state transition in two edge functions.
*Suggested fix:* Add to Option B (or the follow-up implementation proposal it promises) an
explicit mini-state-table for the post-refund-reject case, and call out that
`tracking/index.ts:290–308` and the webhook's missing `refund.rejected` arm both need
edits. Until that is specified, "absorb the rare loss" hides real code.

**B3 — The cron backstop (F8 / WISHLIST #89) is "out of scope" under Option A but becomes *load-bearing* under Option B, and the proposal does not move it.**
*Location:* §4.1 Option A ("add the cron backstop"), §5 Out of scope ("cron-poll… a separate build; this proposal only flags it").
*Issue:* Under Option A, the customer is not refunded until carrier confirmation, so a
missed webhook just *delays* a refund the customer is already waiting for — annoying, not
dangerous. Under Option B, the customer is *already refunded*; the poll/webhook exist
only to tell SendMo whether it recovered its own cost (`easypost_refund_status`). If the
EasyPost webhook is dropped (F8 — and note LOG 2026-05-21 records that **no EasyPost
event was ever processed until that day's STATUS_MAP fix**, and `EASYPOST_WEBHOOK_HMAC_SECRET`
is *still unset* — verification skipped), and nobody visits `/t/<code>` for that
shipment (likely — the customer already got their money, why would they revisit?), then
`easypost_refund_status` is **never reconciled**. SendMo silently loses the label cost on
*every* rejected void, not just the genuinely-rejected ones, and has no record it
happened. Option B's own mitigation ("log every rejected-void-after-refund; if the
monthly total is material, revisit") is **structurally impossible without the cron**,
because under B the poll's only trigger (a page view) is exactly the thing that stops
happening once the customer is refunded. The proposal lists the cron as out-of-scope
"flag only" — but B's measure-and-revisit safety valve does not function without it.
*Suggested fix:* Either (a) pull the cron backstop *into* Option B's scope as a hard
prerequisite (not a flag), or (b) explicitly accept that under B, rejected-void losses
are partly *unobservable* and the "revisit if material" escape hatch is weaker than
stated. (a) is the honest choice. This is the single most important correction.

### Non-blocking concerns

**N1 — Open Question #1 ("is the rejected-void loss rare?") — outside knowledge says: rare, but not as bounded as the proposal implies.** The `label_created`-only
precondition (`cancel-label/index.ts:208`) is a real and strong filter — EasyPost/USPS
voids are normally rejected only when the label has actually entered the mailstream
(scanned). For a label that was *never scanned*, a USPS/UPS void rejection is genuinely
uncommon — single-digit-percent territory is a reasonable first-principles estimate, and
shipping resellers (Pirate Ship, Shippo, Stamps.com) do carry exactly this float, which
the proposal correctly cites. **However**, two real edge cases break the "never scanned"
assumption the proposal leans on: (1) **scan-after-cancel races** — a package handed to
the carrier can get an acceptance scan *minutes after* the customer clicks cancel but
*before* `cancel-label` runs the EasyPost void; the shipment is still
`status='label_created'` in SendMo's DB (the tracker webhook hasn't landed — and per LOG
2026-05-21, EasyPost tracker events were *entirely unprocessed until that day*, so SendMo's
`status` lags carrier reality badly right now). (2) **USPS specifically** is known to
reject voids on labels that were *never* scanned but are simply >some-age, and to
occasionally reject for no surfaced reason. So Option B's "~$7–12 per incident, bounded"
is right on magnitude but the *rate* is coupled to how fresh the cancels are and how
reliable SendMo's `status` field is — and right now that field is unreliable (tracker
webhook only fixed today). Net: B is still defensible, but the proposal should state
that B's loss rate is *worst* in exactly the window SendMo is in now (tracker webhook
just fixed, HMAC unset, status lag real).

**N2 — F7 (chargeback exposure) is real but the proposal slightly overstates it as a B-vs-A differentiator.** A customer who cancels and is refunded immediately (B) can
still dispute — if the refund and the dispute cross in the mail, SendMo can end up
refunding *and* losing the dispute (double loss + the ~$15 fee). The proposal frames B as
eliminating F7 "by construction"; it reduces it substantially but does not eliminate it.
Stripe's own guidance: a fast refund massively *reduces* dispute likelihood but a refund
already in flight does not block a dispute already filed. Minor wording fix.

**N3 — §4.2's idempotency-key namespace (`refund_${shipment_id}_admin_${chargeTxnId}`) is sound, but Open Question #4's worry is real and answerable now.** Sequence: admin issues
a *partial* goodwill refund, then the customer cancels the label. The cancel path fires
`createRefund` with key `refund_${easypost_shipment_id}_user_cancel` for the *full*
amount. Stripe will reject a refund that exceeds the remaining refundable balance — so
the cancel refund would *fail* (becoming `refund_status='rejected'`), and the customer
gets a "refund failed, contact support" message even though they were partially refunded
already. The fix is not idempotency keys (those are correctly separate); it is that the
cancel path must compute the *remaining* refundable amount, not assume full. This belongs
in the §4.2/§4.1-B implementation proposal as an explicit requirement, and it argues
against the proposal's "even under B, cancel always refunds 100%" framing in OQ#3.

### Nits

- §2.2 four-writer table labels the Stripe-confirm row's function `stripe-webhook` but
  the repo path is `supabase/functions/webhooks/index.ts` for EasyPost and a *separate*
  `stripe-webhook` function for Stripe. The table is correct; just confirm the follow-up
  proposal does not conflate the two `webhooks` directories — they are different
  functions.
- §3 F6 quotes the `rejected` copy as `cancel-label/index.ts:447`; the actual string is
  at line 448 in the version I read (`messages` map). Trivial, but cite-drift.
- "USPS: up to ~15 days" (§1) vs "1–2 weeks" (the customer-facing copy at
  `cancel-label/index.ts:446`) vs "2–3 weeks" end-to-end (§2.3) — three different
  numbers for overlapping windows. Pick one framing for the customer copy if B is
  rejected and A stands.

### Predicted pitfalls (if this ships as written)

1. **The post-refund `rejected` collision corrupts customer state.** (Ties to B2.) If
   Option B ships without first fixing `tracking/index.ts:290–308`, the first
   genuinely-rejected void on a Stripe-paid, already-refunded shipment will flip
   `refund_status` from `refunded` back to `rejected`. The customer's `/t/<code>` page
   then renders "the void was processed but the refund failed — contact support"
   (`cancel-label/index.ts:448`) for a customer **who already has their money**. That is
   a support-ticket generator and a trust hit, and it is the *exact* recurrence shape of
   the 2026-05-13 "two-step refactor left dangling references" gotcha (LOG): a
   state-machine change that didn't bring all dependent readers along. Highest-likelihood
   failure.

2. **Silent, unbounded loss because the measurement loop doesn't run.** (Ties to B3.)
   Option B's safety story is "log losses, revisit if material." But under B the customer
   never revisits `/t/<code>` (they're refunded), the EasyPost webhook is the *only* other
   trigger, and per LOG 2026-05-21 that webhook (a) processed *zero* events until today
   and (b) still has `EASYPOST_WEBHOOK_HMAC_SECRET` unset. Realistic outcome: B ships,
   rejected voids happen, `easypost_refund_status` is never reconciled for shipments
   nobody revisits, and the "monthly loss total" John was promised as the revisit trigger
   is simply never computed. John concludes B is "fine, no losses logged" when the truth
   is "losses are not being logged." This is the dangerous-quiet failure.

3. **First-live-charge refund fails for an unmodeled reason and there is no admin tool to
   fix it.** (Ties to F3 + F4.) Go-live runs `createRefund` on real money for the first
   time. The likely first-failure modes are not "rejected void" — they are mundane: the
   PaymentIntent is in a state Stripe won't refund (e.g. still `processing`), a partial
   carrier adjustment already altered the charge, or a Stripe API/key misconfig in live
   mode. When that happens, `refund_status='rejected'`, the customer sees "contact
   support," and — per F4/F6, which the proposal correctly flags — *there is no admin
   refund tool and no queue*. The proposal defers §4.2/§4.3 as "needed regardless" but
   does not gate go-live on them. If live mode opens before §4.2 exists, the very first
   refund failure has no resolution path. §4.2 should be a **go-live blocker**, not a
   parallel workstream.

4. **(Bonus) Admin "expedited" cancel under B has no distinct path and silently inherits
   the 100%-refund assumption.** F5 wants admins to expedite; Option B makes *all* cancels
   immediate, which incidentally satisfies F5 — but an admin cancelling to resolve a
   dispute where the customer *used part of the service* still triggers a full refund.
   The proposal's OQ#3 flags this but Option B's text ("cancel always refunds 100%")
   bakes in the wrong default for the admin case.

### What the proposal got right

- **The drift diagnosis is correct and well-sourced.** I verified `cancel-label`
  genuinely never imports/calls `createRefund` (the import is retired, lines 5–8), the
  two-step comment block (lines 299–333) matches the described behavior exactly, and the
  decided §2.3 did specify the immediate trigger. Framing it as drift, not a new bug, is
  the right institutional-memory move per the protocol.
- **The four-writer table and the shared-idempotency-key claim are accurate.** Both
  `tracking/index.ts:231` and `webhooks/index.ts:277` use
  `refund_${epShipmentId}_user_cancel`; Stripe dedupes; no double-refund across pull/push.
  Correctly described.
- **F4 (no admin reimbursement path) is a real, flat gap** — `processRefund` is a pure
  `throw` (`refundService.ts:40–44`), no `/refunds` function exists, and `createRefund`
  already accepts `amount_cents` (`stripe.ts:413`), so the partial-refund capability the
  proposal wants is genuinely one caller away. Accurate and actionable.
- **Naming F2 (the delay's justification is unmeasured) is the honest core of the
  review.** The proposal resists the temptation to assert a number it doesn't have, and
  instead flags the missing data as Open Question #1. That is exactly the right posture.
- **Keeping the poll + webhook as a *reconciliation* layer under B** (not deleting them)
  is the correct call — `easypost_refund_status` is SendMo's only signal for whether it
  recovered its own cost, and B is right not to throw that away.
- **Scoping §4.2 and §4.3 as "needed regardless of A/B/C"** is correct and keeps the
  core design question clean.

## Author response

```yaml
responded_by: Claude Opus 4.7 — original author session, continuing with John
responded_at: 2026-05-21
```

The review is accepted in full. Every blocking and non-blocking point is correct,
and several are *resolved* — not merely answered — by the direction John chose
after reading the review: the **EasyPost-gated two-step**, not the proposal's
recommended Option B. Per point:

**B1 — drift claim overstated.** ✅ Accept. §2.3 did already specify an async
state machine with `submitted` as a pending state; the 2026-05-13 change moved
the trigger from Stripe-clearing (days) to carrier-confirmation (weeks).
Recorded so the institutional memory is exact: the decided design is the
carrier-confirmation gate, chosen knowingly.

**B2 — refund-then-reject collision.** ✅ Accept — and **the decision dissolves
it.** B2 exists only under immediate-refund (Option B). Under the two-step the
customer is never refunded before EasyPost confirms, so `refunded` and
`rejected` are clean, mutually-exclusive terminal states — there is no
`refunded` row to corrupt. What remains is *formalizing* the `rejected` terminal
state (the missing webhook `refund.rejected` arm, reason capture) — now an
explicit decided requirement, Decision #2.

**B3 — cron backstop load-bearing under B.** ✅ Accept — and **the decision
de-fangs it.** Under the two-step a missed webhook only *delays* a refund the
customer is already waiting for (the reviewer's own words); it causes no silent
loss. The cron sweep stays in scope as a backstop for *stuck* `submitted`
refunds (so a customer never waits indefinitely on a dropped webhook) but is a
fast-follow, not a blocker, and no longer load-bearing for loss measurement.

**N1 — rejected-void rate / scan-after-cancel race / status lag.** ✅ Accept as
context. Under the two-step SendMo does not pre-pay, so the rejected-void *rate*
no longer drives SendMo's P&L — it drives how often customers receive the
"denied" outcome. The scan-after-cancel race and the (now-fixed) tracker-webhook
status lag remain real and belong in the implementation proposal's edge-case
list.

**N2 — chargeback not eliminated.** ✅ Accept. With the two-step the customer
wait is *longer*, so chargeback exposure is the chosen design's primary cost.
The mitigation is comms — Email A ("refund submitted, here's why it takes
time"), now a decided requirement (Decision #5).

**N3 — partial-refund-then-cancel exceeds remaining balance.** ✅ Accept.
Directly addressed by Decision #3: the architecture is partial-refund-capable
end to end; the cancel path computes the *remaining refundable balance* and
never assumes the full original charge.

**Predicted pitfalls.** Pitfalls 1 and 2 are dissolved by the two-step (no
pre-payment). Pitfall 3 (first live refund fails, no admin tool) is addressed by
Decision #4 — the admin `/refunds` tool is a go-live blocker. Pitfall 4 (admin
cancel inherits 100%) is addressed by Decision #3 (partial-capable).

**Nits.** ✅ Accept all — the `cancel-label` `rejected`-copy cite is line 448,
not 447; the customer-facing time copy needs one consistent number; the two
`webhooks` directories (EasyPost `webhooks` vs `stripe-webhook`) must not be
conflated. Carried into the implementation proposal; this design-review
proposal's body is left as-authored per the protocol.

No author-vs-reviewer disagreements remain — there is no "Tradeoffs for John"
section.

## Decision

**Decided 2026-05-21 by John.** Outcome: **approve-with-changes.** The proposal's
*recommendation* (Option B — immediate refund) was **not** adopted: the review
showed B under-priced its loss exposure and that its measure-and-revisit safety
valve was structurally inoperable. John chose the EasyPost-gated two-step. The
proposal's value was the accurate diagnosis and the option framing that made
that an informed call.

The decided design:

1. **Two-step refund (EasyPost-gated).** The customer's card is refunded *only
   after* EasyPost confirms it has credited SendMo for the label cost. SendMo
   never fronts a refund it has not itself recovered.

2. **Third terminal outcome — "refund denied."** When EasyPost denies the void,
   the refund ends terminally at `refund_status='rejected'` — never refunded.
   Requires: a `refund.rejected` arm in the EasyPost webhook (the review
   confirmed none exists today); capture of EasyPost's denial reason
   (best-effort — EasyPost reasons are typically sparse, often just "carrier
   rejected"); a customer email (Decision #5); and an admin resolution path
   (Decision #4).

3. **Refunds are partial-capable by design.** No code path assumes a full-amount
   refund. The cancel path refunds the *remaining refundable balance*; the admin
   tool issues arbitrary partial amounts. `createRefund` already accepts
   `amount_cents` — the work is making every caller compute and pass the right
   amount.

4. **Admin reimbursement tool is a go-live blocker.** The `/refunds` Edge
   Function (admin-auth'd, partial-capable, `transactions`-ledger-respecting per
   PLAYBOOK Rule 16) ships *before* live mode opens to customers. SendMo will
   not run real customer charges with no refund tool — the first live refund
   failure must have a resolution path. This adds a dependency to Job 3.

5. **Three lifecycle emails.** Email A "refund submitted" at
   `refund_status→submitted` — sets the wait expectation; the primary chargeback
   mitigation. Email B "refund completed" at `refund_status→refunded`. Email C
   "refund could not be completed" at `refund_status→rejected`. Reconcile with
   WISHLIST #79 ("Failure-mode tracking emails — void/refund…") — annotate that
   entry, do not file a parallel one.

6. **Invalid-PM refund failure — documented edge case, manual resolution.** When
   a Stripe refund cannot reach the original payment method, *resolution* is
   manual and offline (John issues payment by other means). *Detection* is not
   manual: SendMo must catch Stripe's refund-failure signal (`charge.refund.updated`
   / refund `status='failed'`) and alert John, so the case is never silent.

7. **`rejected` admin queue + alerting (§4.3)** — in scope; ships with the admin
   tool.

**Next artifact:** a follow-up **implementation proposal** carrying the
file-by-file plan for #1–#7 (the `/refunds` function, partial-refund plumbing,
the webhook `refund.rejected` arm, the three emails, the failure-detection
alert, the admin `rejected` queue). That proposal goes through the protocol —
draft → fresh-eyes review → decision — before code lands. This design-review
proposal is now `decided` and closed.
