---
title: Flex payment Pattern D execution — single PR
slug: flex-payment-pattern-d-execution
project: sendmo
status: reviewed
created: 2026-05-16
last_updated: 2026-05-17
reviewed: 2026-05-16
decided: null
author: Claude (Sonnet 4.6) — operationalizes the Pattern D recommendation from the 2026-05-16 industry-research proposal
reviewer: Claude (Opus 4.7, 1M context) fresh-eyes session
outcome: null
---

## 0. Glossary

### Concepts / acronyms

| Term | Meaning |
|---|---|
| **Flex link** | A reusable SendMo URL (`sendmo.co/s/<short_code>`) created by a recipient. Multiple independent senders use the same URL over time, each spawning a child shipment. |
| **Full-label link** | One-shot link: recipient pays at link creation, the label is minted immediately, the URL is just a viewer. Different code path from flex; **untouched by this PR**. |
| **Recipient** | The party who creates a link and whose card gets charged. |
| **Sender** | Anonymous user who uses a flex link to ship something to the recipient. No login. |
| **Cap** | `sendmo_links.max_price_cents` — the maximum amount the recipient agrees to be charged per individual shipment. Server-enforced. |
| **`is_funded`** | Computed boolean returned by `GET /links?code=…`. True when the link can accept new shipments. DB-only query (no Stripe call). |
| **Active / Inactive** | External binary state for the user-visible badge. **Computed** from `is_funded`, not stored in DB. The DB enum (`draft / active / cancelled / expired`) stays for hard states. |
| **Off_session charge** | A PaymentIntent created server-side against a saved PM without the cardholder present. Stripe params: `off_session: true, confirm: true, payment_method=<pm>`. |
| **SetupIntent (SI)** | Stripe primitive for saving a card without charging. Stripe handles card-issuer verification automatically (ZDA where supported, $1 fallback otherwise). |
| **ZDA** | Zero-Dollar Authorization. Visa/MC primitive for "is this card valid?" that doesn't generate a real charge. Stripe uses this internally inside SetupIntent. |
| **MIT / CIT** | Stripe terminology. CIT = Customer-Initiated Transaction (user on session); MIT = Merchant-Initiated Transaction (off_session charge after consent at SetupIntent). |
| **CAU** | Card Account Updater. Visa/MC service that pushes new card numbers/expiries to merchants when issuers re-issue. Stripe relays as `payment_method.automatically_updated` webhook. |
| **3DS / SCA** | 3-D Secure / Strong Customer Authentication. EU/UK regulation requiring cardholder authentication for some transactions; manifests as `requires_action` status. Out-of-scope for v1 (US only). |
| **`stripe_intents`** | Our DB table mirroring Stripe PI/SI state. UPSERTed by webhooks. |
| **`payment_methods`** | Our DB table of saved cards (one row per attached PM per user per mode). |
| **`holds`** | Existing DB table from Phase E. **Pattern D stops writing to it.** Reserved for Phase 3 escrow per master proposal §3.8. |
| **`link_state_events`** | New table in this PR. Audit log for flex link lifecycle transitions (charge_failed, pm_detached, rotated, etc.). |
| **`payment_validations`** | Not used in this PR. Was in prior drafts; dropped because Pattern D doesn't need a separate audit table — `stripe_intents` is sufficient with new columns. |

### Services and surfaces

| Component | Role | Touched by this PR? |
|---|---|---|
| `_shared/stripe.ts` | Stripe REST client wrappers | Yes — add `createOffSessionShipmentPI` sibling helper |
| `payments/` Edge Function | Creates PIs / SetupIntents | Yes — remove Phase E flex_hold branch (~150 LOC deletion) |
| `payment-methods/` Edge Function | Add Card flow (SetupIntent) | No (existing SetupIntent flow unchanged) |
| `links/` Edge Function | Resolve / create / rotate links | Yes — `is_funded` computation; new `POST /:id/rotate` route |
| `labels/` Edge Function | Buy EasyPost label after payment | Yes — replace flex capture branch with off_session charge |
| `stripe-webhook/` Edge Function | Process Stripe events | Yes — augment `payment_intent.payment_failed`; add `payment_method.automatically_updated` |
| `tracking/` Edge Function | Polls EasyPost; triggers refunds | No |
| `cancel-label/` Edge Function | Voids labels | No |
| `RecipientStepFlexPayment.tsx` | Onboarding step 22 UI | Yes — replace PI($cap) Elements flow with SetupIntent flow |
| `Dashboard.tsx` | Recipient's home | Yes — Primary badge rename, Active/Inactive, decline-email deep link, URL rotate button |
| `SenderFlow.tsx` | Sender 5-step wizard | Yes — error UX update for off_session decline |
| `_shared/resend.ts` + `email-templates.ts` | Email sending | Yes — new `payment_declined_reactivate` template |

### Stripe object lifecycle (Pattern D)

```
SetupIntent (link creation):
  requires_payment_method
   → requires_confirmation
    → (Stripe auths card with issuer; ZDA where supported)
     → succeeded   ← we record this; PM is attached to Customer
     → canceled / failed   ← logged via last_payment_error_code

PaymentIntent (per sender shipment):
  Created with confirm=true off_session=true → resolves synchronously to:
   → succeeded   ← capture happens automatically; we proceed to EasyPost
   → requires_action   ← treated as decline in v1 (no SCA recovery)
   → canceled / failed   ← link flips Inactive; recipient email queued
```

---

## 1. Context

A flex link is reusable — one URL, N senders, N child shipments. The current Phase E implementation tries to pre-authorize a single $cap hold and capture from it on first sender use, which (a) is single-capture by Stripe's design, (b) expires after 7 days by card-network rule, and (c) breaks the moment a second sender tries to use the same link. The reusable-link semantics that SendMo's product actually needs require a different model.

**Pattern D** (per the 2026-05-16 industry research proposal) is the model the rest of the world converges on: save the card via SetupIntent at link creation, charge it off_session per shipment. No persistent hold. No pre-auth UX. The card is the funding instrument; the link is just an addressable destination.

**Divergence from research:** the research recommended D' (D + a small zero-dollar verification step at save). John (2026-05-16) explicitly directed: "Let's just start with a SetupIntent and see if we get failures." This PR ships strict Pattern D and relies on the new `stripe_intents.last_payment_error_code` column to surface decline rates. If telemetry shows the missing verification is costing measurable declines, D' is a clean follow-up (helpers and schema are already shaped for it).

**Backward compat:** John's stuck legacy link (`BDnsjZTAhq`) is `status='active'` in the DB and his user has saved PMs from prior Add Card flows. Under Pattern D's `is_funded` logic, the link evaluates Active automatically at deploy time — no manual Reactivate click needed.

---

## 2. Architecture

### 2.1 Lifecycle

```
LINK CREATION (recipient onboarding step 22, or "+ New Link" on dashboard)
  → insert sendmo_links row (status='draft')
  → open Stripe Elements for SetupIntent (existing AddCardModal pattern)
  → confirmSetup → Stripe validates card with issuer
  → webhook: setup_intent.succeeded → write stripe_intents row
  → webhook: payment_method.attached → write payment_methods row
  → flip sendmo_links.status='draft' → 'active' (in webhook, after PM lands)
  → recipient lands on step 23 ("Your link is active")

SENDER USES LINK
  → GET /links?code=<short> → returns is_funded (DB-only)
  → if !is_funded: 410 "This link isn't accepting payments"
  → if is_funded: sender proceeds through 4 steps; hits Confirm
  → labels Edge Function:
     - server-derive display_price_cents from EasyPost rate (existing)
     - server-enforce cap: display_price_cents <= link.max_price_cents
     - lookup recipient's default PM
     - createOffSessionShipmentPI(amount=display_price_cents, customer, payment_method=<default>)
     - on succeeded:
        → buy EasyPost label (existing path; auto-refund on failure unchanged)
        → webhook payment_intent.succeeded writes transactions.charge ledger row
     - on declined / requires_action:
        → cancel the PI
        → write link_state_events row (event='charge_failed', reason=<error_code>)
        → queue recipient decline email (inline, with 5s timeout; fallback to event_logs on failure)
        → return 402 to sender with friendly copy

RECIPIENT GETS DECLINE EMAIL
  → "Your payment failed when [sender] was printing a shipping label using
     your link. We've temporarily deactivated the link. Click below to update
     your payment information and reactivate the link."
  → CTA → /dashboard?reactivate=<link_id>
  → dashboard auto-opens AddCardModal
  → user adds card → SetupIntent → payment_method.attached webhook
  → new PM becomes default → is_funded re-evaluates true → link Active again
  → (no explicit "reactivate" server call — pure state recomputation)

URL ROTATION (recipient action)
  → POST /links/:id/rotate
  → generate new short_code; mark old as status='cancelled'
  → write link_state_events row (event='rotated')
  → old URL returns 410; new URL works immediately (no grace window)
```

### 2.2 `is_funded` SQL (the front gate)

DB-only query, no Stripe call. Run by the `links` Edge Function's GET endpoint:

```sql
SELECT
  sl.status NOT IN ('cancelled', 'expired', 'completed', 'used') AS link_alive,
  EXISTS (
    SELECT 1 FROM payment_methods pm
    WHERE pm.user_id = sl.user_id
      AND pm.mode = $link_mode
      AND pm.deleted_at IS NULL
      AND pm.is_default = TRUE
      AND (
        pm.exp_year > EXTRACT(YEAR FROM now())::int
        OR (pm.exp_year = EXTRACT(YEAR FROM now())::int
            AND pm.exp_month >= EXTRACT(MONTH FROM now())::int)
      )
  ) AS has_usable_pm
FROM sendmo_links sl
WHERE sl.short_code = $1;

-- is_funded = link_alive AND has_usable_pm
```

Notes:
- `'used'` and `'completed'` are filtered defensively (vestigial Phase-E values; no new rows written by Pattern D, but legacy rows exist)
- `'in_use'` is NOT filtered — Phase E flipped flex links to `'in_use'` on every shipment; Pattern D removes that flip + backfills legacy `'in_use'` rows to `'active'` in this PR's migration
- The query uses the existing `(user_id, mode) WHERE is_default = TRUE AND deleted_at IS NULL` partial index on `payment_methods` (migration 022)
- The `links` GET endpoint already SELECTs `user_id`; the join is on a column we already fetch

### 2.3 Failure logging surfaces

Every payment-touching operation writes audit data. Critical for diagnosing whether strict Pattern D is missing what D' would catch:

| Event | Destination | Key fields |
|---|---|---|
| SetupIntent succeeded | `stripe_intents` (webhook) | `intent_kind='setup', status='succeeded', payment_method_id` |
| SetupIntent declined / failed | `stripe_intents` (webhook) | `status='failed', last_payment_error_code` |
| Off_session PI succeeded | `stripe_intents` + `transactions.charge` (webhook) | as today |
| Off_session PI declined | `stripe_intents` + `link_state_events` (labels-fn synchronous) | `status='failed', last_payment_error_code` + `event='charge_failed'` |
| PM auto-updated by issuer | `payment_methods` row updated; `link_state_events` row | new exp/last4 |
| Decline email sent | `sendmo_links.last_decline_email_at` UPDATE (gates per-day dedup) | timestamp |
| Decline email send failed | `event_logs` row `event_type='decline_email.send_failed'` | for manual replay |

After 4 weeks of data on `stripe_intents.last_payment_error_code` we'll know whether the missing ZDA verification is costing real declines.

### 2.4 Concurrency / race notes

- **SetupIntent → link active flip:** the flip happens in `payment_method.attached` webhook handler. Client-side, step 23 polls a `GET /links/:id` endpoint every 2s for up to 30s; falls back to a manual "Refresh" button if the webhook is delayed (rare; Stripe webhooks usually land in <2s).
- **Off_session decline → email send:** inline in the labels Edge Function (not in the webhook handler) — the webhook handler is unreliable for `requires_action` because Stripe doesn't always fire `payment_intent.payment_failed` for that case. Inline send with 5s timeout; on timeout, write `event_logs` row for manual replay.
- **Decline email dedup:** `(link_id, day)` bucket via `sendmo_links.last_decline_email_at`. Prevents a fraud-probe-against-stale-link from sending 50 emails.

---

## 3. File-by-file plan

### 3.1 Migration (one new file)

`supabase/migrations/<NN>_pattern_d_columns_and_link_state_events.sql` — ~95 LOC

Adds:
- `stripe_intents.payment_method_id TEXT` (indexed; used for "current state of this PM" queries)
- `stripe_intents.cancellation_reason TEXT`
- `stripe_intents.last_payment_error_code TEXT`
- `sendmo_links.last_decline_email_at TIMESTAMPTZ NULL` (dedup gate)

Creates `link_state_events`:
```sql
CREATE TABLE public.link_state_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    link_id     UUID NOT NULL REFERENCES sendmo_links(id) ON DELETE CASCADE,
    event       TEXT NOT NULL CHECK (event IN (
                  'created', 'activated', 'reactivated',
                  'charge_failed', 'pm_detached', 'pm_expired',
                  'rotated', 'cancelled_by_user'
                )),
    reason      TEXT,
    actor_user  UUID REFERENCES profiles(id),
    metadata    JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lse_link_time ON link_state_events (link_id, created_at DESC);
CREATE INDEX idx_lse_event_time ON link_state_events (event, created_at DESC);

ALTER TABLE link_state_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role full" ON link_state_events FOR ALL TO service_role USING (true);
CREATE POLICY "user reads own" ON link_state_events FOR SELECT TO authenticated
  USING (link_id IN (SELECT id FROM sendmo_links WHERE user_id = auth.uid()));
```

Comments + backfill:
```sql
COMMENT ON TABLE public.holds IS
  'Reserved for Phase 3 escrow per master proposal §3.8. Flex flow no longer writes here.';

-- Backfill legacy single-shot status on flex links (idempotent)
UPDATE public.sendmo_links
SET status = 'active'
WHERE link_type = 'flexible' AND status = 'in_use';
```

### 3.2 Edge Functions

| File | Change | LOC |
|---|---|---|
| `_shared/stripe.ts` | Add `createOffSessionShipmentPI` as a **sibling** to `createPaymentIntent` (NOT a wrapper — existing helper hardcodes `automatic_payment_methods: { enabled: true }` which Stripe rejects when combined with `payment_method` + `confirm: true`). New helper sends `payment_method`, `off_session: true`, `confirm: true`, no `automatic_payment_methods`. | ~60 |
| `payments/index.ts` | Remove the entire `flex_hold` intent_role branch added in Phase E. Full-label automatic-capture path unchanged. The dashboard-side "Reactivate" button needs no endpoint — pure UI affordance. | ~150 deletions, ~10 additions |
| `stripe-webhook/index.ts` | (a) Remove `amount_capturable_updated` flex-specific code (holds-row insert, draft→active flip). (b) Remove `succeeded` flex-specific transitions (`holds.captured`, link `active→in_use`); keep ledger `transactions.charge` write for all PIs. (c) Augment `setup_intent.succeeded` to also write `payment_method_id`. (d) On `payment_method.attached` for a flex-link recipient, flip their draft links to active. (e) NEW: `payment_method.automatically_updated` handler — update `payment_methods` row from event payload; if brand changed, flip affected links to require re-validation. | ~140 net |
| `labels/index.ts` | Replace flex capture branch (~lines 336-454): lookup recipient's default PM → call `createOffSessionShipmentPI` → on succeeded proceed with EasyPost buy; on decline/`requires_action` cancel PI + write `link_state_events` + send decline email inline (5s timeout, `event_logs` fallback) + return 402. **Remove** `active→in_use` flip at ~lines 807-817 (Pattern D keeps flex links active indefinitely). Add rate limit: 5/60s per (IP + link_short_code) for the flex path (pattern matches `cancel-label/index.ts:41-53`). | ~210 net |
| `links/index.ts` | (a) GET endpoint: compute `is_funded` per §2.2 SQL; rename response field from `has_active_hold`. (b) NEW `POST /:id/rotate` endpoint — generate new short_code, mark old `cancelled`, write `link_state_events.rotated` row. (c) NEW `GET /links/:id` (auth'd) — returns single link status for the step 23 polling pattern. | ~130 |
| `_shared/resend.ts` + new `email-templates.ts` template | NEW template `payment_declined_reactivate`. Deep link to `/dashboard?reactivate=<link_id>`. | ~60 |

### 3.3 Frontend

| File | Change | LOC |
|---|---|---|
| `RecipientStepFlexPayment.tsx` | Replace PI($cap) Elements flow with SetupIntent flow (mirrors AddCardModal pattern). Calls `/payment-methods` for SI client_secret; confirmSetup; on success polls `GET /links/:id` until status='active' (up to 30s) then advances to step 23. | ~90 net |
| `Dashboard.tsx` | (a) Rename "Default" PM badge → "Primary"; sort primary to top of wallet list. (b) Active/Inactive link badge from new `is_funded` query. (c) Rename "Reactivate" → "Update payment" when Inactive AND PM exists; "Add a card" when no PM. (d) On `?reactivate=<link_id>` URL param, auto-open AddCardModal. (e) NEW URL-rotate button with confirmation modal. | ~120 |
| `SenderFlow.tsx` | Update intro-step Inactive error to use new `is_funded`. Update Confirm-step error handler for off_session decline copy. | ~25 |
| `lib/api.ts` | Rename `LinkData.has_active_hold` → `is_funded`. Add `rotateLinkUrl({ link_id, accessToken })`. | ~40 |

### 3.4 Docs and tests

| File | Change |
|---|---|
| `SPEC.md` | §13 rewrite flex payment section (SetupIntent + off_session per shipment + decline recovery); §7 step 22 copy update; §22 add `flex-payment.spec.ts` |
| `WISHLIST.md` | Add: ZDA verification at save (Pattern D'); nightly background PM validation; 30-day card-expiry warning email; LinksEditor /links/new validation integration; sender self-paid fallback; multi-PM retry on decline; SCA recovery flow; enum cleanup (drop `in_use`/`completed` from sendmo_links.status enum) |
| `LOG.md` | Entry with `Browser-verified:` spec-shape block referencing the new e2e |
| `tests/unit/Dashboard.test.tsx` | Primary badge; Active/Inactive transitions; button label switching; `?reactivate=` URL param handling | ~90 LOC |
| `tests/integration/flex-off-session-charge.test.mjs` | NEW. Off_session success, decline, missing PM, expired PM, cap exceeded. | ~120 LOC |
| `tests/integration/links-is-funded.test.mjs` | NEW. All combinations of (link status, PM state, PM expiry). | ~80 LOC |
| `tests/e2e/flex-payment.spec.ts` | NEW. Full flex flow with mocked Stripe: happy path, decline path, PM expiry, URL rotation, PM removed mid-life. | ~250 LOC |

**Total: ~1,460 LOC** including tests, docs, deletions.

---

## 4. Tests

Three layers, in order of speed:

1. **Unit (Vitest)** — Dashboard component behavior. Runs on every commit.
2. **Integration (Node scripts against local Supabase)** — Edge Function contract tests: labels off_session, is_funded matrix, reactivate-link contract. Runs in CI.
3. **E2E (Playwright)** — full flex flow including SetupIntent, off_session decline, URL rotation. Runs against `npm run dev`.

Failure-mode coverage per PLAYBOOK Rule 19 variant-axis:
- Payment paths × {full-prepaid, flex-link} × {test-mode, live_comp, live_charge}: full-label is untouched; flex covered by new specs
- Shipment lifecycle × {label_created, in_use, cancelled, completed, expired}: flex link state changes covered
- Cancel/change auth × {authed, anonymous-with-cancel-token, anonymous}: unchanged

---

## 5. Verification

Pre-commit (in this implementation session):

1. `npx tsc --noEmit` clean
2. `npm run lint` clean
3. `npm run test:unit` passes
4. Integration tests run against local Supabase
5. Stage diff (`git add`); do NOT commit
6. Spawn code-reviewer agent on staged diff
7. Apply blocking findings; re-run TS/lint/tests
8. Commit + push
9. Deploy Edge Functions + Vercel frontend

Post-deploy browser verification (Rule 19 mcp-session shape):

10. John's stuck link `BDnsjZTAhq` shows "Active" badge after deploy with no click (validates the legacy-link auto-recovery claim)
11. New flex link can be created end-to-end via SetupIntent
12. Sender opens the new link → fills form → confirms → label generated successfully (validates the off_session charge path)
13. Force-decline test card (`4000000000000341`) → sender sees friendly error → link flips Inactive → recipient receives decline email
14. Recipient adds new card → link returns Active → sender retries → succeeds
15. URL rotation: old `short_code` returns 410, new one works

---

## 6. Considered and rejected

| Considered | Rejected because |
|---|---|
| Keep Phase E's hold-and-capture model (Pattern A) | Stripe card holds are single-capture + max 7 days. Breaks reusable-link semantics after shipment 1 or after 7 days, whichever first. |
| Auth rotation: capture old hold + immediately create new hold per shipment (Pattern B) | Doubles Stripe ops per shipment; novel pattern with no industry precedent; risks credit-line exhaustion if held amount is large; can't recover gracefully if the rotation fails mid-shipment. |
| Visible $cap auth + separate off_session charges (Pattern C) | Cardholder sees both a pending $100 hold AND a $30 shipment charge for the same event. Confusing; no industry precedent. |
| Pattern D + small ZDA verification at save (Pattern D' — research's recommendation) | John (2026-05-16): "Let's just start with a SetupIntent and see if we get failures." This PR ships strict D; if `last_payment_error_code` telemetry shows real declines the ZDA would have caught, D' is a 30-LOC follow-up. |
| Per-visit Stripe call at front gate (research §10 alternative) | Adds latency to every public sender visit; creates a card-testing-attack surface on an anonymous URL; per-page-view Stripe billing. DB-only front gate + back-gate as source of truth is sufficient at our scale. |
| Splitting into PR1 (Reactivate) + PR2 (full pivot) | Creates internal semantic contradictions (PR1's helper voided a PI but PR1's labels function captured from it). Pattern D's uniformity makes splitting actively harmful. |
| New `payment_validations` audit table | `stripe_intents` already mirrors PI/SI state; adding `last_payment_error_code` column gives us the same audit data without a separate table. |
| Rate-limit on the `links` GET endpoint (front-gate fraud surface) | DB-only front gate has no Stripe call; nothing for an attacker to amplify. Fraud surface moved to `labels` Edge Function — rate-limited there instead (5/60s per IP+short_code). |
| Multi-PM retry when default PM declines | Out of scope for v1; default-PM-only matches Stripe's documented pattern. Wishlist for v2. |
| SCA recovery flow for `requires_action` returns | Out of scope for v1 (US only). Treat `requires_action` as decline. Wishlist when we expand to EU. |

---

## 7. Open questions (this version)

Most prior open questions were resolved in the Review and Author response sections below. Remaining:

1. **`payment_method.updated` vs `payment_method.automatically_updated`** — current plan handles only the automatically-updated case (Card Account Updater). The author-response §"Nits" said `.updated` is for manual edits we don't expose UI for, so safe to skip. Reviewer: still right?

2. **Decline email content includes sender name when available** — sender provides email at the Confirm step; we could include "[email-username] tried to print a label." Worth doing now or wait for actual cases of recipient confusion?

3. **Step 23 polling fallback (§2.4)** — current plan: poll `GET /links/:id` every 2s for up to 30s; fall back to manual Refresh button. Acceptable, or worth a more polished spinner-with-progress-message?

---

## 8. Review history (compressed)

> Full review + author response preserved in git: see commit `5aa51bb` for the verbatim text. Summary below.

**Reviewer:** Claude (Opus 4.7, 1M context), fresh-eyes session on 2026-05-16. **Verdict:** approve-with-changes.

**Three blocking findings — all accepted, all revisions applied to the body above:**

1. `createPaymentIntent` is shape-incompatible with off_session + explicit PM (existing helper always sends `automatic_payment_methods: { enabled: true }`, which Stripe rejects in combination with `payment_method` + `confirm: true`). **Fix applied:** new helper is a sibling, not a wrapper. See §3.2 row 1.

2. Silent divergence from research's Pattern D' (ZDA verification) without reconciliation. **Fix applied:** explicit divergence paragraph in §1.

3. `is_funded` SQL missed `'in_use'`/`'completed'`; `labels/index.ts:810` was still flipping flex links `active→in_use` after every shipment. **Fix applied:** SQL expanded + `active→in_use` flip removed in this PR + legacy backfill in the migration. See §2.2 and §3.2.

**Non-blocking findings — all applied:** explicit user_id join in is_funded query; SCA/`requires_action` treated as decline for v1 with wishlist note; inline-email-send with 5s timeout + event_logs fallback for failure; decline email dedup via `sendmo_links.last_decline_email_at`; both `payment_method.automatically_updated` + `.updated` handled by same handler with brand-change detection; multi-PM retry wishlisted; `COMMENT ON TABLE` collapsed to single-line escape; step-23 polling fallback added to frontend plan.

**What the reviewer affirmed:** single-PR collapse is right; `is_funded` as DB-only is right; removing `holds` writes (keeping schema for Phase 3 escrow) is right; computed-Inactive (no enum churn) is right; Reactivate endpoint dropped is right; URL rotation with no grace window is right.

---

## 9. Decision

*Pending John's read.*
