# Handoff — Pattern D verification + follow-ups

> Paste the body below into a fresh Claude Code session at `~/AI Brain/sendmo/`. Pattern D shipped 2026-05-18 (commit `69ac58b`); the migration was applied manually by John. This handoff covers what still needs to happen.

---

## You're picking up after Pattern D deployment

The Pattern D pivot for flex payments shipped today. It replaced the Phase E one-shot hold-and-capture model with the industry-standard save-PM + off_session-per-shipment model. See `PAYMENTS.md` (newly created — read it first) and the decided proposal `proposals/2026-05-16_flex-payment-pattern-d-execution_reviewed-2026-05-16_decided-2026-05-18.md`.

The previous session ran out of context after the code-review pass + commit. You're picking up at "post-deploy verification + remaining follow-up work."

## Read these first, in order

1. **`PAYMENTS.md`** — newly created in this session; the operational reference for anything payments-related. Read fully.
2. **`proposals/2026-05-16_flex-payment-pattern-d-execution_reviewed-2026-05-16_decided-2026-05-18.md`** — the decided spec. Skim the Review + Author response sections at the bottom for context on what was contested and resolved.
3. **`LOG.md`** entry `[2026-05-18] Pattern D` — has the "Browser-verified: PENDING" block. Your first job is to close that loop.
4. **`WISHLIST.md`** "Added 2026-05-18 — Pattern D follow-ups" block — the 10 explicit deferred items, ranked by likely impact.

## Job 1 (critical, do first) — close the verification loop

The `[2026-05-18] Pattern D` LOG entry has `Browser-verified: PENDING` and lists 6 verification steps. John was running step 1 (his stuck legacy link `BDnsjZTAhq` should auto-Active) at the end of the prior session. Status of the other 5 is unknown.

**Run the full mcp-session verification per PLAYBOOK Rule 19, then APPEND a structured `Browser-verified:` block to the LOG entry** (don't replace the PENDING text — leave it as audit trail, append the actual block below it):

```
**Browser-verified:**
  mcp-session: 2026-05-NNTHH:MM:SSZ
  variants-covered:
    - {recipient legacy flex link auto-Active on deploy} ✓ / ✗
    - {recipient creates new flex link via SetupIntent → step 23 within 30s} ✓ / ✗
    - {sender uses link → off_session charge succeeds → label generated} ✓ / ✗
    - {force decline (4000000000000341) → friendly error + recipient email + Inactive badge} ✓ / ✗
    - {recipient reactivates via email deep link → link Active} ✓ / ✗
    - {URL rotation → old code 410s, new works} ✓ / ✗
```

For each variant that fails, file a follow-up issue (LOG entry or WISHLIST item or new session) with: exact reproduction steps, observed vs expected, where in the code you traced the bug to.

## Job 2 — testing infrastructure handoff

The Pattern D PR shipped **without** new tests. This was intentional triage in the prior session (writing real Supabase + Stripe mocks is heavy lift). What's owed:

**Unit tests (Vitest):**
- `tests/unit/Dashboard.test.tsx` — Primary badge label + sort order, Active/Inactive transitions from `paymentMethods` state, "Update payment" / "Add a card" button label switching, `?reactivate=<id>` URL param auto-opens AddCardModal. **~90 LOC.** Mock `useAuth` + `supabase` client per the existing test setup pattern.

**Integration tests (Node scripts under `tests/integration/`):**
- `flex-off-session-charge.test.mjs` — exercises the `labels/` Edge Function flex branch against a local Supabase + Stripe test mode. Covers: off_session success, decline, missing PM, expired PM, cap exceeded, mode mismatch (link is_test vs request live_mode), rate-limit (5/60s per IP+short_code). **~150 LOC.**
- `links-is-funded.test.mjs` — covers all combinations of (link status, PM existence, PM expiry) against the `links/` GET endpoint. **~100 LOC.** Useful before any future change to the `is_funded` SQL.
- `links-rotate.test.mjs` — tests `POST /:id/rotate`: success path, rotate-then-old-code-410s, rotate-when-no-PMs, ownership check, prevent-rotate-on-cancelled-link. **~80 LOC.**

**E2E (Playwright spec):**
- `tests/e2e/flex-payment.spec.ts` — the full lifecycle e2e spec the proposal §4.2 calls for. Covers the 6 verification variants above + edge cases (PM removed mid-life, recipient adds 2nd card mid-life, sender abandons mid-flow). **~250 LOC.** Use Playwright network interception to mock Stripe responses; the existing pattern in `tests/e2e/auth.spec.ts` and `mockSupabaseAuth` helpers are the model.

**Recommended order:** ship the integration tests first (highest ROI; catch real Edge Function bugs cheaply). E2E spec second (catches integration drift). Unit tests last (lowest leverage, only catches UI label/behavior changes).

## Job 3 — high-value WISHLIST follow-ups

These are the ones likely to land soon (highest impact, smallest scope). Pick based on telemetry + product priority:

### Priority A — likely needed for production confidence

- **Pattern D' (ZDA verification at SetupIntent save)** — flip on if 1-2 weeks of `stripe_intents.last_payment_error_code` data on real flex shipments shows meaningful `card_declined` / `insufficient_funds` rates. The schema is shaped for it; the helper is ~30 LOC of webhook augmentation. Query in `PAYMENTS.md` §4 to evaluate decline rates.
- **Nightly background PM validation cron** — once-per-day $0/$1 auth+void on every active flex link's default PM. Catches replaced/cancelled cards before sender failure. Pair with the existing decline-recovery email. Requires a Supabase cron / scheduled Edge Function.
- **LinksEditor `/links/new` payment-validation integration** — the dashboard "+ New Link" path currently creates flex links **without** card collection. Under Pattern D the link is created `active` but `is_funded=false` until the recipient separately adds a card via Dashboard. UX works but is two-step. Pull the SetupIntent flow inline into `/links/new`.

### Priority B — quality-of-life

- **30-day card-expiry warning email** — when a recipient's default PM is within 30 days of `exp_year/exp_month`, send heads-up email with "update card" CTA.
- **Sender self-paid fallback flow** — when a flex link is Inactive at the front gate, offer the sender a self-paid label flow with recipient's address pre-filled.
- **Multi-PM retry on off_session decline** — if recipient has multiple saved PMs and default declines, labels-fn tries `is_default DESC, created_at DESC` before flipping link Inactive. Matches Stripe Smart Retries.

### Priority C — defer until forced

- **SCA / `requires_action` recovery flow** — for EU expansion only
- **Background-job worker for webhook side-effects** — defer email-send out of webhook critical path; only matters at scale
- **`sendmo_links.status` enum cleanup migration** — drop `'in_use'`, `'used'`, `'completed'` values (Pattern D doesn't write them). Cosmetic.
- **Fraud-mitigation escalation** — Stripe Radar / per-customer caps / soft-lock-after-N-failed-gates. Only matters if `link_state_events.charge_failed` bursts surface real fraud signal.

## Job 4 — debugging cheat sheet

When something looks broken in flex payments, check in this order:

### Recipient says "I added my card but link still shows Inactive"

1. Verify the recipient's `payment_methods` row exists for the correct mode: `SELECT * FROM payment_methods WHERE user_id = ? AND mode = ? AND deleted_at IS NULL`
2. Verify `is_default = true` on exactly one row
3. Verify exp_year/exp_month aren't in the past
4. Verify the link's `is_test` matches the PM's mode
5. Look in `event_logs` for `stripe.flex_links_activated` events near the time of the card add
6. If the `payment_method.attached` webhook didn't fire: check the Stripe Dashboard event log for the customer; check the `webhook_events` table for the event id; check the webhook subscription includes `payment_method.attached`

### Sender says "I got an error at Confirm"

1. Check `event_logs` for `label.flex_*` events near the time of the attempt — `label.flex_no_default_pm`, `label.flex_no_customer`, `label.flex_off_session_error`, `label.flex_mode_mismatch`, `label.flex_rate_limited`
2. If `label.flex_off_session_error`: look at `stripe_intents` row for the PI; `last_payment_error_code` tells you the decline reason
3. If `label.flex_mode_mismatch`: link's `is_test` doesn't match the sender's request `live_mode`. Sender flow always passes `live_mode: false`, so this fires only for live-mode links accessed in some unusual way.
4. If `label.flex_rate_limited`: 5+ requests in 60s from the same (IP, short_code). Wait and retry; or someone's probing.

### Recipient says "I got a decline email but nothing seems wrong"

1. Check the `link_state_events` table for the link: `SELECT * FROM link_state_events WHERE link_id = ? ORDER BY created_at DESC`
2. The most recent `charge_failed` event has the `reason` (Stripe decline code) in its `reason` column
3. If `card_declined`: insufficient funds, fraud block, or card revoked. Recipient updates card → link Active.
4. If `authentication_required`: SCA was triggered. v1 doesn't recover; recipient must update card.
5. Check `stripe_intents` for the PI: `last_payment_error_code` should match the decline_code

### Sender's link shows "Inactive" but the recipient swears the card works

1. Run the `is_funded` SQL from `links/index.ts` against the recipient's user_id and the link's mode. The most common cause is exp_year/exp_month in the past on the default PM — recipient needs to update the card.
2. Check `payment_methods` for any soft-deleted rows that should still be primary
3. Check `link_state_events` for a recent `pm_detached` event

### "We're seeing too many declines on cards that should work"

1. Run the decline-rate query in `PAYMENTS.md` §4
2. If `card_declined` rate is meaningful: probably worth adding Pattern D' (ZDA verification at SetupIntent save)
3. Check `payment_method.automatically_updated` webhook is firing — issuer pushed a new card-on-file and we missed it
4. Check if Stripe webhook subscriptions still include `payment_method.attached/detached/updated/automatically_updated` (Stripe wizard has dropped them silently before — see LOG entry on Phase B webhook rebuild)

## Job 5 — open questions for product

Surface these to John for product calls:

1. **Decline email language** — current copy is John's verbatim. After 2-4 weeks of real declines, consider: do we want to surface the decline reason ("Insufficient funds" vs "Card declined") or keep the message generic?
2. **Default-link sort on Dashboard** — currently shows the most recent flex link. If a user has multiple links (e.g., one for marketplace seller A, one for B), should the dashboard show them all, prioritize by usage, prioritize by Active state?
3. **Multi-PM UI** — Pattern D supports multiple saved PMs but only uses the default. Should the UI let the recipient toggle which PM is default? (Today: only the auto-promote logic in `payment_method.detached` chooses the default.)
4. **Sender notification on decline** — sender currently sees the error inline but gets no follow-up. If the recipient updates their card later, the sender doesn't know to retry. Should we capture sender email at Confirm step and notify them?

## Cross-cutting context

- **Auth flows** — fully separate handoff at `proposals/2026-05-14_oauth-and-session-handoff.md`. If anything in this work touches auth UX, coordinate with whoever owns that thread.
- **Flex OTP migration** — fully separate handoff at `proposals/2026-05-15_flex-otp-supabase-migration-handoff.md`. Confirmed shipped 2026-05-15. Not relevant to Pattern D directly but the session creation at flex step 21 is what makes the Supabase session available at step 22 for `createFlexLink`.

## Wrap-up protocol when done

1. LOG entry summarizing what verification confirmed + what didn't + what was added (tests, follow-ups).
2. Update `PAYMENTS.md` §7 (open items) if any wishlist items shifted priority based on verification findings.
3. Mark this handoff doc as `superseded` in frontmatter (no frontmatter today — add one when you're done) once the verification + first wave of tests land.

Good luck.
