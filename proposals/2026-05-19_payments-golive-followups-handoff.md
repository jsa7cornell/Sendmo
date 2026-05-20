# Handoff — Payments go-live + remaining debugging

> Paste the body below into a fresh Claude Code session at `~/AI Brain/sendmo/`.
> This continues the payments thread after a long 2026-05-19 session. The goal
> is **getting payments wired up for live mode** — most code is in place; what
> remains is verification, a few open bugs, and live-mode infra config.

---

## Where things stand (2026-05-19 end of session)

A large session shipped: the phone-number-required feature (FedEx/UPS
`PHONENUMBER.EMPTY` fix — forms + server + migration 025 + format-as-you-type
+ international), the LinksEditor inline-SetupIntent + saved-card row (#14),
six UX feedback items, the navigate/setState race fix (+ PLAYBOOK Rule 20), the
"Continuing…" stuck-spinner fix, a CI flaky-test fix, regression tests, and a
security-advisory cleanup (migration 026 dropped 7 dead Prisma tables).

`main` CI is green. Migrations 025 + 026 are applied to prod. Migration 027
(security advisor view/function cleanup) is spawned as a separate task — not
part of this handoff.

## Read first, in order

1. **`PAYMENTS.md`** — operational reference for the whole payment architecture. Read fully.
2. **`LOG.md`** — the 2026-05-19 entries (phone-required, format-as-you-type, stuck-spinner, security advisor) and the 2026-05-18 Pattern D entry.
3. **`proposals/2026-05-18_pattern-d-verification-and-followups-handoff.md`** — the prior handoff. Its **Pattern D verification steps F1–F6 were never fully run** — carried forward as Job 1 below.
4. **`WISHLIST.md`** — "Added 2026-05-18 — Pattern D follow-ups" + the Apple Pay / Stripe-migration entries.

## Job 1 (critical — the gate) — verify the flex payment flow end to end

None of the Pattern D flex money-path has been exercised since it shipped
2026-05-18. The phone work this session was never confirmed against a real
FedEx purchase either. **This is the gate before live mode.** Run as John
(authenticated) — these need a real session + Stripe test cards:

| # | Test | Pass criteria | DB / log checkpoint |
|---|---|---|---|
| **F1** | Create a flex link via `/links/new` or onboarding — enter a phone | Link `active`, `is_funded=true` | `sendmo_links.status='active'`, `payment_methods` row, `link_state_events.activated` |
| **F2** | Anonymous sender uses the link → **pick FedEx** → off_session charge → label | Label generated, **no `PHONENUMBER.EMPTY`** (the phone-work payoff) | `stripe_intents.status='succeeded'`, `transactions.type='charge'` |
| **F3** | Force-decline: Stripe test card `4000 0000 0000 0341` | Sender sees friendly error; recipient gets `payment_declined_reactivate` email; link badge → Inactive | `link_state_events.charge_failed`, `sendmo_links.last_decline_email_at`, `stripe_intents.last_payment_error_code='card_declined'` |
| **F4** | Recipient clicks the email's reactivate deep link → adds card → link Active | `?reactivate=<id>` auto-opens AddCardModal; link returns Active | new `payment_methods` row + `link_state_events.activated` |

If F2 still throws `PHONENUMBER.EMPTY`: the recipient address phone or the
sender address phone didn't reach EasyPost. Trace: `rates/index.ts` pulls the
recipient phone from the DB row; `labels/index.ts` passes `p_from_phone`/
`p_to_phone` to `admin_insert_shipment`. The legacy link `4eRwtdVffe` (created
pre-phone-requirement) will still fail FedEx by design — use a freshly-created
link for F2.

After F1–F4, append a `Browser-verified:` block to the relevant LOG entries
(the 2026-05-18 Pattern D entry still says `PENDING`).

## Job 2 — open bugs

### 2a. Admin debug panel renders for non-admins (`#5` from the session)
`AdminDebugPanel` on `/t/<code>` can render for a non-admin during the window
after an account switch, because `isAdmin` in `AuthContext` isn't reset
synchronously when `user.id` changes. The server (`requireAdmin`) still
rejects the data fetch, so no data leaks — but the UI shell shows. The
**3-layer fix is fully scoped** (synchronous `isAdmin` reset on user.id change
+ a `profileLoaded` gate + optional `getUser()` validate-on-use). It was never
shipped — John wanted to repro first. Re-derive from the AuthContext code
(`src/contexts/AuthContext.tsx` `onAuthStateChange`) and ship layers 1+2.

### 2b. `admin_insert_shipment` / `set_admin_active_mode` anon-executable (security WARN)
The security advisor flags both as SECURITY DEFINER functions executable by
`anon`/`authenticated` via `/rest/v1/rpc/…`. Before dropping the grant: confirm
whether `supabase/functions/labels/index.ts` calls `admin_insert_shipment` with
the **service-role** key (it creates a client with `SUPABASE_SERVICE_ROLE_KEY`).
If yes → the `anon`/`authenticated` grant is dead weight and can be `REVOKE`d
(prevents anon callers spamming the shipments table). If the function is
called with the anon key anywhere, the grant is load-bearing — leave it.
`set_admin_active_mode` enforces `role='admin'` internally but is still
anon-callable; same review. This is a careful migration 028 candidate.

### 2c. UPS missing from rate options (intermittent)
WISHLIST "Bugs" — EasyPost test-mode UPSDAP sporadically returns an invalid
response, dropping UPS from the rate set. Environmental, not a SendMo bug.
**Verify UPS quotes consistently in LIVE mode** before investing in retry logic.

## Job 3 — live-mode infrastructure (the actual go-live work)

Config, not code. Per `PAYMENTS.md` §8:

**Stripe live mode:**
- [ ] `STRIPE_SECRET_KEY` (live `sk_live_…`) + `VITE_STRIPE_PUBLISHABLE_KEY` (live) in Vercel production env
- [ ] Live-mode webhook endpoint at https://dashboard.stripe.com/webhooks subscribing to **all 11 events** in `PAYMENTS.md` §8 (verify each — the Stripe wizard has silently dropped events before)
- [ ] `STRIPE_WEBHOOK_SECRET` (live `whsec_…`) in Vercel env

**EasyPost live mode:**
- [ ] `EASYPOST_API_KEY` (`EZAK…`, not `EZTK…`) in Vercel production env
- [ ] USPS / FedEx / UPS carrier accounts enabled in the EasyPost live dashboard

**Then — live smoke test:** toggle admin mode to `live_charge`, buy one real
label end-to-end (real card, ~$7–12), confirm charge + real tracking number +
label-created email. That's the "is this actually real" gate.

## Job 4 — WISHLIST Priority A (post-verification)

- **Pattern D' (ZDA verification at SetupIntent save)** — flip on only if 1–2 weeks of `stripe_intents.last_payment_error_code` data shows real `card_declined`/`insufficient_funds` rates. Decline-rate query is in `PAYMENTS.md` §4.
- **Nightly background PM-validation cron** — $0/$1 auth+void on every active flex link's default PM; catches replaced/cancelled cards before sender failure. Supabase scheduled Edge Function.
- **Apple Pay domain verification** — `WISHLIST.md` has the full step-by-step; post-launch, not a blocker.

## Cross-cutting context

- **Spawned-task hygiene:** the 2026-05-19 session spawned many background agents. Most landed on `main`; a few worktree branches may be unmerged. Run `git worktree list` + `git branch -a` at session start and reconcile/clean up stale `claude/*` branches.
- **Migration 027** is in flight as a separate spawned task (security advisor: `user_wallet_balance` view → security_invoker, function search_path, revoke `handle_new_user`). Don't duplicate it; do check it landed.
- **PLAYBOOK Rule 20 ("telemetry before browser")** was added this session — when a user reports "stuck / not working," query DB + edge-function logs *first*.
- **Verification discipline (Rule 19):** browser-verify product-surface changes; the session's hard-won lesson is that agent confidence ≠ verification.

## Wrap-up protocol when done

1. LOG entries for everything shipped, with `Browser-verified:` blocks.
2. Update `PAYMENTS.md` §7 open-items if priorities shifted.
3. Mark this handoff `superseded` once Job 1 verification + the live smoke test land.

Good luck — Job 1 is the highest-leverage thing on the board.
