# Handoff — Saved-card display in sender-flow PaymentElement

> Paste the body below into a fresh Claude Code session at `~/AI Brain/sendmo/`. The work is small, the trap is specific, and most of the surrounding plumbing already landed yesterday — don't reinvent it.

---

## You're finishing the saved-card path on the sender flow

When an authenticated user with a saved card reaches `/onboarding/full-label/payment`, PaymentElement should render their saved card as the top option (with "+ Use a different card" below). Today it renders the bare `1234 1234 1234 1234` form, even though the server-side plumbing is done and `event_logs` confirms `has_customer_session: true` on every PI.

The gap is one specific Stripe parameter. **The first agent (me, 2026-05-14) guessed the path wrong twice in production and broke Add Card briefly each time.** Don't repeat that — read Stripe's docs before you push.

## Read these first, in order

1. **`~/AI Brain/CLAUDE.md`** — global agent rules. Rule 0 (don't echo secrets), Rule 0.5 (no destructive DB ops without verification).
2. **`~/AI Brain/sendmo/PLAYBOOK.md`** — project rules. Rule 14 (server-side state), Rule 19 (browser-verify product-surface fixes with structured `Browser-verified:` block in LOG entries).
3. **`~/AI Brain/sendmo/LOG.md`** — most recent entries especially `[2026-05-14] Phase B/C/D pre-prod sweep`. That entry documents everything that's already shipped + the open gap you're closing.
4. **`~/AI Brain/sendmo/wallofshame.md`** — the entry about `allow_redisplay` parameter-path guessing. Read it. It's literally about not repeating the bug you're fixing.
5. **`~/AI Brain/sendmo/proposals/2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md`** — master Phase B/C/D plan. The saved-card-on-checkout feature lives under Phase D.

## You have Stripe MCP and Supabase MCP access

This wasn't true earlier in the project. Use them.

- **Supabase MCP**: `mcp__supabase__execute_sql` is your friend for verifying rows landed. `mcp__supabase__get_edge_function` lets you confirm deployed Edge Function source matches your git HEAD without waiting for John to refresh a tab. `mcp__supabase__get_logs` for service logs.
- **Stripe MCP**: `mcp__stripe__search_stripe_documentation` is now reliable for doc lookups — *use it before guessing parameter paths*. `mcp__stripe__stripe_api_search` + `mcp__stripe__stripe_api_execute` cover a curated subset of Stripe operations (customers, PIs, products, prices, subscriptions, refunds, payment_links, coupons, invoices). Write operations require John's per-call approval — surface the approval URL and wait. Webhook endpoints, events listing, and PaymentMethod writes are NOT exposed via Stripe MCP; for those you need Dashboard UI or the Workbench shell (test-mode-only) or local `stripe` CLI with secret keys (Rule 0: secret stays in op + the user's shell, never in chat).

## Current state of the world (verified 2026-05-14T21:24Z)

- ✅ `payments/index.ts` passes `customer: cus_XXX` to PaymentIntent when user has a saved Customer in the resolved mode (`stripe_customer_id_test` or `stripe_customer_id_live`)
- ✅ `payments/index.ts` creates a `CustomerSession` for that customer with `payment_element.features.payment_method_redisplay='enabled'` (helper at `supabase/functions/_shared/stripe.ts` → `createCustomerSession`)
- ✅ `/payments` response includes `customer_session_client_secret`
- ✅ `StripePaymentForm.tsx` reads it and passes to `<Elements options={{ clientSecret, customerSessionClientSecret, appearance }}>`
- ✅ `event_logs.payment.intent_created` confirms `has_customer_session: true` for real shipments
- ❌ **PaymentElement still doesn't display saved cards** — because the saved PMs all have `allow_redisplay='unspecified'` (Stripe's default), which Customer Session filters OUT by default

The plumbing is right. The gap is one specific Stripe parameter.

## Your job — set `allow_redisplay='always'` somewhere that actually works

The previous agent tried two paths, both rejected by Stripe with `"Received unknown parameter"`:

1. ❌ `payment_method_options[card][allow_redisplay]` on SetupIntent body
2. ❌ Top-level `allow_redisplay` on SetupIntent body

After two failures, reverted (commit `31cc8e5`). **Add Card works again, but no saved-PM display.** The field belongs somewhere else. Three candidate paths to research:

### Option A — Client-side `payment_method_data.allow_redisplay` on `stripe.confirmSetup`

In `AddCardModal.tsx`:
```js
const { error, setupIntent } = await stripe.confirmSetup({
  elements,
  redirect: "if_required",
  confirmParams: {
    payment_method_data: {
      allow_redisplay: "always",
    },
  },
});
```

This would propagate to the resulting PaymentMethod at attach time. Theory: Stripe accepts this on the *client* even when the server SetupIntent body doesn't have a place for it. Verify in docs before pushing.

### Option B — Webhook-driven update after `payment_method.attached`

In `supabase/functions/stripe-webhook/index.ts` → `case "payment_method.attached"`, after the canonical row INSERT, also call `POST /v1/payment_methods/{pm.id}` with `allow_redisplay: 'always'`. Helper to add: `updatePaymentMethod` in `_shared/stripe.ts`.

Pros: handles all future cards uniformly without trusting client. Backfillable (run the update for existing PMs).
Cons: extra Stripe API call on every attach event.

### Option C — Customer Session `allow_redisplay_filters` opt-in

If Customer Sessions support an `allow_redisplay_filters: ['always', 'limited', 'unspecified']` array, then existing PMs with `unspecified` would surface without backfilling. This is the most elegant if it exists.

Verify in docs. If supported, modify `createCustomerSession` in `_shared/stripe.ts` to pass this.

### Recommended approach

1. **Read [Stripe docs](https://docs.stripe.com/api/payment_methods/object#payment_method_object-allow_redisplay) for `allow_redisplay`** — the canonical reference for where the field belongs
2. **Search via `mcp__stripe__search_stripe_documentation`** with queries like "allow_redisplay set value" and "Customer Session allow_redisplay_filters"
3. **Pick the option that matches the docs** — if C exists, use it (no backfill needed). If not, use B (covers all future cards + backfillable). A is also acceptable if it works but doesn't help backfill existing cards.
4. **Test against test-mode first** — Stripe MCP search + a single Add Card flow in test mode + Supabase MCP query to verify `allow_redisplay='always'` on the resulting PM
5. **Only push to production after the test-mode path works**

## How to verify your fix worked

After deploy:

```sql
-- Run via mcp__supabase__execute_sql:
-- A new test-mode card just added should have allow_redisplay='always' on Stripe's side.
-- We don't mirror that field in our DB, so verification requires hitting Stripe directly.
```

Then in browser, **test mode**:
1. Dashboard → Add card → test card `4242 4242 4242 4242` → Save
2. New shipment in test mode → destination → details → payment
3. PaymentElement should show "Visa •••• 4242" as the top option

Once test mode works, **live mode**:
1. Add a real card via Dashboard
2. New live shipment → payment step
3. PaymentElement should show the new card as top option

Per PLAYBOOK Rule 19, write a structured `Browser-verified:` block in the LOG entry covering at minimum:
- `variants-covered: {test-mode add → test-mode checkout}, {live-mode add → live-mode checkout}`
- Note any 3DS-redirect behavior on live (Task #13 — separate item but you'll bump into it)

## Things you might want to backfill

Three orphan live PaymentMethods exist on John's Stripe Customer `cus_UW55KG9mu1CNMB` from previous failed attempts:
- `pm_0TX3aRxS6gsndgF3fuOuPoXg` (visa 3138, no DB row)
- `pm_0TX3okxS6gsndgF3e4biE3Ct` (amex 5001, no DB row)
- `pm_0TX6jmxS6gsndgF3qBXrYxG2` (visa 3138, HAS DB row, the canonical post-rebuild one)

The third one was John's "verification" card. If your fix is option B (webhook update), you can backfill its `allow_redisplay` by updating it directly via Stripe API (`mcp__stripe__stripe_api_execute` with operation `PostPaymentMethodsPaymentMethod`, John approves). For the orphans (1 and 2), either detach them on Stripe-side as cleanup or backfill+attach DB rows. John's preference is probably the simple path — ask.

## Don't forget

- Task #13 — AddCardModal post-save navigation (`stripe.confirmSetup` redirects to a default URL when 3DS triggers on a real card; we don't pass `confirmParams.return_url`; the modal state is lost on the round-trip). Small fix you'll likely touch while in `AddCardModal.tsx` anyway — add `return_url: window.location.href` to `confirmParams`.
- Task #12 — account default API version (likely Stripe support ticket). Non-blocking; tracked for later.
- The Stripe account is on legacy short-format keys (Oct 10, 2012 account). John rotated them today to modern `pk_test_*` / `pk_live_*` / `sk_test_*` / `sk_live_*`. The 1Password items + Vercel env vars + Supabase Edge Function secrets are all up to date. The webhook endpoint signing secrets (`STRIPE_WEBHOOK_SECRET_TEST`, `STRIPE_WEBHOOK_SECRET_LIVE`) are also current.

## Wrap-up protocol

When done:
1. LOG.md entry under `## Decisions & Gotchas` with structured `Browser-verified:` block per Rule 19
2. Cross-link to this handoff doc
3. Update wallofshame.md if you hit any new non-obvious traps
4. Commit + push (push touches payments code path — ask John first per his rules)

Good luck. The hard part (Customer Sessions integration, webhook plumbing, key rotation, BUG A/B fixes) is all done. You're closing the last 5% on a single Stripe parameter.
