# SendMo — Pre-Launch Checklist

> **Purpose:** the definitive list of what stands between "admin dogfood works" and
> "safe to open live payments to real customers." Authored 2026-07-04 from a full
> readiness review (code + test/CI + operational surveys). Each item is written so a
> fresh agent (or John) can execute it without re-deriving context.
>
> **How to use:** work top-down. Tier 1 blocks any non-admin traffic. Tier 2 should
> land in launch week. Tier 3 is harden / fast-follow. Check items `[x]` as they land
> and add a one-line dated note. When Tier 1 is fully checked, write the
> "live to customers" entry in `LOG.md` — the launch-crossed marker.
>
> **Legend:** 👤 = John (manual / secrets / dashboard) · 🤖 = agent (code) ·
> 🔴 blocker · 🟡 recommended · 🔧 harden.

---

## ⚠️ Critical context — read before touching payments

**Today, no real customer can actually pay.** Live-vs-test mode is **role-driven**, not
environment-driven:

- Client: [`AuthContext.tsx:198`](src/contexts/AuthContext.tsx) →
  `liveMode = isAdmin && (adminActiveMode === "live_comp" || "live_charge")`. A non-admin
  never sends `live_mode: true`.
- Full-label server: [`payments/index.ts:226`](supabase/functions/payments/index.ts) →
  `isLive = clientWantsLive && callerRole === "admin" && callerAdminMode === "live_charge"`,
  then an additional `PAYMENTS_ALLOWED_USERS` allowlist gate (line ~230, empty = closed).
- Flex/off-session server: [`labels/index.ts:121`](supabase/functions/labels/index.ts) →
  `isLive = live_mode === true`, cross-checked against the link's `is_test`
  (line ~235). And `sendmo_links.is_test` **defaults to TRUE** at creation
  ([`links/index.ts:495`](supabase/functions/links/index.ts)).

Net effect: a non-admin visitor falls through to **test mode** — fake label, no money.
"Going live" = deliberately decoupling live-mode from admin-role so customers transact
live by default. That is item **T1-1**, the riskiest change on this list, and it has
**never run for a non-admin in production.** There is also **no `APP_ENV`/`SENDMO_ENV`
signal in the codebase today** — establishing one is a shared prerequisite for T1-1 and
T2-4. See **Appendix A** for the full architecture map.

---

## 🔴 Tier 1 — Launch blockers (nothing but John transacts until these land)

### T1-1 🤖 Open the live-payment path to real customers  ⬅ the launch switch
**Status:** `[~]` **LIVE in CLOSED BETA (flipped 2026-07-05).** Implemented (6 gates + `_shared/mode.ts` + kill switch), merged (#35), env flipped: `SENDMO_ENV=production`, `SENDMO_LIVE_DEFAULT=true`, `VITE_SENDMO_LIVE_DEFAULT=true` (Vercel Production-only), `PAYMENTS_LIVE_ALLOWLIST_ONLY=true`, `PAYMENTS_ALLOWED_USERS` = John's UID only. So **only John's UID can charge live today**; everyone else is blocked by the allowlist. Smoke-tested live: full flex buy (24W301E, $15.95 charge → $13 UPS label → +$2.19 margin, ledger reconciled) + live cancel→refund (after the #37 fix + backfill below). **Remaining to fully open:** widen `PAYMENTS_ALLOWED_USERS` → run T2-2 non-happy paths → flip `PAYMENTS_LIVE_ALLOWLIST_ONLY=false` → write the launch-crossed LOG entry. Decided proposal: [proposals/2026-07-04_customer-live-payments_reviewed-2026-07-04_decided-2026-07-04.md](proposals/2026-07-04_customer-live-payments_reviewed-2026-07-04_decided-2026-07-04.md). **Security review of the opened surface is running (2026-07-06 chip).**

> **Bugs found & fixed during the flip's own dogfood (2026-07-05/06):**
> - **Flex cancel skipped the refund** — flex shipments never stitched their off-session PI onto `shipments.stripe_payment_intent_id`, so cancel wrote `refund_status='not_applicable'` and never refunded. Fixed: PR #37 (stitch from `verifiedPaymentIntent.id`) + 24W301E backfilled. Closes the flex half of T2-2.
> - **Flex allowlist bypass** — the closed-beta lever was only enforced on full-label; the flex charge + live-link creation skipped it. Fixed: PR #36 (`_shared/allowlist.ts`, shared gate on all live-charge entry points).
> - **Auth email totally broken** — the `auth-email-hook` (Supabase Send Email hook) returned 500 on every OTP/magic-link since 2026-05-27 because `SEND_EMAIL_HOOK_SECRET` was never set (invisible: John uses Google login). Fixed 2026-07-06 (John set the secret; verified end-to-end). **All email sign-in was down for 6 weeks — add to launch verification.**

**Why it matters:** the entire live/test split assumes "admin in an admin mode." Real
customers currently get test-mode labels. This is the single change that makes SendMo a
real product — and the highest-risk one, because it opens the money path to the public.

**Design (recommend before coding — write `proposals/2026-07-xx_customer-live-payments.md`):**
Make live-vs-test **environment-driven, not role-driven**, keeping Rule 14 (server decides):
1. **Establish a production signal** (none exists today). Add a server env var, e.g.
   `SENDMO_LIVE_DEFAULT=true`, set only on the production Supabase functions. This same
   signal powers T2-4 (key-mismatch guard).
2. **Invert the default:** in production, a non-admin authenticated (or anonymous) payer
   resolves to **live**; admins keep the toolbar to force `test`/`live_comp` for their own
   dogfooding. Test mode becomes the admin/staging special case, not the default.
3. **Keep `PAYMENTS_ALLOWED_USERS` as the soft-launch ramp** — during the initial window,
   only allowlisted UIDs charge live; widen it, then remove the gate once confident.

**Files to change (trace each — line numbers drift):**
- [`src/contexts/AuthContext.tsx`](src/contexts/AuthContext.tsx) ~198 — `liveMode` derivation
  (customers → live in prod).
- [`supabase/functions/payments/index.ts`](supabase/functions/payments/index.ts) ~226 —
  full-label `isLive` derivation + ~230 allowlist gate.
- [`supabase/functions/labels/index.ts`](supabase/functions/labels/index.ts) ~121 / ~235 —
  flex `isLive` + the `linkIsLive !== isLive` mode-mismatch defense.
- [`supabase/functions/links/index.ts`](supabase/functions/links/index.ts) ~495 —
  `sendmo_links.is_test` default; customer links must be created **live** in prod.
- **Leave the comp path admin-only** (unchanged) — comp is an admin-only affordance.

**Verification (all before opening the allowlist):**
- Non-admin test user completes a **full-label** buy → real Stripe live charge → real
  EasyPost label → `shipments` row + `transactions.charge` + `fee_stripe` + `label_cost`
  rows present. Confirm in `event_logs` / reconciliation dashboard.
- Non-admin creates a **flex link** → it's created `is_test=false` → a sender completes it
  → off-session charge succeeds.
- Admin can still force **test** and **live_comp** from the toolbar (no regression).
- A non-allowlisted user during the ramp gets the 403 (`payment.live_charge_blocked`).

**Gotcha:** the flex path's live-ness is anchored to the *link's* `is_test`, set at
creation time — so the fix must span link-creation AND the buy paths, or a customer's
live link will collide with a test-mode buy and reject.

---

### T1-2 👤 Upgrade Supabase to Pro (kill Free-tier auto-pause)
**Status:** `[x]` **done (John, 2026-07-04)** — Pro active; auto-pause gone; daily backups now available. Unblocks T2-1 (cron registration).

**Why it matters:** on **2026-06-27 the entire app went dark** — the Free-tier project
auto-paused after ~7 days idle and its `*.supabase.co` host stopped resolving (DNS
`ERR_NAME_NOT_RESOLVED`). See [`LOG.md`](LOG.md) "Login broken = Supabase project
auto-paused." A product taking money cannot silently vanish every idle week. **Bonus:**
Pro also enables **daily backups** — Free has none, which is exactly what made the
2026-05-04 prod-wipe unrecoverable (Rule 0.5). Pro closes both gaps.

**Steps:**
1. Supabase Dashboard → project `fkxykvzsqdjzhurntgah` → Settings → Billing → upgrade to Pro.
2. Confirm **"pause after inactivity" is gone** from the project's compute settings.
3. Confirm **Daily backups** now appear under Database → Backups.

**Verification:** `https://fkxykvzsqdjzhurntgah.supabase.co/auth/v1/health` returns
`{"message":"No API key found in request"}` (host alive) and the project shows no pause
schedule. No keep-alive cron exists in-repo (grep-confirmed), so nothing to remove.

---

### T1-3 🤖🔧 Wire error monitoring + failure alerting (stop flying blind)
**Status:** `[~]` **Server-half done + live; Sentry + PostHog OUT (John, 2026-07-06: "i dont think we'll do sentry and post hog. fully deferred." / "we dont want to do sentry and posthog") — not a launch blocker. Never create those accounts or set `VITE_SENTRY_DSN`/`VITE_POSTHOG_KEY`.** The merged frontend layer (`364462a`, decided proposal [proposals/2026-07-06_sentry-posthog-frontend-monitoring_reviewed-2026-07-06_decided-2026-07-06.md](proposals/2026-07-06_sentry-posthog-frontend-monitoring_reviewed-2026-07-06_decided-2026-07-06.md), reversal addendum at its end) ran **inert** its whole life — no accounts, no env vars, no monitoring network calls, no data ever left the browser — and is now slated for **removal + GA4-only analytics replacement** in the in-review [proposals/2026-07-06_ga4-acquisition-analytics.md](proposals/2026-07-06_ga4-acquisition-analytics.md); until that proposal is decided the code simply stays inert. **What stands as T1-3's deliverable — the alerting that actually matters for a money product — is the server half, live since 2026-07-04:** `_shared/alert.ts:sendAdminAlert` fired from `label.buy_error`, `label.auto_refund_failed` (both sites), `label.flex_off_session_error`, and the stripe-webhook refund-failed path (`SENDMO_ADMIN_EMAIL` fallback to John's Gmail is the **intended** config, John 2026-07-04 — no secret needed). **The CrashScreen error boundary is the one live frontend win** (branded crash page instead of a white screen — vendor-free; survives the removal on a plain React boundary). **👤 Remaining: NONE.** **Known accepted gap (pending John's OQ1 call in the GA4 proposal):** frontend JS errors have no monitoring — a browser-side crash surfaces only via the CrashScreen support mailto; server money-path failures still alert. Whether T1-3 closes as "done, frontend half intentionally dropped" is John's call at that proposal's decision.

**Why it matters:** [`PLAYBOOK.md`](PLAYBOOK.md) lists Sentry + PostHog but **neither is in
the code** (zero imports in `src/`). Across **26 edge functions**, a 500 or a failed charge
is invisible unless someone manually SQL-queries `event_logs`. You cannot run a money
product with no alerting.

**Build (reuse the existing admin-alert pattern — Rule 6):**
1. **Frontend errors — Sentry.** `@sentry/react` init in
   [`src/main.tsx`](src/main.tsx); DSN via `VITE_SENTRY_DSN` (👤 John adds the env var in
   Vercel). Wrap the router; enable release tracking.
2. **Edge-function + payment failures — extend the existing alert.** There is already an
   admin-alert email at [`stripe-webhook/index.ts:963`](supabase/functions/stripe-webhook/index.ts)
   (`SENDMO_ADMIN_EMAIL` → Resend, for `refund.failed`). **Extract it to
   `_shared/alert.ts:sendAdminAlert({subject, body})`** and fire it from every
   `severity:"error"` path that today only writes `event_logs` — at minimum:
   `payment.live_charge_blocked` (unexpected), `label.buy_error`, `auto_refund_failed`,
   any `createRefund`/`createOffSessionShipmentPI` catch.
3. **Analytics — PostHog** (lower priority): `posthog-js` in `src/main.tsx`, key via
   `VITE_POSTHOG_KEY`. Track onboarding funnel + buy conversion. Can be a fast-follow.

**Verification:** throw a test error in a preview build → Sentry issue appears. Force an
edge-function error path (e.g. decline a test off-session charge) → admin alert email lands
+ `event_logs` error row present.

**Gotcha:** keep `sendAdminAlert` fire-and-forget with its own try/catch (never let the
alert failure mask or block the original handler) — mirror the existing
`refund.failed_alert_email_error` fallback.

---

## 🟡 Tier 2 — Strongly recommended (launch week)

### T2-1 👤🤖 Register the cron sweeps (pg_cron)
**Status:** `[x]` **DONE — activated + verified end-to-end 2026-07-06 (agent).** All 3 jobs registered + active AND the `service_role_key` Vault secret is now set, so the sweeps authenticate. Both extensions enabled (`pg_cron` 1.6.4, `pg_net` 0.19.5); `reconciliation-sweep-daily` (`0 4 * * *`) + `refund-cron-sweep-daily` (`30 4 * * *`) + `reconciliation-sweep-weekly` (`0 5 * * 0`) all `active=t` on prod; and a shipped **cron-auth bug fix** (see below). Decided proposal: [proposals/2026-07-06_register-cron-sweeps_reviewed-2026-07-06_decided-2026-07-06.md](proposals/2026-07-06_register-cron-sweeps_reviewed-2026-07-06_decided-2026-07-06.md). The weekly job was initially deferred, then **registered per John's call during the same-day parallel-arc takeover** (proposal takeover addendum); its wall-clock-under-volume risk is WISHLIST-tracked ("Weekly reconciliation sweep vs Edge wall-clock").

> **Bug found + fixed during registration:** `cron-refund-sweep` called `requireAdmin` unconditionally with **no cron-auth-bypass** (its sibling `reconciliation-sweep` had one) → a pg_cron service-role Bearer would 403 "Profile not found" → **the refund finalizer would silently never run.** Fixed via new `_shared/cron-auth.ts` (`isCronCall`) imported by both sweeps (also closed an env-read asymmetry). Deployed via CI on the T2-1 push.
>
> **GUC → Vault:** the `ALTER DATABASE SET app.*` GUC route in the steps below is **impossible on this project** (postgres is `rolsuper=off` → `ERROR 42501: permission denied to set parameter`, for the agent AND John). Switched to the Supabase-canonical **Vault** pattern: the cron bodies read `supabase_url` + `service_role_key` from `vault.decrypted_secrets`. The agent stored the non-secret `supabase_url`.

**DONE — Vault secret set (agent, 2026-07-06):** the `service_role_key` Vault secret was stored via a Rule-0-safe path — `op read` piped the JWT straight into `psql` at runtime, so the value never entered the transcript or any tool arg. Verified in-DB (boolean output only): the stored secret **decrypts byte-for-byte to the 1Password `SB_SERVICE_ROLE_KEY`**, both `service_role_key` + `supabase_url` are present in `vault.decrypted_secrets`, and the `postgres` (pg_cron worker) role can SELECT it. (Original John-only step retired — the runtime-injection path made it agent-safe.)
```sql
-- what ran (JWT injected at runtime via op; never rendered):
SELECT vault.create_secret('<jwt-from-op>', 'service_role_key', 'pg_cron sweep auth (T2-1) — set 2026-07-06');
```

**Verified end-to-end (2026-07-06):** invoked the deployed `cron-refund-sweep` with the service-role Bearer → **HTTP 200** `{"success":true,"processed":0,...}` (was the silent-403 before the Vault secret + cron-auth fix). So the `isCronCall` auth path now passes and the nightly jobs will authenticate. `reconciliation-sweep` shares the same `_shared/cron-auth.ts`, so it authenticates identically; its first real run is the natural 04:00 UTC fire (deliberately not force-run — read-heavy EasyPost list-load). Health signal = downstream state advancing (`recon_state.*.last_run_at`), NOT `job_run_details.status` alone (pg_net is fire-and-forget).

**Gotcha:** the two jobs are offset 04:00 vs 04:30 UTC as the migrations specify — avoids
concurrent EasyPost list-load.

---

### T2-2 👤 Verify the non-happy-path money flows in LIVE
**Status:** `[~]` **partially done 2026-07-05/06.** **(a) Live cancel→refund: VERIFIED (after a fix).** The first live flex cancel exposed the PI-stitch bug (refund silently skipped); fixed (#37) + 24W301E backfilled → cancel now resolves `refund_status='submitted'` and refunds. Re-confirm on a fresh flex cancel once you're satisfied. **(b) Carrier reweigh/adjustment (H2): still UNVERIFIED live** — hasn't fired naturally; POST a synthetic `shipment.invoice.created` to exercise it. **(c) Rate-changed 409 gate: still UNVERIFIED live.**

**Why it matters:** you've proven live *create* (the real ship+deliver). You have **not**
cleanly verified, in live, since the fixes landed: **(a)** cancel → refund → the 3
lifecycle emails (your one live cancel, YPPY9AK, hit bugs that were fixed afterward — see
[`LOG.md`](LOG.md) 2026-05-24), and **(b)** a carrier reweigh/adjustment recharge (H2),
which has likely never fired live at all.

**Test script:**
1. **Live cancel/refund:** buy a live label → cancel via `/admin` → confirm: Email A
   (submitted) sends; when EasyPost confirms, `transactions` gets the `-refund` +
   `easypost_refund` rows, `shipments.refund_status → refunded`, Email B sends. Watch
   `event_logs` for the `cancel.stripe_refund_initiated` cluster.
2. **Carrier adjustment:** if a live shipment gets reweighed, confirm the
   `shipment.invoice.*` webhook writes a `carrier_adjustments` row and `resolveRecovery`
   fires per tier (≤$1 absorb / $1–$10 recharge / >$10 flag). If none occurs naturally,
   POST a synthetic `shipment.invoice.created` in test mode to exercise the arm.
3. **Rate-changed gate:** confirm a buy where the EasyPost rate drifts >threshold returns
   the 409 + refund (RateChangedDialog).

**Verification:** each path leaves the correct ledger rows + emails; reconciliation
dashboard shows net margin correct.

---

### T2-3 🤖 Rate-limit the public unauthenticated endpoints
**Status:** `[x]` **done 2026-07-04** — `_shared/ratelimit.ts` extracted; the **4** inlining functions refactored (checklist said 5 — `payment-methods` never had one; it's JWT-gated + PM-add breaker); IP limits applied: addresses 20/min · rates 10/min (SPEC §14) · guestimate 10/min · autocomplete 60/min · place-details 20/min. 9 unit tests. See LOG.

**Why it matters:** `addresses`, `rates`, `guestimate`, `autocomplete`, `place-details`
have **no rate limiting** — anyone can spray them and burn your EasyPost/Google quota. The
authenticated/flex paths are already limited.

**Build (reuse existing pattern — Rule 6):** the in-memory limiter already exists inline in
[`cancel-label/index.ts:43-48`](supabase/functions/cancel-label/index.ts) (`RATE_LIMIT_MAX=5`,
`RATE_LIMIT_WINDOW_MS=60_000`, `rateBucket` Map → 429). **Extract it to
`_shared/ratelimit.ts:checkRateLimit(key, {max, windowMs})`** and call it (keyed on client
IP from `x-forwarded-for`) at the top of: `addresses`, `rates`, `guestimate`, `autocomplete`,
`place-details`. Suggest ~20/min/IP for these read endpoints. Refactor the 5 functions that
already inline it to use the shared helper.

**Verification:** hammer `/rates` >20×/min from one IP → 429 with the standard body.

**Gotcha:** in-memory buckets don't share across edge-function instances/cold-starts —
fine as a speed bump (matches current pattern). If real abuse appears, escalate to a
DB/Upstash-backed limiter (note in WISHLIST).

---

### T2-4 🤖 Key-mismatch safety rail (test key in prod = hard fail)
**Status:** `[~]` **bundled into T1-1 implementation (2026-07-04)** — keyed on `SENDMO_ENV=production` (the identity signal, NOT the kill switch, so an incident flip never disarms the guard — see proposal review B5).

**Why it matters:** [`STAGING_PLAN.md`](STAGING_PLAN.md) §5 specified a guard that throws
if a test key runs in production; it was never built. One misconfigured secret could
silently route real customers to test mode (no money, fake labels) or vice-versa.

**Build:** `_shared/env-guard.ts:assertKeysMatchEnv()` — when the T1-1 production signal is
set, throw `"FATAL: Environment key mismatch"` if `EASYPOST_API_KEY` starts with `EZTK`
(test) **or** `STRIPE_SECRET_KEY` starts with `sk_test_`. Call it once at the top of the
money-path functions (`payments`, `labels`, `stripe-webhook`). Cheap insurance.

**Verification:** locally set the prod signal + a test key → function refuses to start /
returns 500 with the FATAL message. Unset signal → no-op (dev unaffected).

---

## 🔧 Tier 3 — Harden / fast-follow

### T3-1 🤖 Make the e2e suite trustworthy, then blocking
**Status:** `[ ]` · type-check + 476 unit tests are green & **blocking** (good). But the
**e2e suite is non-blocking** (`continue-on-error` in [`.github/workflows/test.yml`](.github/workflows))
and ~14 specs go red in CI because `VITE_GOOGLE_MAPS_API_KEY` isn't set, so
`fillSmartAddress` times out waiting for autocomplete. **Fix:** pick one — (a) add the Maps
key to CI secrets, (b) route-mock the Maps script in the harness, or (c) use the
manual-entry address path in tests. Then flip the e2e step to blocking. Also re-home the
known-broken `label-flow.spec.ts` (pre-existing breakage from the 2026-05-20 refactor). See
[`TESTING.md`](TESTING.md) + [`WISHLIST.md`](WISHLIST.md) "Fix Google Maps autocomplete in CI e2e."

### T3-2 🤖 Failure-mode tracking emails (return-to-sender, exceptions)
**Status:** `[ ]` · `return_to_sender` and EasyPost delivery exceptions are **silent DB
states** — a customer told "on its way" never hears if it's returned/held. Extend
`NOTIFY_STATUSES` in [`tracking/index.ts`](supabase/functions/tracking/index.ts) +
[`webhooks/index.ts`](supabase/functions/webhooks/index.ts) and add templates in
[`_shared/email-templates.ts`](supabase/functions/_shared/email-templates.ts). Full spec in
[`WISHLIST.md`](WISHLIST.md) "Failure-mode tracking emails."

### T3-3 🤖 Public-facing polish
**Status:** `[ ]` · the moment strangers see it: SendMo logo in nav + email templates,
real favicon / apple-touch / PWA icons / OG image (currently placeholders), and
signed-in users landing on `/dashboard` instead of the marketing homepage. All tracked
under [`WISHLIST.md`](WISHLIST.md) "UX / Polish."

### T3-4 🤖 Secure the label PDF URL
**Status:** `[ ]` · after a buy, the label links to a **public EasyPost URL** — anyone with
the link can fetch the label. Serve a signed/expiring URL (Supabase Storage signed URL, or
proxy through an authed edge function). [`WISHLIST.md`](WISHLIST.md) "Label download link
should be secure."

---

## ✅ Already solid — do not re-litigate

These were verified during the 2026-07-04 review; treat as done for launch:

- **Both customer flows + the sender flow are production-complete.** (PLAYBOOK's "stub"
  labels for `SenderFlow.tsx` / `src/components/sender/` / `RecipientStepFlexPayment.tsx`
  are **stale** — all shipped weeks ago. See T-doc note below.)
- **Webhook signature verification** — Stripe + EasyPost HMAC, live since 2026-05-13.
- **RLS** on every core table (`profiles`, `sendmo_links`, `shipments`, `transactions`,
  `payment_methods`, `holds`, `refunds`, `carrier_adjustments`, …).
- **Append-only `transactions` ledger** + reconciliation dashboard + admin refund tool +
  carrier-adjustment recovery (H1–H5 all shipped).
- **Risk controls** — Stripe Radar, Account Budget, velocity caps, per-shipment cap.
- **ToS + Privacy** pages exist and are real (`/terms`, `/privacy`).
- **Type-check + unit gate** green and blocking in CI (476 tests).

**Explicitly post-launch (NOT blockers):** Seller Marketplace link, real insurance (toggle
currently hidden), saved addresses, Apple Pay, esm.sh→JSR import migration, lint cleanup.

**Stale-doc cleanup (2-min, do anytime):** [`PLAYBOOK.md`](PLAYBOOK.md) ~266-269 still
calls the shipped sender/flex flows "stubs." Correct it so it stops misleading agents.

---

## Appendix A — live/test architecture (load-bearing for T1-1)

```
CLIENT                          SERVER (re-derives, Rule 14)
─────                           ────────────────────────────
AuthContext.liveMode            payments/index.ts (full-label):
 = isAdmin && mode∈             isLive = clientWantsLive
   {live_comp,live_charge}               && callerRole==="admin"
        │                                && callerAdminMode==="live_charge"
        │                        + PAYMENTS_ALLOWED_USERS allowlist (empty=closed)
        ▼
 live_mode: bool  ───POST───►   labels/index.ts (flex/off-session):
                                isLive = live_mode===true
                                cross-checked vs sendmo_links.is_test
                                (default TRUE) — mismatch ⇒ reject

Today: non-admin ⇒ isLive false ⇒ TEST mode ⇒ fake label, no money.
Launch (T1-1): production env signal ⇒ non-admin ⇒ LIVE by default;
               admin toolbar still forces test/comp for dogfood.
```

Chargers/keys: the backend holds **both** keysets and switches on `isLive` —
`EASYPOST_API_KEY` vs `EASYPOST_TEST_API_KEY`, live vs test Stripe secret,
`stripe_customer_id_live` vs `_test`. There is **no `APP_ENV`/`SENDMO_ENV` signal today** —
T1-1 must introduce one, and T2-4 reuses it.

---

## Reference

- Launch framework (H1–H5, all shipped): [`proposals/2026-05-23_pre-launch-handoff-plan.md`](proposals/2026-05-23_pre-launch-handoff-plan.md)
- P1-build-complete marker (not launch-crossed): [`LOG.md`](LOG.md) 2026-05-24 "Pre-launch P1 wrap-up"
- Payment architecture: [`PAYMENTS.md`](PAYMENTS.md) · Risk controls: [`RISKMANAGEMENT.html`](RISKMANAGEMENT.html)
- Test layers: [`TESTING.md`](TESTING.md) · Open items: [`WISHLIST.md`](WISHLIST.md)

*When Tier 1 is `[x]` across the board, write the "live mode opened to customers" entry in
`LOG.md` — that is the launch-crossed marker this project has been reserving.*
