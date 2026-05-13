---
title: Phase B — Saved Cards on File (SetupIntent + Customer + Dashboard Wallet)
slug: phase-b-saved-cards-implementation
project: sendmo
status: decided
created: 2026-05-13
last_updated: 2026-05-13 18:00 PT
reviewed: 2026-05-13
decided: 2026-05-13
author: Claude (opus-4-7) — implementing-agent session, 2026-05-13
reviewer: Claude (opus-4-7) — fresh-eyes reviewer, 2026-05-13
outcome: approve-with-changes
---

## 1. Context

Master Stripe proposal [`2026-04-26_stripe-integration-plan_…decided-2026-05-11.md`](2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md) §6 row B: *"Dashboard 'Add card' UI uses SetupIntent. Webhook writes `payment_methods`. (No charging yet.)"* Gating: "John saves his own card test+live; appears in dashboard; signature verification works in both modes."

**What's already in place:**
- Migration 017 ships `payment_methods` (with `is_default` partial-unique per `(user_id, mode)`, `deleted_at` soft-delete), `stripe_intents` with `intent_kind IN ('payment','setup')`, and `profiles.stripe_customer_id_test/_live` columns. **No schema work needed.**
- `_shared/stripe.ts` has `createPaymentIntent`, `retrievePaymentIntent`, `verifyAndParseWebhook` — mode-aware key selection (`STRIPE_SECRET_KEY_LIVE` / `_TEST`). Webhook verify tries both secrets and reports `liveMode`.
- `stripe-webhook/index.ts` handles `payment_intent.{succeeded,payment_failed}`, `charge.refunded`, `charge.dispute.created`; `default:` no-ops everything else. Idempotency layers 1–3 (§4.5) are live.
- Live mode is activated (Stripe dashboard wizard complete, live webhook endpoint `creative-oasis` listening to 30 events incl. `setup_intent.succeeded`, `payment_method.attached`, `payment_method.detached`). All four Stripe secrets in Supabase; `VITE_STRIPE_PUBLISHABLE_KEY_LIVE` in Vercel (redeploy triggered by `f665bf1`).

**What Phase B introduces:** a card-save flow that touches the dashboard but no money. SetupIntent + Customer object + 3 new webhook handlers + 4 new helpers + 1 new Edge Function + 1 modal + 1 Dashboard replacement.

## 2. Decision space

**(a) SetupIntent vs PaymentIntent-with-`future_usage`.** Master §4.1 covers both: PI-with-`setup_future_usage='off_session'` is for first-shipment card saves; SetupIntent is for the **dashboard "Add card" UI before any shipment exists**. Phase B is exactly the second case. Picking SetupIntent. PI-with-future-usage is already wired in `payments/index.ts` for the shipment flow when that flow gets account-creation; out of scope here.

**(b) Customer creation timing.** Lazy at first card-save, per §4.2 step 4. On `POST /setup-intent`, if `profiles.stripe_customer_id_<mode>` is NULL: `stripe.customers.create({ email, metadata: { sendmo_user_id }})`, then `UPDATE profiles`. One Customer per (user, mode). Test and live Customers are independent objects — that's correct (§4.4: cards saved in test never exist in live, and vice versa).

**(c) Default-card UX.** Auto-default-newest. First saved card sets `is_default=TRUE`; each subsequent save flips the previous default off and sets the new card as default. User can override via radio buttons later, but MVP doesn't ship an override — partial-unique index on `(user_id, mode) WHERE is_default=TRUE` enforces single-default-per-mode at the DB.

**(d) Card removal.** Soft-delete only (set `deleted_at`) + `stripe.paymentMethods.detach` (so the card stops appearing on the Stripe Customer in case Stripe ever shows the user that view directly). `payment_method.detached` webhook is the authority that flips `deleted_at`. UI confirms before removal; no warning for "last card" (Phase B has no flex links yet — no downstream consequence).

**(e) Cross-mode UI surface.** Dashboard shows **only the current-mode list**. Mode comes from the same admin-toolbar state used elsewhere (`adminMode` derived in `RecipientOnboarding.tsx` and forthcoming `Dashboard.tsx` carry-over). Non-admin users are always test-mode in this dogfood phase; live cards only appear when an admin user has `adminMode='live_charge'`. This avoids two-list confusion ("why are there 2 visas?") and matches §4.4's "every reconciliation query MUST filter by mode" stance.

**(f) Publishable-key selection (notable existing gap).** `StripePaymentForm.tsx:19` is hardcoded to `VITE_STRIPE_PUBLISHABLE_KEY_TEST`. Phase B's new card UI needs the same mode-aware selection AND the existing shipment form needs to be unhardcoded for Phase C. Extracting a shared `getStripeForMode(liveMode)` helper into `src/lib/stripeClient.ts` is the minimal change. Marking this as part of Phase B scope rather than Phase C because it's the simplest moment to land it (single import update on `StripePaymentForm.tsx`).

## 3. File-by-file plan

### 3.1 New Edge Function: `supabase/functions/setup-intent/index.ts` (~120 LOC)
- `POST /setup-intent` — `verify_jwt = true` (default; saved cards require auth, no toml entry needed).
- Request: `{}` (no body params — server derives everything).
- Server: read JWT → `user_id`. Determine `liveMode` from admin-toolbar state. **For non-admins, always `false`.** For admins, derive from `profiles.role='admin'` AND a server-trusted indicator. **Open question — see §7.**
- If `profiles.stripe_customer_id_<mode>` NULL: `stripe.customers.create`, UPDATE profile.
- `stripe.setupIntents.create({ customer, payment_method_types: ['card'], usage: 'off_session', metadata: { sendmo_user_id, mode }})` with idempotency key `seti_create_${user_id}_${mode}_${day}` (one SetupIntent per user/mode/day cap; the day suffix lets a stuck card retry tomorrow).
- INSERT `stripe_intents` row: `intent_kind='setup'`, `intent_role=NULL`, `funding_source='card'`, `status='requires_payment_method'`, `mode`, `idempotency_key='seti.<seti_id>:create'`.
- Return `{ client_secret, setup_intent_id }`.

### 3.2 New helpers in `supabase/functions/_shared/stripe.ts` (~80 LOC additions)
- `createCustomer({ email, metadata, liveMode }): Promise<StripeCustomer>`
- `retrieveCustomer(id, liveMode)`
- `createSetupIntent({ customer, metadata, idempotency_key, liveMode }): Promise<SetupIntent>`
- `listPaymentMethods({ customer, type='card', liveMode })` — for dashboard fetch as a backstop if a webhook is lost.
- `detachPaymentMethod(pm_id, liveMode)`
- Type defs: `SetupIntent`, `PaymentMethod`, `StripeCustomer` (minimal — id, email, metadata; brand/last4/exp on PM).

### 3.3 Extend `supabase/functions/stripe-webhook/index.ts` (~150 LOC additions)
Add three cases before the `default:`:
- **`setup_intent.succeeded`** → UPSERT `stripe_intents` (status='succeeded', captured_cents=NULL); INSERT `payment_methods` row from the attached PM (brand, last4, exp_month, exp_year, funding_source='card', `is_default=TRUE if no prior active default for (user, mode)`, else FALSE — followed by an UPDATE that flips any existing default to FALSE if we just set this one TRUE). Use a single transaction-ish sequence: lookup existing default → flip → insert.
- **`payment_method.attached`** → idempotent INSERT into `payment_methods` (most-info comes from `setup_intent.succeeded`; this is a backstop for cards attached outside the SetupIntent path, e.g., via PI-with-future-usage in Phase C). `ON CONFLICT (user_id, stripe_payment_method_id) DO NOTHING`.
- **`payment_method.detached`** → UPDATE `payment_methods SET deleted_at = now() WHERE stripe_payment_method_id = $1`. If detached card was `is_default`, no auto-reassignment in Phase B — user picks next default manually on their next interaction.

Mode resolution: comes from `verifyAndParseWebhook`'s `liveMode` return. User lookup goes via the `customer` field on the Stripe object → `profiles.stripe_customer_id_<mode>` (new query — needs an index, see §3.6).

### 3.4 New component `src/components/dashboard/AddCardModal.tsx` (~180 LOC)
- Opens from "Add card" button on Dashboard.
- Calls `createSetupIntent()` client wrapper → mounts Stripe `Elements` with `clientSecret`.
- Renders `PaymentElement` (cards only; no redirects).
- On submit: `stripe.confirmSetup({ elements, redirect: 'if_required' })`. On `setupIntent.status === 'succeeded'` → close modal + refetch dashboard card list. On `requires_action`: PaymentElement handles 3DS challenge inline.
- Tolerates webhook arrival ordering: the post-success refetch may not yet see the card row if the webhook hasn't fired. Solution: refetch with 3 retries at 500ms/1s/2s; if still missing, show "Saved — refreshing shortly" toast and rely on next dashboard load. Backstop list-fetch goes via `listPaymentMethods` (server reads Stripe, syncs back rows the webhook missed).
- Mode badge: same Live/Test pill as `StripePaymentForm.tsx:200-205`.

### 3.5 Replace Dashboard wallet placeholder — `src/pages/Dashboard.tsx:477-492` (~80 LOC delta)
- Fetch on mount: `listPaymentMethods()` filtered by current-mode `user_id`.
- Render: list of card rows (brand icon, •••• 4242, exp MM/YY, "Default" pill on the default card, "Remove" button).
- Empty state: "No cards saved yet." + "Add card" button.
- Non-empty: cards above, "Add another card" button below.
- WISHLIST item "Real wallet card on Dashboard" closes here.

### 3.6 Migration `022_phase_b_indexes_and_helpers.sql` — IF NEEDED
Most likely **no migration**. Possible small additions:
- Index on `profiles.stripe_customer_id_live` and `_test` (we look up users by Customer id in the webhook). Probably worth it: webhooks are hot path. ~5 LOC.
- That's it. RLS policies on `payment_methods` already shipped in 017.

If we don't need the index (small user table, sequential scan is fine for now), skip migration 022 entirely. **Open question — see §7.**

### 3.7 Client wrappers in `src/lib/api.ts` (~60 LOC additions)
- `createSetupIntent(): Promise<{ client_secret, setup_intent_id }>`
- `listPaymentMethods(): Promise<PaymentMethodRow[]>` — reads from Supabase `payment_methods` directly via PostgREST (RLS filters by user); falls back to Edge Function `GET /payment-methods` if we add one (probably we don't — direct PostgREST is fine and how shipments are read).
- `removePaymentMethod(pm_id): Promise<void>` — calls a small `DELETE /setup-intent/payment-methods/:id` route in the same setup-intent function (or a separate `payment-method-detach` function — leaning on the same setup-intent function for surface compactness).

### 3.8 Shared Stripe.js helper `src/lib/stripeClient.ts` (NEW, ~25 LOC)
- `getStripeForMode(liveMode: boolean)` — caches one promise per mode.
- Reads `VITE_STRIPE_PUBLISHABLE_KEY_LIVE` or `_TEST` from `import.meta.env`.
- Refactor `StripePaymentForm.tsx:14-28` to use this helper. Refactor `AddCardModal.tsx` to use it from day one.

## 4. Test plan

**Unit (Vitest):**
- `stripe-fee.test.ts` (existing pattern) → add `setup-intent-helpers.test.ts` for the new `_shared/stripe.ts` exports (mocked fetch).

**Integration (Node `tests/integration/`):**
- `stripe-setup-intent.mjs`: against Stripe test API; create SetupIntent, confirm with test card `pm_card_visa`, assert `setup_intent.succeeded` → `payment_methods` row appears via webhook → backstop list-fetch returns it.
- `stripe-customer-dedup.mjs`: call `POST /setup-intent` twice for the same user in the same mode; assert only one `stripe.customers.create` happens (the second reuses `profiles.stripe_customer_id_<mode>`).
- Webhook replay test: post the same `setup_intent.succeeded` event 5× to the webhook function; assert exactly one `payment_methods` row.

**E2E (Playwright, optional for Phase B):** card-save flow with test card 4242 → success toast → card appears in Dashboard list. Skipping for MVP if the integration tests cover the surface; revisit when Phase C adds the live-charge flow.

**Manual verification:**
1. Test mode: dashboard → Add card → 4242-4242-4242-4242 → card appears with brand=visa, last4=4242, Default pill, mode=test.
2. Test mode: Add another card (5555-...) → first card loses Default, second is Default.
3. Test mode: Remove first card → disappears from list; `payment_methods.deleted_at` set.
4. Live mode (admin toolbar = Live Charge): Add John's own real card → appears with mode=live, separate Customer object.
5. Webhook log: `event_logs` shows `stripe.payment_method_attached` (new event_type to add).
6. Cross-mode isolation: switch to Test mode, John's live card does NOT appear; switch back, it does.

## 5. Out of scope

- **Charging.** No PI created in Phase B. Phase C / Phase E land the charging surfaces.
- **Apple Pay / Google Pay.** Slot in via Payment Element later.
- **ACH / `us_bank_account` PMs.** Phase H concern, even though schema supports it.
- **Default-card override UI.** Auto-default-newest only in Phase B; explicit picker in Phase E (when flex links care which card auto-debits).
- **"Last card" warning.** No downstream consequence in Phase B.
- **Cross-mode merged view.** Single-mode list only.
- **Webhook-arrival reconciliation cron.** Phase D/F concern.
- **3DS UX copy polish.** Stripe Elements handles the flow; copy tuning is later.

## 6. Verification

1. `npx tsc -b --noEmit` clean.
2. Test card 4242 saved in test mode → row in `payment_methods` with `mode='test'`, `is_default=true`, brand='visa', last4='4242'.
3. John's real card saved in live mode → row in `payment_methods` with `mode='live'`, separate `stripe_customer_id_live` on his profile.
4. `event_logs` shows `stripe.setup_intent_succeeded` AND `stripe.payment_method_attached` (or whichever event arrives first; both possible).
5. Webhook signature verification works in live mode (first real live event, this is Step 1.5's deferred check finally resolving).
6. Remove a card → row's `deleted_at` set; card disappears from Dashboard; Stripe Customer no longer shows it attached.
7. WISHLIST item "Real wallet card on Dashboard" can be ticked.
8. Master proposal §6 Phase B gating bar: "John saves his own card test+live; appears in dashboard; signature verification works in both modes." → MET.

## 7. Open questions

1. **Mode resolution for `/setup-intent`.** The current admin-toolbar state lives in `RecipientOnboarding.tsx` URL state and isn't accessible from `/dashboard`. Options: (a) Lift `adminMode` into a Supabase RPC / profile setting so it's server-readable; (b) Pass mode as a request body param and validate against `profiles.role='admin'` server-side (mode='live' rejected for non-admins, accepted for admins — relies on admin self-identification, but server gates on role). Author leans (b) — minimal lift, gates the abuse case (non-admin asking for live). Reviewer: weigh in.

2. **Migration 022 — needed or not?** Index on `profiles.stripe_customer_id_<mode>` columns helps webhook lookups; without it, ≤100-user scan is cheap. Author leans skip-for-MVP, add when reconciliation slows. Reviewer: any objection to no-migration in Phase B?

3. **`payment_method.attached` arrival vs `setup_intent.succeeded` arrival ordering.** Both events fire when a SetupIntent confirms. Stripe doesn't guarantee order. The proposal assumes `setup_intent.succeeded` writes the canonical row and `payment_method.attached` is a backstop with `ON CONFLICT DO NOTHING`. Is this the right primary/secondary split, or should `payment_method.attached` be primary (it has the PM brand/last4 directly, whereas SetupIntent needs an additional lookup)? Reviewer: weigh in.

4. **Direct PostgREST read of `payment_methods` from the client vs an Edge Function GET.** Author leans direct PostgREST (matches how shipments are read; RLS filters by `auth.uid()=user_id`). The cost is one more table the frontend reads directly. Reviewer: any preference?

---

*Author session: 2026-05-13 14:00 PT. Sharp questions for the reviewer:*

1. Is the §3.3 webhook split (SetupIntent primary, payment_method.attached backstop) the right call, or should it be flipped?
2. Mode-resolution for `/setup-intent` from a Dashboard context (not a Sender Onboarding context) — is option (b) in §7.1 acceptable, or do we need to lift adminMode into server state first?
3. Does the migration-022 skip read as too aggressive given webhook hot-path concerns?
4. Anything cross-cutting from prior decided proposals that this draft doesn't reconcile?

---

## Review

```yaml
reviewer: Claude (opus-4-7) — fresh-eyes reviewer, 2026-05-13
reviewed_at: 2026-05-13
verdict: approve-with-changes
```

### Summary

Shape is right and the small surface is correct: SetupIntent + Customer + 3 webhook handlers + dashboard wallet, all sitting on Phase A's already-shipped tables. But four of the proposal's load-bearing assumptions don't survive verification against the cited code and the master proposal: (1) `setup_intent.succeeded` does not carry the card brand/last4 the §3.3 INSERT depends on; (2) the §7.1 "pass mode in body" option contradicts the master proposal's §4.4 client-never-sends-mode decision (Rule 14); (3) the "default `verify_jwt=true`, no toml entry needed" claim is wrong against this repo's explicit-listing convention and the LOG's prior 401 incident; (4) `payment_methods.user_id` is not derivable from a Stripe webhook payload without a `stripe_customer_id_<mode>` lookup that needs an index this proposal half-defers. Each is straightforward to fix; together they're "don't ship yet."

### Blocking issues

**B1. `setup_intent.succeeded` payload doesn't carry brand/last4 — §3.3's "INSERT payment_methods … from the attached PM" can't run on the event alone.**
- *Location:* §3.3 (`setup_intent.succeeded` handler).
- *Issue:* The Stripe SetupIntent webhook event contains `data.object.payment_method` as a **string ID** by default, not the expanded PaymentMethod object — there are no `brand`, `last4`, `exp_month`, `exp_year` fields on the SetupIntent itself. Stripe's `expand` parameter applies to API retrieval calls, not to event delivery; you can't make a delivered webhook event arrive pre-expanded. So the proposal's "INSERT … brand, last4, exp_month, exp_year" cannot execute on `setup_intent.succeeded` alone. Two real options: (a) handler does an explicit `stripe.paymentMethods.retrieve(pm_id)` after `setup_intent.succeeded` arrives (one extra Stripe API round-trip on the webhook hot path), or (b) flip the §3.3 primary/secondary split — make `payment_method.attached` the row-writer (its `data.object` IS the full PaymentMethod with brand/last4) and treat `setup_intent.succeeded` as the stripe_intents state update. Option (b) also resolves §7.3 directly. The proposal's §7.3 hand-waves this without naming the payload shape — that's the actual decision, not a stylistic one.
- *Suggested fix:* Adopt option (b). Rewrite §3.3 so `payment_method.attached` is the canonical `payment_methods` INSERT (it has the card data inline); `setup_intent.succeeded` only UPSERTs `stripe_intents` and triggers the post-success refetch. Document that the row may briefly not exist between `setup_intent.succeeded` arrival and `payment_method.attached` arrival — Stripe usually fires them within ms but ordering isn't guaranteed; the modal's 500ms/1s/2s retry covers this.

**B2. §7.1 option (b) "pass mode in body, validate against role" directly contradicts master proposal §4.4 / §4.2 — Rule 14.**
- *Location:* §7.1 ("Author leans (b) — minimal lift, gates the abuse case").
- *Issue:* The master proposal §4.4 reads, verbatim: *"The client never sets mode. `mode_implied_by_admin_state` from the original draft is removed entirely."* §4.2's mode resolution chain is server-derived end-to-end (link's `is_test` → secret key selection). PLAYBOOK Rule 14: *"NEVER trust client-provided parameters"* for test/live mode. The proposal frames this as an "open question for the reviewer" but it's already a decided question — the answer is "no." Validating "admin role + client-supplied mode" is exactly the pattern §4.2 explicitly threw out, because an admin user accidentally (or maliciously) sending `mode='live'` from a stale tab is *the* failure mode that drove the rule. The fact that the Dashboard isn't currently a link-create surface (no `is_test` on the link to read) doesn't make the client safe; it means the architecture-correct answer is to make mode server-resolvable on the Dashboard another way.
- *Suggested fix:* Two architecture-clean options:
  (a) **Add an `admin_active_mode` column on `profiles`** (enum: `test|live_comp|live_charge`, default `test`, only `profiles.role='admin'` can set non-test via a guarded RPC). The admin toolbar writes to this on mode toggle; the `/setup-intent` function reads `liveMode` from this column server-side. This is the §7.1 option (a) but properly framed — it's not a "Supabase RPC / profile setting" hand-wave, it's a 1-column ALTER and a 10-LOC server RPC.
  (b) **Defer Phase B's live path entirely** — Phase B test-mode-only for non-admin Dashboard, and admins who want to save a live card do it from a flow that already has server-derived mode (e.g., Phase C's checkout). This is smaller now but pushes the live-card-on-Dashboard story to Phase C/D.
  Either is fine; option (b) is in body would mean removing item §3 verification step 3 ("John's real card saved in live mode") from Phase B's gating bar. The current draft (option (b) of §7.1) is not fine.

**B3. `verify_jwt = true` is NOT default in this repo — `[functions.setup-intent]` toml entry is required.**
- *Location:* §3.1 ("verify_jwt = true (default; saved cards require auth, no toml entry needed)").
- *Issue:* The project explicitly lists every function in `supabase/config.toml` with its `verify_jwt` value (lines 47-126). The `payments` function is `verify_jwt = false`. LOG.md records a prod 401 incident on 2026-05-11 caused by exactly this assumption: `[functions.links]` had no toml entry, Supabase gateway defaulted, and `verify_jwt = true` blocked the sender flow's first call. The fix landed in config.toml ("Section was missing entirely until 2026-05-11; Supabase defaulted to verify_jwt = true and the sender flow's first fetchLink call 401'd in prod"). Shipping `/setup-intent` without a toml entry recreates that incident — even if `true` IS the intended value, the project rule is "explicit, in toml, with `--no-verify-jwt` belt-and-suspenders on deploy."
- *Suggested fix:* Add `[functions.setup-intent] enabled = true, verify_jwt = true` to `supabase/config.toml`. Add a sentence in §3.1 noting the LOG-recorded incident and the explicit-listing convention.

**B4. Webhook user lookup via `profiles.stripe_customer_id_<mode>` is unindexed and §3.6 defers the fix.**
- *Location:* §3.3 ("User lookup goes via the `customer` field on the Stripe object → `profiles.stripe_customer_id_<mode>` (new query — needs an index, see §3.6)") and §3.6 ("If we don't need the index … skip migration 022 entirely. Open question — see §7").
- *Issue:* The `stripe-webhook` function is the sole writer of `transactions`/`refunds`/`payment_methods` (Phase A). Every event-driven INSERT in Phase B+ that originates from a Stripe Customer ID — that's `payment_method.attached`, `payment_method.detached`, `setup_intent.succeeded`, and (in Phase C) every `charge.succeeded`/`charge.refunded` — runs a SELECT on `profiles WHERE stripe_customer_id_live = $1`. Without an index this is a seq scan on every webhook delivery, including replays. The proposal's reasoning ("≤100-user scan is cheap") is correct *today* but the index is cheaper to add now (2 lines, partial index on `WHERE NOT NULL`) than to revisit when reconciliation slows. More importantly: there is no monitoring story in the proposal for "when does the seq scan stop being cheap" — it'll just quietly start eating webhook latency budget. Phase A added five indexes on `transactions` proactively (`idx_tx_*`); the same posture applies here.
- *Suggested fix:* Ship migration 022 with two partial indexes: `CREATE INDEX idx_profiles_stripe_customer_test ON profiles (stripe_customer_id_test) WHERE stripe_customer_id_test IS NOT NULL;` plus the `_live` analogue. Move §3.6 from "IF NEEDED / Open question" to "shipping, 2 LOC." Removes §7.2 as an open question entirely.

### Non-blocking concerns

**N1. Mode badge for the Dashboard implies "test mode" is a thing non-admins should see.** §3.5 doesn't say this, but if non-admins are always test mode (§2.e), should the Dashboard wallet card show a "Test Mode" pill to them at all? The admin toolbar's pill makes sense in a toggle context; on the Dashboard, a non-admin user sees "Test Mode" stamped on a card they think is real. Suggest: pill is admin-only on Dashboard.

**N2. `listPaymentMethods` as a webhook backstop is described in §3.2 but no concrete reconciliation path is specified.** §3.4 mentions "backstop list-fetch" but doesn't say *when* the function gets called — only on the optimistic refresh after Add Card? On every Dashboard load? Periodically? "If a webhook is lost" is the master proposal's Phase F/G concern (drift cron), and this proposal explicitly puts that out of scope (§5). But if `listPaymentMethods` is a one-shot drift fix on Add Card success only, write that down. If it's also called on Dashboard mount, that's an extra Stripe API call per page view — bad pattern.

**N3. Removal flow lacks a "this is your default card, picking next default = ?" guard.** §3.3 last bullet: *"If detached card was `is_default`, no auto-reassignment in Phase B — user picks next default manually on their next interaction."* But §3.5's Dashboard render has no UI for "pick a default" — there's just a "Default" pill (read-only) and a Remove button. So a user who removes their only-default-card lands in a state where no card has `is_default=true` and there's no UI affordance to set one. This is invisible in Phase B (no flex links yet), but the moment Phase C/E lands and the default-card pointer becomes load-bearing, the half-built UI bites. Either ship the "pick default" UI now (§2.d says "MVP doesn't ship an override") or auto-promote the most-recently-added non-deleted card to default on detach.

**N4. Idempotency key `seti_create_${user_id}_${mode}_${day}` is creative but has a foot-gun.** A user adding a card at 23:59 UTC, the SetupIntent failing, the user retrying at 00:01 UTC, gets a new SetupIntent — but the `stripe_intents` table will now have two rows for the same user-attempt (different `idempotency_key`s) and the abandoned first one stays at `requires_payment_method` forever. Master proposal §4.5 uses `:retry-${retry_n}` for legitimate retry semantics; mirroring that would be cleaner. Day-based suffixes work but make replay testing (§4 test plan: "post the same … event 5×") harder to reason about.

**N5. `removePaymentMethod` route choice — "leaning on the same setup-intent function" is a coupling smell.** §3.7 says `DELETE /setup-intent/payment-methods/:id` in the same function. The function is named for what it creates; routing a delete-payment-method through it makes the function a grab-bag. Either keep `/setup-intent` strictly for SetupIntent creation and use a separate `/payment-methods` function for list+remove (matches REST shapes), or rename the function to `/payment-methods` and let it own create+list+remove. Single-function-per-route is the repo's pattern (one function per Edge Function folder, named for its resource).

**N6. Mode resolution open question §7.1 also affects `removePaymentMethod`.** If the user removes a live card, the `/setup-intent` (or whatever) function needs to know which mode to call `stripe.paymentMethods.detach` against — same mode-resolution problem as create. The proposal solves only the create case in §7.1.

**N7. RLS on `payment_methods` filters by `user_id` only, not `mode` — §2.e relies on client-side filtering.** Migration 017 line 499-501: `USING (auth.uid() = user_id AND deleted_at IS NULL)` — no mode filter. The "single-mode UI" claim of §2.e is client-enforced, not RLS-enforced. Not a security hole (user sees their own data), but it's worth noting in the proposal so a future agent doesn't assume RLS is doing the mode separation.

### Nits

- §1: "All four Stripe secrets in Supabase" — list them by name (`STRIPE_SECRET_KEY_TEST`, `_LIVE`, `STRIPE_WEBHOOK_SECRET_TEST`, `_LIVE`). Future-agent readability.
- §3.2: New helpers reference `StripeCustomer` type but the codebase pattern in `_shared/stripe.ts` exports flat interfaces (`PaymentIntent`, `Refund`) — keep style consistent.
- §3.3: "transaction-ish sequence: lookup existing default → flip → insert" — the partial-unique index does the heavy lifting; if you wrap in a single `WITH` CTE you don't need a transaction at all. The phrasing currently implies more complexity than the implementation needs.
- §4 integration test `stripe-customer-dedup.mjs` — also assert the test invokes via JWT, not the anon key, since `/setup-intent` is `verify_jwt = true` (B3).
- §6 verification step 5: "this is Step 1.5's deferred check finally resolving" — Step 1.5 isn't defined anywhere in this proposal. Either define or drop the cross-reference.

### Predicted pitfalls (required, minimum 3)

**P1. The B1 failure mode shipping unnoticed → empty card rows.** If §3.3 is implemented as written without resolving B1, `payment_methods` rows will INSERT with NULL `brand`/`last4`/`exp_month`/`exp_year`. The Dashboard list (§3.5) will show "•••• null" cards. This won't surface in the test plan (§4) because `pm_card_visa` integration tests work against Stripe test API which is more forgiving than reasoning through the actual event shape — the test might INSERT a row at all and pass. The pattern matches LOG's 2026-04-26 "fire-and-forget DB writes hid bug #2" incident: the round-2 review of the master proposal called out that webhooks need to read actual payload shapes, not assumed ones (round-1 B4). Probability: high if B1 isn't fixed; severity: medium (UX bug, no money lost).

**P2. Mode-confusion via `/setup-intent` body param → John's first live card-save reaches test Stripe.** If §7.1 option (b) ships, the natural client implementation passes `mode` from `useAuth().isAdmin && adminMode === 'live_charge'` — but the Dashboard isn't where `adminMode` lives today (it's `RecipientOnboarding.tsx` local state per §7.1 itself). So the client either (a) re-implements its own mode picker on Dashboard, (b) hardcodes test, or (c) reads from `localStorage`-shared state. Any of these can desync from the server's `profiles.role='admin'` check and the user's intent. The 2026-05-11 LOG entry on the 3-mode toolbar is explicit that "Live Comp" used to mistakenly charge live cards — same family of bug ("UI says one thing, server does another for mode"). PLAYBOOK §"Admin Mode" calls this out as the historical bug class. Probability: medium; severity: high (real money in wrong account).

**P3. Webhook race + 500ms/1s/2s retry budget hides slow lookups.** §3.4's "Tolerates webhook arrival ordering" with 3 retries up to 3.5s total covers the happy path but the latency budget assumes a fast `profiles.stripe_customer_id_<mode>` lookup (B4). With seq scans across a growing `profiles` table, the webhook handler itself slows down — the user sees the "Saved — refreshing shortly" toast more often than expected, then a stale Dashboard, then a refresh. The reconciliation cron (out of scope per §5) is the proper fix but won't ship in Phase B. Pattern: master proposal §5.4 ("reconciliation cron will alert-fatigue" — non-blocking concern P5) anticipated exactly this kind of "looks fine until growth catches up" timing-artifact failure. Probability: low at current user count; severity: low immediately, but the failure mode is "Dashboard shows wrong state to the one user who matters most for trust."

### What the proposal got right

- **§2.f calling out the hardcoded `VITE_STRIPE_PUBLISHABLE_KEY_TEST` and proposing `getStripeForMode(liveMode)` as part of Phase B.** This is the exact kind of "land it while you're already touching the file" thinking the protocol encourages. Master proposal §4.4 implicitly needs this for Phase C; bundling it into B is right.
- **Lazy Customer creation per (user, mode)** matches master §4.2 step 4 verbatim and §4.4's mode-record-everywhere stance.
- **Soft-delete + `payment_method.detached` as authority for `deleted_at`** is the right idempotent shape — webhook is single source of truth (Phase A pattern).
- **Cross-mode UI isolation (§2.e)** correctly prevents the "two visas" confusion that the master §4.4 anticipated.
- **Explicit `is_default` partial-unique-index reliance (§2.c)** uses the migration-017 invariant correctly — flips at INSERT time rather than re-deriving on read.
- **Out-of-scope list (§5) is tight and matches the master proposal's phase boundaries** — no scope creep into Phase C/E/F.

---

## Author response

```yaml
author: Claude (opus-4-7) — original author, 2026-05-13
responded_at: 2026-05-13 17:30 PT
posture: accept all blocking findings; one item escalates to John as a tradeoff
```

### Blocking issues

**B1 — flip primary/secondary on the webhook split. ✅ ACCEPT.**

Reviewer is correct on the payload shape — I conflated `expand` (an API parameter for retrieval) with what arrives in a delivered webhook event. They aren't the same surface. Option (b) is the right move: `payment_method.attached` is the canonical `payment_methods` row INSERT (carries `card.brand`, `card.last4`, `card.exp_month`, `card.exp_year` inline on `data.object`); `setup_intent.succeeded` only UPSERTs `stripe_intents` (status='succeeded') and is the signal the modal listens for to refetch.

Concrete §3.3 rewrite:
- `setup_intent.succeeded` → UPSERT `stripe_intents` only. No `payment_methods` write. Logs `stripe.setup_intent_succeeded`.
- `payment_method.attached` → INSERT `payment_methods` from `data.object` (which IS the full PaymentMethod). On INSERT, if no prior active default for `(user_id, mode)` exists, set `is_default=TRUE`; if a prior default exists, INSERT with `is_default=FALSE`. (Partial-unique index prevents two-default state.) `ON CONFLICT (user_id, stripe_payment_method_id) DO NOTHING` for replay safety.
- `payment_method.detached` → UPDATE `payment_methods SET deleted_at=now()` (unchanged from draft).

Documentation note added: rows may briefly not exist between `setup_intent.succeeded` arrival and `payment_method.attached` arrival. The modal's retry budget (B4-revised — see below) covers this.

**B2 — §7.1 option (b) violates Rule 14 / master §4.4. ✅ ACCEPT REVIEWER'S OPTION (a), ESCALATE TO JOHN.**

Reviewer is right. The "validate role + accept client-supplied mode" pattern is exactly what master §4.4 ripped out, and PLAYBOOK Rule 14 is unambiguous. The 2026-05-11 LOG entry on "Live Comp" historically charging live cards is the named precedent. I was rationalizing convenience past a rule.

Reviewer's option (a) — add an `admin_active_mode` column on `profiles` — is the right move. Concrete:

- Migration 022 adds: `ALTER TABLE profiles ADD COLUMN admin_active_mode TEXT NOT NULL DEFAULT 'test' CHECK (admin_active_mode IN ('test','live_comp','live_charge'));`
- New RPC `set_admin_active_mode(mode TEXT)` — `SECURITY DEFINER`, checks `profiles.role='admin'` for caller, errors otherwise. RPC, not direct table UPDATE, so RLS doesn't need a write policy for the column.
- `RecipientOnboarding.tsx` admin toolbar's onClick handler calls the RPC instead of local `setAdminMode` (or in addition — local for instant UI, RPC for server-trusted truth).
- `Dashboard.tsx` reads `profile.admin_active_mode` on mount (just a SELECT) and renders the wallet card list / Add Card modal mode accordingly.
- `/setup-intent` (and `/payment-methods`) server-side: read `profile.admin_active_mode`; `liveMode = role==='admin' && admin_active_mode IN ('live_comp','live_charge')`. Client sends NO mode param.

Reviewer's option (b) — defer the live path entirely — would defeat the master §6 Phase B gating bar ("John saves his own card test+live"). So option (a) is the only path that lets Phase B close.

**Escalating one sub-question to John:** the admin toolbar lives in `RecipientOnboarding.tsx` today. Lifting the mode to `profiles.admin_active_mode` means the toolbar effectively moves to a global state. Two design options for John:

- (i) **Make the toolbar global** — render it in the app shell (e.g., a sticky strip at top of any admin page), driven by `profile.admin_active_mode`. Same 3 buttons, same colors, visible from Dashboard and from `/onboarding/full-label/*`. Cleanest UX.
- (ii) **Keep the toolbar where it is** — the Dashboard reads `profile.admin_active_mode` but has no toggle of its own. John toggles mode from Sender Onboarding once; Dashboard inherits. Less UX work, more "where did my live mode go?" confusion.

Either works; (i) is the better call architecturally. Flagging as §11 below.

**B3 — add `[functions.setup-intent] verify_jwt = true` to `config.toml`. ✅ ACCEPT.**

The 2026-05-11 LOG incident is exactly the precedent. My phrasing "no toml entry needed" was wrong on the repo's convention. Migration 022 PR will include the toml entry. Also adding (per N5's split below) `[functions.payment-methods] verify_jwt = true`.

**B4 — ship migration 022 with the `stripe_customer_id_<mode>` indexes. ✅ ACCEPT.**

Reviewer's posture-matching argument is correct: Phase A added five `idx_tx_*` indexes proactively without "do we need it yet" hand-wringing. The same should apply here. Webhook hot-path latency is monitoring-shaped invisible-debt that we don't want to add to the pile.

Migration 022 final scope:
```sql
-- Phase B prerequisites: admin mode + webhook lookup indexes.

ALTER TABLE public.profiles
    ADD COLUMN admin_active_mode TEXT NOT NULL DEFAULT 'test'
        CHECK (admin_active_mode IN ('test','live_comp','live_charge'));

COMMENT ON COLUMN public.profiles.admin_active_mode IS
    'Server-trusted admin toolbar state. Only profiles.role=''admin'' can move '
    'this off ''test'' via the set_admin_active_mode() RPC. Non-admins always '
    'read ''test''. Per proposal Phase B / Rule 14 — never trust client for '
    'mode selection.';

CREATE INDEX IF NOT EXISTS idx_profiles_stripe_customer_test
    ON public.profiles (stripe_customer_id_test)
    WHERE stripe_customer_id_test IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_stripe_customer_live
    ON public.profiles (stripe_customer_id_live)
    WHERE stripe_customer_id_live IS NOT NULL;

-- RPC for admin mode toggle. SECURITY DEFINER so admin role check happens
-- in the function body, not via RLS on the column.
CREATE OR REPLACE FUNCTION public.set_admin_active_mode(new_mode TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    caller_role TEXT;
BEGIN
    SELECT role INTO caller_role FROM profiles WHERE id = auth.uid();
    IF caller_role IS DISTINCT FROM 'admin' THEN
        RAISE EXCEPTION 'Only admin users can set admin_active_mode';
    END IF;
    IF new_mode NOT IN ('test','live_comp','live_charge') THEN
        RAISE EXCEPTION 'Invalid mode: %', new_mode;
    END IF;
    UPDATE profiles SET admin_active_mode = new_mode WHERE id = auth.uid();
    RETURN new_mode;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.set_admin_active_mode(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.set_admin_active_mode(TEXT) TO authenticated;
```

LOC budget revision (was no migration; now ~50 LOC of SQL). Net Phase B implementation now ~750–1000 LOC including tests.

### Non-blocking concerns

**N1 — hide mode badge from non-admin Dashboard. ✅ ACCEPT.** Badge conditional on `profile.role==='admin'`.

**N2 — `listPaymentMethods` Stripe-backed call should be one-shot, not on every Dashboard mount. ✅ ACCEPT.** Concrete: Dashboard mount reads `payment_methods` table directly via PostgREST (RLS, mode filter client-side per N7). The Stripe-backed `listPaymentMethods` Edge Function endpoint is called **only on Add Card success retry path** (the 500ms/1s/2s loop), not on Dashboard mount. Spelling this out in §3.4 + §3.5.

**N3 — default-card auto-promotion on detach. ✅ ACCEPT.** `payment_method.detached` handler: after setting `deleted_at`, if the detached card was `is_default=true`, promote the most-recently-`created_at` remaining active card in `(user_id, mode)` to default. Saves the half-built UI problem.

**N4 — idempotency key foot-gun. ✅ ACCEPT.** Reusing master §4.5 pattern: `seti_create:${user_id}:${mode}:retry-${retry_n}` where `retry_n` increments on user-visible retry (modal stores it in component state across submit attempts). Day-suffix dropped.

**N5 — function naming. ✅ ACCEPT — split.** Rename function to `payment-methods/`. Routes: `POST /payment-methods` (creates SetupIntent for adding a card), `DELETE /payment-methods/:pm_id` (detach + soft-delete). List goes via PostgREST direct read of the table (per N7). One Edge Function, one resource, clean REST shape. Sidebar: this means `/setup-intent` is no longer the URL; it's `POST /payment-methods`.

**N6 — mode resolution affects detach too. ✅ ACCEPT — already handled by B2 fix.** Both create and detach paths in `payment-methods/` read `profile.admin_active_mode` server-side. Client sends no mode param on either.

**N7 — RLS doesn't filter by mode; client-side filter only. ✅ ACCEPT — document.** Adding a sentence to §3.5: "RLS on `payment_methods` filters by `user_id`/`deleted_at` only (migration 017). Mode separation is client-side filtering in the Dashboard fetch, NOT an RLS guarantee. This is acceptable because a user seeing their own data across modes is not a security boundary violation — but a future agent who assumes RLS is doing mode separation would be wrong."

### Nits

- §1: secrets listed by name. ✅
- §3.2: drop `StripeCustomer` wrapper type, use flat interface. ✅
- §3.3: simplify "transaction-ish sequence" — partial-unique index handles it; INSERT with `is_default = (SELECT COUNT(*)=0 FROM payment_methods WHERE user_id=$1 AND mode=$2 AND deleted_at IS NULL)` is single-statement. ✅
- §4 integration test JWT note. ✅
- §6 "Step 1.5" reference — drop, it's context this proposal shouldn't carry. ✅

### Predicted pitfalls

- **P1** (empty card rows from B1) — eliminated by B1 fix; `payment_method.attached` carries the data inline.
- **P2** (mode confusion) — eliminated by B2 fix; server reads `profile.admin_active_mode`, client passes nothing.
- **P3** (webhook latency from B4 seq scan) — eliminated by B4 fix; partial indexes ship in migration 022.

All three predicted pitfalls retire with the blocking fixes. Worth noting because that's the test for whether the review's findings were load-bearing: if fixing the blockers also clears the predicted pitfalls, the review caught the right things.

### What I'm changing in the proposal body

Not editing §1–§7 inline per protocol (§10 of protocol: "Do NOT edit the original proposal body"). The implementation PR will follow the revised plan as captured in this response section, with these deltas from the draft:

1. §3.1 → renamed to `payment-methods` function; create-SetupIntent on POST, detach on DELETE.
2. §3.3 → primary/secondary webhook split flipped (payment_method.attached is canonical row writer).
3. §3.6 → migration 022 ships (not "if needed"); contains admin_active_mode column + RPC + 2 indexes.
4. §3.4 → modal retry budget covers the brief window where `payment_method.attached` hasn't arrived yet.
5. §7 open questions §7.1, §7.2, §7.3, §7.4 → all RESOLVED (collapse to a single line each citing the response above).

### One tradeoff for John

## Tradeoffs for John

**T1. Where does the admin toolbar live, post-B2 fix?**

The B2 fix moves admin mode from `RecipientOnboarding.tsx` local state to `profiles.admin_active_mode` (server-truthed). That unblocks Dashboard reading the mode, but raises a UX question.

- **Option (i): Make the toolbar global** — render it in the app shell (sticky strip at top of every admin-visible page). Visible from `/dashboard`, `/onboarding/full-label/*`, `/admin`. Single switch; one click changes mode everywhere. **Cost:** ~80 LOC of shell-level component wiring + Header.tsx (or wherever the app shell lives) needs the conditional render. **Benefit:** John never wonders "where's my Live Charge toggle?" — it's always there.
- **Option (ii): Keep the toolbar where it is** — `RecipientOnboarding.tsx` continues to own the visible toggle; Dashboard reads `profile.admin_active_mode` but has no toggle of its own. **Cost:** ~5 LOC (no shell work). **Benefit:** no visual disruption to existing pages.

Author recommendation: **(i)**. The mode is server state now; the UI should reflect that everywhere. Phase C/E will both need the toggle accessible from places it isn't today; landing the global toolbar in Phase B's revised migration is the natural moment.

**T2. Phase B LOC budget revision.**

Draft estimated ~600-900 LOC. Revised scope adds:
- Migration 022 (~50 LOC SQL).
- B2 admin-mode wiring (~80 LOC if option T1.i; ~5 if option T1.ii).
- N3 default-card promotion (~15 LOC).
- N5 function rename + DELETE route (~30 LOC).

New total: **~800–1100 LOC** depending on T1. No decision needed here unless John wants the LOC budget capped — flagging for transparency.

### Status of resolved §7 open questions

- §7.1 (mode resolution) → RESOLVED via B2 fix.
- §7.2 (migration 022 needed) → RESOLVED — yes, shipping.
- §7.3 (webhook primary/secondary) → RESOLVED via B1 fix — `payment_method.attached` is primary.
- §7.4 (PostgREST vs Edge Function for list) → RESOLVED — PostgREST direct read for Dashboard mount; Edge Function `payment-methods` covers create + delete only.

All four sharp reviewer questions ($§7) close with this response.

---

**Status flip:** `reviewed` → `revised`. File rename pending John's T1 decision.

---

## Decision — 2026-05-13 (John)

**T1 — RESOLVED: Option (i) global toolbar, placed in the header row to the left of the user/login section.**

The 3-mode admin toolbar (Test / Live Comp / Live Charge) renders inside [`AppHeader.tsx`](../src/components/AppHeader.tsx), to the immediate left of the existing user/login UI. Visible only when `profile.role='admin'`. Clicking a button calls `set_admin_active_mode()` RPC to update server state. Mode reads from `profile.admin_active_mode` (loaded with the auth profile) so every page is in sync.

Implementation notes:
- The `RecipientOnboarding.tsx` local `adminMode` state is replaced by a `useAdminMode()` hook that reads from `profile.admin_active_mode` and exposes a setter that calls the RPC. Existing visual toolbar in `RecipientOnboarding.tsx` is removed (the global header toolbar replaces it).
- `Dashboard.tsx` reads the same hook.
- Migration 022 ships the column + RPC unchanged from the response above.

**T2 — no explicit decision needed.** LOC budget revision (~800-1100 LOC) noted; John did not flag a cap.

**All other items** (B1-B4, N1-N7, nits) accepted as written in author response.

Status flip: `revised` → `decided`. File rename to `…_decided-2026-05-13.md`. Implementation starts.
