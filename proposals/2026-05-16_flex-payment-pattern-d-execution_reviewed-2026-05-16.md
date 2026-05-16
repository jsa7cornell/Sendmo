---
title: Flex payment Pattern D execution — single PR
slug: flex-payment-pattern-d-execution
project: sendmo
status: in-review
created: 2026-05-16
last_updated: 2026-05-16
reviewed: null
decided: null
author: Claude (Sonnet 4.6) — third-and-final pass after John's 2026-05-16 directive to standardize on one industry-norm pattern; supersedes both prior proposals on the same topic
reviewer: null
outcome: null
---

## Supersession notice

This proposal **supersedes** two prior proposals on the same topic:

- [`2026-05-15_payment-authorization-strategy.md`](2026-05-15_payment-authorization-strategy.md) — initial strategy, never decided
- [`2026-05-16_flex-payment-execution-pr1-pr2_reviewed-2026-05-16_decided-2026-05-16.md`](2026-05-16_flex-payment-execution-pr1-pr2_reviewed-2026-05-16_decided-2026-05-16.md) — execution plan that was decided then re-opened after John's 2026-05-16 directive ("PR1 and PR2 are hours apart, not eras... we should standardize on one pattern... validate that semantics match industry norms")

The decision authority is now this proposal. The two prior files stay in the directory as institutional memory (status will be bumped to `superseded` when this one is decided).

This proposal is grounded in [`2026-05-16_payment-auth-pattern-research.md`](2026-05-16_payment-auth-pattern-research.md), an Opus-4.7 deep-research pass over industry norms. The key finding: every comparable platform converges on save-PM + off_session-per-event; the "validate $cap is available" primitive doesn't exist on the merchant side, and "validate-and-void" is non-standard terminology I (the prior author) made up.

---

## 1. Context

### 1.1 What we're shipping

**One PR**, one coherent pattern. Pattern D from the research proposal:

```
At link setup (recipient onboarding step 22, or Reactivate from Dashboard):
  SetupIntent (saves PM to Stripe Customer, Stripe handles $0 ZDA verification with issuer)
  No $cap pre-auth. No persistent hold.

At each sender shipment (labels Edge Function):
  Fresh off_session PaymentIntent against the saved PM
  for the actual rate, capped server-side at link.max_price_cents

Failure logging:
  Every SetupIntent attempt → stripe_intents row (status + last_payment_error_code)
  Every off_session shipment PI → stripe_intents row + transactions ledger
  Every off_session decline → flip link to Inactive + queue recipient email
```

### 1.2 Why one PR, not two

The two-PR split in the superseded proposal existed because PR1 was trying to "unblock John today" with a different model than PR2's pivot — which created internal contradictions (PR1's helper voided a PI but PR1's labels function captured from it). Pattern D's onboarding-and-shipment semantics are now identical across what was PR1 and PR2, so the split has no purpose.

Single PR also means: John's stuck legacy link gets unblocked by the deploy itself, without needing to click Reactivate. His user has saved PMs from prior Add Card flows; under Pattern D's "is_funded" logic (has saved PM + PM not expired + link.status != cancelled), his link evaluates Active automatically.

### 1.3 Phase E (commit `ab92b3d`) — what gets reverted

The 2026-05-15 Phase E commit shipped a one-shot hold-and-capture model that's incompatible with reusable-link semantics. Code from that commit comes out:

- `payments/index.ts` — the entire `flex_hold` intent_role branch (the $cap manual-capture PI creation)
- `stripe-webhook/index.ts` — `amount_capturable_updated` handler's flex-specific code path (writes `holds` row, flips link draft→active for flex_hold); `succeeded` handler's flex-specific capture transitions (`holds.captured`, link `active→in_use`)
- `labels/index.ts` — the flex capture branch at lines ~336-454 (`capturePaymentIntent` from held PI)
- `RecipientStepFlexPayment.tsx` — the PI($cap)-confirm flow with Stripe Elements set up for manual-capture

What stays:
- The `holds` table itself (schema reserved for Phase 3 escrow per master proposal §3.8)
- `payment_methods` table + Add Card flow (commits `220b3e2`, `a467ab0`) — entirely unchanged
- `stripe_intents` table — extended with new columns, but existing rows stay valid
- Webhook `setup_intent.succeeded`, `payment_method.attached`, `payment_method.detached`, `charge.refunded`, `charge.dispute.created`, `payment_intent.succeeded` (for full-label automatic-capture PIs) — all unchanged

---

## 2. Architecture

### 2.1 Lifecycle map (concrete)

```
[Recipient creates flex link via /onboarding/flex or /links/new]
  → server: insert sendmo_links row (status='draft')
  → client: open Stripe Elements for SetupIntent
  → user enters card
  → confirmSetup → Stripe authenticates with issuer (ZDA $0 under the hood)
  → success
    ↓ webhook: setup_intent.succeeded → stripe_intents row (status='succeeded')
    ↓ webhook: payment_method.attached → payment_methods row (this user, this mode, default if first)
  → client: flip sendmo_links.status='active' (via server RPC or webhook trigger)
  → recipient sees Activated link

[Sender opens link]
  → GET /links?code=<short_code>
  → server computes is_funded:
      sendmo_links.status NOT IN (cancelled, expired)
      AND exists active default payment_methods row for link owner in link's mode
      AND that PM's exp_year/exp_month is not in the past
  → if !is_funded: return 410 with Inactive message
  → if is_funded: return link data, sender proceeds through flow

[Sender hits Confirm at end of flow]
  → labels Edge Function called
  → server validates rate ≤ link.max_price_cents (server-derived from EasyPost)
  → server creates off_session PI:
      createPaymentIntent({
        amount: display_price_cents,
        capture_method: 'automatic',
        customer: <recipient's customer>,
        payment_method: <default PM>,
        off_session: true,
        confirm: true,
        metadata: { source: 'flex_shipment', link_id, sendmo_user_id, easypost_shipment_id }
      })
  → if PI.status === 'succeeded':
      → proceed to EasyPost label buy
      → existing auto-refund on EasyPost failure unchanged
      → webhook: payment_intent.succeeded writes transactions.charge ledger row
  → if PI.status === 'requires_action' OR declined:
      → cancel the PI (so no half-state)
      → write stripe_intents row (status='failed', last_payment_error_code=<code>)
      → write link_state_events row (event='charge_failed')
      → flip sendmo_links to Inactive (set sendmo_links.status='active' to 'expired' OR set a new is_inactive flag — see §3.4)
      → return 402 to sender with friendly copy
      → webhook: payment_intent.payment_failed will also fire — that handler queues the recipient decline email

[Recipient receives decline email]
  → "Your payment failed when [sender name | "a sender"] was printing a shipping label using your link. We've temporarily deactivated the link. Click below to update your payment information and reactivate the link."
  → CTA → /dashboard?reactivate=<link_id>
  → Dashboard auto-opens AddCardModal (or focuses Reactivate button)
  → recipient adds new card OR updates existing → webhook fires → new PM becomes default → link returns Active automatically (no manual Reactivate step needed — the badge logic re-renders)

[Recipient clicks Reactivate from Dashboard (no decline; just wants to update)]
  → if no PM: open AddCardModal → on success, link auto-Active
  → if PM exists: open AddCardModal pre-filled to "add another card" (in case they want to replace)
  → Reactivate is essentially "manage payment" in Pattern D — it's not a verification action
```

### 2.2 What "Reactivate" actually does in Pattern D

Under the prior (hold-based) plans, Reactivate was a verification action — call a helper that creates a $cap PI to prove capacity. Under Pattern D, there's nothing to verify on the server side; the saved PM either exists or doesn't, and capacity is unknowable until the actual off_session charge.

So Reactivate becomes a UI affordance:
- **No PM saved** → button label "Add a card" → opens AddCardModal → link Active on success
- **PM saved but link Inactive** (decline path) → button label "Update payment" → opens AddCardModal → recipient adds new card OR re-confirms existing → link Active on next render
- **PM saved, link Active** → no Reactivate button shown (badge says Active; no action needed)

This makes "Reactivate" much more about UX clarity than server-side state. The actual recovery from a decline is: add or update a PM. Once that happens, the link comes back automatically.

### 2.3 Server-derived "is_funded" — exact logic

```sql
-- pseudo-SQL; actual implementation lives in links Edge Function
SELECT
  sl.status != 'cancelled' AND sl.status != 'expired' AS link_alive,
  EXISTS (
    SELECT 1 FROM payment_methods pm
    WHERE pm.user_id = sl.user_id
      AND pm.mode = <link_mode>
      AND pm.deleted_at IS NULL
      AND pm.is_default = true
      AND (
        pm.exp_year > EXTRACT(YEAR FROM now())::int
        OR (pm.exp_year = EXTRACT(YEAR FROM now())::int AND pm.exp_month >= EXTRACT(MONTH FROM now())::int)
      )
  ) AS has_usable_pm
FROM sendmo_links sl
WHERE sl.short_code = $1;

-- is_funded = link_alive AND has_usable_pm
```

No Stripe call. Pure DB query. Per John's 2026-05-16 Tradeoff 1 = Option A: the back-gate (off_session at confirm) is the source of truth; the front-gate just filters obvious dead links.

### 2.4 Failure logging surfaces (per John's 2026-05-16 ask)

Every payment-touching operation writes to either `stripe_intents` (Stripe state mirror) or `transactions` (ledger). The interesting failure cases:

| Event | Where logged | Fields of interest |
|---|---|---|
| SetupIntent succeeded | `stripe_intents` row (webhook) | `intent_kind='setup', status='succeeded'` |
| SetupIntent failed (decline) | `stripe_intents` row (webhook) | `intent_kind='setup', status='failed', last_payment_error_code` |
| SetupIntent failed (no webhook fired) | server-side `event_logs` warn entry | `event_type='setup_intent.no_webhook'` |
| Off_session PI succeeded | `stripe_intents` + `transactions.charge` | as today |
| Off_session PI declined | `stripe_intents` row (status='failed', error_code) + `link_state_events` row | `event='charge_failed', reason=<error_code>` |
| Recipient PM auto-detached by Stripe (e.g., card issuer revoked) | `payment_method.detached` webhook → flip link to Inactive if no other PMs | existing handler |
| Card account-updater push (PM auto-updated) | `payment_method.automatically_updated` webhook — **NEW handler in this PR** | logs the update; PM stays usable |

The `last_payment_error_code` column gives us per-decline analytics ("what's our decline rate by error type?") without trawling Stripe Dashboard. Critical for diagnosing whether the SetupIntent-only model is missing something the $1 verification would have caught.

---

## 3. File-by-file plan

### 3.1 Migration (one new file)

```
supabase/migrations/<NN>_pattern_d_stripe_intents_columns_and_link_state_events.sql
```

Adds:
- `stripe_intents.payment_method_id TEXT` — populated for off_session PIs and for SetupIntents (the PM that was attached). Indexed for "what's the current state of this PM?" queries.
- `stripe_intents.cancellation_reason TEXT` — populated when status='canceled'
- `stripe_intents.last_payment_error_code TEXT` — populated when status='failed'

Creates `link_state_events` table:
```sql
CREATE TABLE public.link_state_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    link_id     UUID NOT NULL REFERENCES sendmo_links(id) ON DELETE CASCADE,
    event       TEXT NOT NULL CHECK (event IN (
                  'created', 'activated', 'reactivated',
                  'charge_failed', 'pm_detached', 'pm_expired',
                  'rotated', 'cancelled_by_user'
                )),
    reason      TEXT,        -- stripe error code, etc.
    actor_user  UUID REFERENCES profiles(id),
    metadata    JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_link_state_events_link_time ON link_state_events (link_id, created_at DESC);
CREATE INDEX idx_link_state_events_event_time ON link_state_events (event, created_at DESC);

-- RLS
ALTER TABLE link_state_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role full" ON link_state_events FOR ALL TO service_role USING (true);
CREATE POLICY "user reads own" ON link_state_events FOR SELECT TO authenticated
  USING (link_id IN (SELECT id FROM sendmo_links WHERE user_id = auth.uid()));
```

Adds comment on `holds` table:
```sql
COMMENT ON TABLE public.holds IS
  'Reserved for Phase 3 escrow per master proposal §3.8. Flex flow does
   NOT write to this table as of <PR commit hash> (Pattern D pivot —
   see proposals/2026-05-16_flex-payment-pattern-d-execution.md).
   Legacy rows from Phase E commit ab92b3d may exist but are no-ops.';
```

LOC: ~80.

### 3.2 Edge Functions

| File | Change | LOC |
|---|---|---|
| `supabase/functions/_shared/stripe.ts` | Add `createOffSessionPaymentIntent` helper (wraps existing `createPaymentIntent` with off_session-specific defaults). Existing `createPaymentIntent`, `cancelPaymentIntent`, `createCustomer` etc. unchanged. | ~50 |
| `supabase/functions/payments/index.ts` | **Remove** the `flex_hold` intent_role branch added in `ab92b3d` (~100 LOC deletion). Keep the full-label automatic-capture branch unchanged. Keep `reactivate-link` route (but its logic simplifies — see §3.5 client side) | ~100 deletions, ~20 additions |
| `supabase/functions/stripe-webhook/index.ts` | (a) **Remove** the `amount_capturable_updated` handler's flex-specific code (writes to `holds`, flips link draft→active). The full event handler can stay for any non-flex use (defensive — unlikely). (b) **Remove** the `succeeded` handler's flex-capture transitions (`holds.captured`, link `active→in_use`); keep the ledger `transactions.charge` write for **all** PIs including flex off_session shipments (this works under the new model). (c) **Augment** `setup_intent.succeeded` to also write `payment_method_id` to the `stripe_intents` row when available. (d) **Augment** `payment_intent.payment_failed` for `metadata.source='flex_shipment'`: write `link_state_events` (event='charge_failed'), flip link Inactive, queue recipient decline email via Resend. (e) **NEW** handler `payment_method.automatically_updated`: log update, refresh `payment_methods.exp_year/exp_month` from event payload. | ~140 net (with deletions) |
| `supabase/functions/labels/index.ts` | **Replace** flex capture branch (~lines 336-454 from `ab92b3d`): when called for a flex link (link_short_code present, no explicit payment_intent_id), lookup recipient's default PM → create off_session PI for display_price_cents with metadata `{source:'flex_shipment', link_id, sendmo_user_id, easypost_shipment_id}` → if succeeded continue with EasyPost buy; if declined cancel PI + return 402 with friendly copy. **Preserve** link state transitions and recipient resolution (lines ~698-820 per prior review finding #7). **Preserve** auto-refund logic for EasyPost buy failure. | ~180 (net) |
| `supabase/functions/links/index.ts` | (a) GET endpoint: compute `is_funded` from DB-only state (see §2.3 SQL). Return as field on response (rename from `has_active_hold`). (b) **NEW** `POST /:id/rotate` endpoint — generate new short_code, mark old as `cancelled`, write `link_state_events.rotated` row. | ~120 |
| `supabase/functions/_shared/resend.ts` + `email-templates.ts` | NEW email template `payment_declined_reactivate` with John's exact 2026-05-16 copy. Deep link to `/dashboard?reactivate=<link_id>` | ~60 |

### 3.3 Frontend

| File | Change | LOC |
|---|---|---|
| `src/components/recipient/RecipientStepFlexPayment.tsx` | **Replace** the PI($cap)-confirm flow from `ab92b3d` with a SetupIntent flow (same pattern as AddCardModal). Calls `/payment-methods` to create SetupIntent → confirms via Stripe Elements → on success, server-side trigger to set `sendmo_links.status='active'`. | ~80 (net: replace) |
| `src/pages/Dashboard.tsx` | (a) Rename "Default" badge → "Primary"; sort primary PM to top of wallet list. (b) Replace "Needs payment" badge with "Active"/"Inactive" badge derived from new server-side `is_funded` query (added to the existing link query). (c) Rename "Reactivate" button to "Update payment" when Inactive AND PM exists; "Add a card" when no PM. (d) On `?reactivate=<link_id>` URL param (from decline email), auto-focus the link card + open AddCardModal. (e) **NEW** URL-rotate button under link card with confirmation modal. | ~120 |
| `src/pages/SenderFlow.tsx` | Update intro-step Inactive error to use new `is_funded` field. Update Confirm-step error handler to surface the off_session decline copy: "Your payment couldn't be processed right now. The link's been deactivated and we've notified the recipient." | ~25 |
| `src/lib/api.ts` | Rename `LinkData.has_active_hold` → `is_funded`. Add `rotateLinkUrl({ link_id, accessToken })`. Update `reactivateLink` semantics (now just routes to AddCardModal, no separate endpoint needed — drop the endpoint OR keep it as a no-op for client backward compat). | ~40 |

### 3.4 Open schema question — how do we flip a link to "Inactive"?

Two options:
- **Option α** — keep `sendmo_links.status` enum, add a new value `'inactive'`. CHECK constraint migration.
- **Option β** — keep the enum unchanged; "Inactive" externally is **computed** from the `is_funded` query (link.status='active' but no usable PM = Inactive). No DB write needed on decline; the next read sees the new state.

My pick: **β**. Simpler. The status enum stays for hard states (draft/active/cancelled/expired). The "soft" Inactive on decline is derived. The advantage: when the recipient updates their PM, the link automatically becomes Active again on next render — no UPDATE needed.

The only subtlety: on a charge_failed event, we still want to record `link_state_events.charge_failed` for the audit trail and to trigger the email. But we don't UPDATE `sendmo_links.status` to anything new.

### 3.5 Docs

| File | Change |
|---|---|
| `SPEC.md` §13 | Rewrite Payment System / flex section: SetupIntent at link creation, off_session per shipment, decline-recovery email. Drop "manual capture hold" language. |
| `SPEC.md` §7 step 22 | Copy updates: "Add your card to fund this link" instead of "Authorize a hold." |
| `SPEC.md` §22 | Add `flex-payment.spec.ts` to e2e catalog. |
| `WISHLIST.md` | Add: nightly background PM validation (periodic health check); 30-day card-expiry warning email; LinksEditor /links/new payment-validation integration; sender-self-paid-fallback flow with recipient address prefilled; fraud mitigation (rate limits if needed once front-gate ever does Stripe calls). |
| `LOG.md` | Entry with `Browser-verified:` block (spec shape — references the new e2e). |

### 3.6 Tests

| File | Change | LOC |
|---|---|---|
| `tests/unit/Dashboard.test.tsx` | Update "Default" → "Primary" assertion. Add tests for Active/Inactive badge states. Add tests for Reactivate/Update payment button label switching. Add test for `?reactivate=<id>` URL param auto-opens AddCardModal. | ~90 |
| `tests/integration/flex-off-session-charge.test.mjs` | NEW — labels Edge Function called for flex link, asserts off_session PI created against default PM, asserts ledger row written on success, asserts link_state_events row written on decline. | ~120 |
| `tests/integration/links-is-funded.test.mjs` | NEW — GET /links?code=<short_code>: is_funded=true when PM exists + unexpired + link active; is_funded=false on each failure mode | ~80 |
| `tests/e2e/flex-payment.spec.ts` | NEW — full flex flow: recipient creates link via SetupIntent → link Active; sender opens link → front gate passes → fills form → confirms → off_session charge succeeds → label generated; decline path → link Inactive → email queued → recipient updates card → link Active; URL rotation → old code 410s, new code works. | ~250 |

### 3.7 Total estimate

~1,400 LOC including tests, docs, deletions. Single PR. Larger than the prior PR1 (~545) but smaller than PR1+PR2 combined (~1,650), and crucially **internally consistent** instead of split-with-temporary-asymmetry.

---

## 4. Test plan

### 4.1 Unit
- Dashboard: Primary badge, Active/Inactive transitions, Reactivate button label switching, URL-param-driven auto-open

### 4.2 Integration
- Labels Edge Function flex branch: off_session success, off_session decline → link state, missing PM → 402, expired PM → 402, cap exceeded → 402
- Links Edge Function: is_funded computation for all combinations of (link status, PM state, PM expiry)
- Reactivate path (if endpoint kept as no-op or simplified) — basic contract test

### 4.3 E2E (Playwright)
The single spec covers the user-visible critical paths:
- **Happy path:** recipient signup → create link → SetupIntent → link Active → sender uses link → label generated → both see expected screens
- **Decline path:** force-decline test card → sender sees friendly error → recipient receives decline email → recipient updates card → link Active → sender retries → succeeds
- **PM expiry path:** simulate card past exp_year/exp_month → front gate marks Inactive → recipient updates → Active
- **URL rotation:** recipient rotates → old short_code returns 410 → new short_code works
- **PM removed mid-life:** recipient removes only PM → existing link flips Inactive on next visit (front gate detects no PM)

### 4.4 Backward-compat verification
- John's stuck legacy link (`BDnsjZTAhq`) should evaluate `is_funded=true` after deploy because his user has saved PMs and the link isn't cancelled. No Reactivate click required.

---

## 5. Out of scope

Explicitly NOT in this PR — added to WISHLIST:
- The $1 verification auth (Airbnb pattern) at SetupIntent confirmation — start with SetupIntent only per John's 2026-05-16 directive; reconsider only if decline-rate telemetry shows we're missing something
- Nightly background PM validation cron
- 30-day card-expiry warning email
- LinksEditor `/links/new` integration update (currently still creates links without payment validation — that path needs its own pass)
- Sender-self-paid-fallback flow (recipient address prefilled)
- Fraud mitigation infrastructure (no public Stripe-touching endpoint exists in Pattern D, so this isn't load-bearing)
- Periodic decline-rate analytics dashboard (worth doing once we have ≥30 days of `stripe_intents.last_payment_error_code` data)
- Phase 3 escrow

---

## 6. Verification

After implementation, before commit:

1. TypeScript clean (`npx tsc --noEmit`)
2. Lint clean (`npm run lint`)
3. Unit tests pass (`npm run test:unit`)
4. Integration tests pass against local Supabase (`npm run test:integration` if it exists; else exercise via the .mjs scripts in `tests/integration/`)
5. E2E spec passes against dev server (`npm run test:e2e`)
6. Stage all changes (`git add`), do NOT commit
7. Spawn code-reviewer agent on staged diff
8. Apply blocking findings, re-run TS/lint/tests
9. Commit + push
10. Deploy Edge Functions to Supabase, deploy frontend via Vercel
11. mcp-session browser verification:
    - John's stuck link `BDnsjZTAhq` shows "Active" badge after deploy (no click)
    - New flex link can be created end-to-end
    - Sender flow on new link generates a label
    - Force-decline test card → sender sees friendly error, recipient sees Inactive + receives email
    - Update card → link returns Active

---

## 7. Open questions

Items the fresh-eyes reviewer should weigh in on:

1. **Reactivate endpoint kept or dropped?** Pattern D doesn't need a server-side reactivation action — the recipient just needs to add/update a PM. We could (a) drop the `/payments/reactivate-link` route entirely, (b) keep it as a no-op that returns the link's current is_funded state, or (c) keep it as a "force-refresh the link's is_funded check" (no-op in practice since it's stateless). My read: drop entirely; the Reactivate button on Dashboard becomes a pure client-side action (opens AddCardModal). Simpler.

2. **Option α vs β on link Inactive state (§3.4).** I picked β (computed Inactive, no status enum change). Reviewer: is there a real downside to this — e.g., does the `transactions` ledger or any other read site assume "link.status='active' means functional"?

3. **`payment_method_automatically_updated` webhook handler — include or wishlist?** It's small (~20 LOC) but pure scope-add. My read: include — it's free defense against silent card replacements that otherwise would manifest as off_session declines.

4. **`link_state_events` event enum.** Sketched as `('created', 'activated', 'reactivated', 'charge_failed', 'pm_detached', 'pm_expired', 'rotated', 'cancelled_by_user')`. Anything missing? Anything that should be merged?

5. **`stripe_intents.payment_method_id` backfill.** New column, NULL for existing rows. Should the migration attempt a backfill (re-fetching PIs from Stripe to populate)? My read: no — historical rows don't need it; new rows will populate. Reviewer: any analytics that need it on legacy rows?

6. **Where exactly does `sendmo_links.status='draft' → 'active'` flip happen on SetupIntent success?** The webhook is the natural place but webhooks are fire-and-forget from the client's perspective. The recipient might see step 23 "Activating your link…" for a few seconds before the webhook lands. Options: (a) accept the brief lag, (b) flip status synchronously from a server endpoint the client polls, (c) flip status optimistically in the client and let the webhook reconcile. My read: (a). Reviewer: is the lag long enough to be a real UX problem?

7. **Decline email rate-limiting.** If a single bad sender hammers a link 50 times, we don't want to email the recipient 50 times. Pattern: dedup by `(link_id, day)` — at most one decline email per link per day. Cost: store the last-sent timestamp on `sendmo_links` (or on the user) and check before sending. Reviewer: is this worth doing in this PR, or wishlist?

8. **Migration ordering / mid-flow recipient backward compat at deploy.** A recipient in step 22 currently confirming a Phase-E `flex_hold` PI in Stripe Elements at the moment of deploy — what happens? The new code expects a SetupIntent flow. Most likely answer: low-traffic, low-stakes, accept the breakage. Reviewer: agreed, or worth a graceful-degradation note?

---

<!-- Sections 8-11 (Review, Author response, Tradeoffs for John, Decision) appended as the proposal progresses. -->
