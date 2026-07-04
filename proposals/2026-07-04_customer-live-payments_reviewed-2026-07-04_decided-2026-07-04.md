---
title: Open the live-payment path to real customers (decouple live-mode from admin-role)
slug: customer-live-payments
project: sendmo
status: decided
created: 2026-07-04
last_updated: 2026-07-04 (author response + decision recorded)
reviewed: 2026-07-04
decided: 2026-07-04
author: Claude (Opus 4.8) — pre-launch readiness review, 2026-07-04; found the admin-only payment gate while mapping what stands between dogfood and launch
reviewer: Claude (Fable 5) — fresh-eyes pre-launch session, 2026-07-04; verified every gate site against code + prod DB
outcome: approve-with-changes
---

> **Why this is a proposal and not a quick edit:** this is the single change that lets
> strangers move real money through SendMo. It touches four gate sites across a
> security boundary, inverts a default that has protected you the entire dogfood phase,
> and has **never run for a non-admin in production.** A wrong flip either charges test
> cards (no money, fake labels — silent revenue loss) or exposes the money path before
> the safety rails are set. It earns the protocol.

## 1. Context

**The problem.** No real customer can pay today. Live-vs-test mode is **role-driven**:
the system only ever charges real money when the caller is an *admin* in an *admin mode*.
A non-admin visitor falls through to **test mode** — they complete the whole flow, get a
fake EasyPost label, and no money moves. You proved the golden path (real ship + deliver)
as yourself, an admin, in Live Charge mode. Opening to customers means making live mode
the default for everyone else — which is exactly the change the role-gating was built to
prevent during dogfood.

**Why now.** The P1 build is complete (H1–H5 shipped), both customer flows + the sender
flow are production-built, the ledger/reconciliation/refund machinery works. Feature work
is not the blocker. This gate is. It is item **T1-1** in [`PRE-LAUNCH.md`](../PRE-LAUNCH.md).

**Non-goals.** This proposal does **not** change pricing, the label/rate logic, the ledger,
refunds, or risk controls. It only changes *who resolves to live mode and when*. It is a
targeted rewire of the mode-derivation, plus the client UI that keys off it.

## 2. Current architecture (the four gate sites)

Live-ness is decided in four places, all keyed on admin-role:

| # | Site | Current logic |
|---|------|---------------|
| A | Client — [`AuthContext.tsx:198`](../src/contexts/AuthContext.tsx) | `liveMode = isAdmin && (adminActiveMode === "live_comp" \|\| "live_charge")` |
| B | Full-label server — [`payments/index.ts:226`](../supabase/functions/payments/index.ts) | `isLive = clientWantsLive && callerRole === "admin" && callerAdminMode === "live_charge"` + `PAYMENTS_ALLOWED_USERS` allowlist (line ~230, empty = closed) |
| C | Flex/off-session server — [`labels/index.ts:121`](../supabase/functions/labels/index.ts) | `isLive = live_mode === true`, cross-checked against the link's `is_test` (line ~235; `linkIsLive !== isLive` ⇒ reject) |
| D | Link creation — [`links/index.ts:495`](../supabase/functions/links/index.ts) | `sendmo_links.is_test` **defaults to TRUE** (column default) |

**Two load-bearing facts:**
- The backend already holds **both** keysets and switches on `isLive` — `EASYPOST_API_KEY`
  vs `EASYPOST_TEST_API_KEY`, live vs test Stripe secret, `stripe_customer_id_live` vs
  `_test`. **Live keys are already configured** (you've done live charges). No key setup
  is part of this work.
- The client **also** needs the live/test signal — it picks the Stripe *publishable* key
  via `getStripeForMode(liveMode)` ([`StripePaymentForm.tsx:102`](../src/components/recipient/StripePaymentForm.tsx)).
  So Elements must mount with the matching live-vs-test key, client-side. Client and server
  must agree on mode or the charge fails.
- **There is no `APP_ENV`/`SENDMO_ENV` signal in the codebase today** (grep-confirmed).
  Establishing one is the foundational sub-task, and it is reused by the key-mismatch
  guard (PRE-LAUNCH T2-4).

## 3. Proposed design — environment-driven live mode

**Principle:** live-vs-test should be decided by **which environment the deploy is**, not by
who the user is. Production = live keys = customers charged live. Admins keep an explicit
toolbar to force test/comp for their own dogfooding. Rule 14 preserved throughout (the
*server* is the source of truth; the client value is only a hint the server honors for
admins, and a key-selection signal client-side).

### 3.1 The production signal (foundational)

Introduce one environment signal, set only on the production deploy:

- **Server:** `SENDMO_LIVE_DEFAULT=true` — a Supabase function secret. Present ⇒ non-admin
  customers resolve to **live**. Absent (local/dev/preview) ⇒ non-admin ⇒ **test**.
- **Client:** `VITE_SENDMO_LIVE_DEFAULT=true` — a Vercel prod env var (Vite exposes
  `VITE_*` to the bundle). Drives client-side Stripe publishable-key selection so it
  matches the server.

The two must agree per environment. A mismatch fails safe (mode-mismatch reject in gate C,
or the key-guard in T2-4). This same server var is the T2-4 key-guard trigger.

**`SENDMO_LIVE_DEFAULT` is also the kill switch.** Set it to `false` and every non-admin
instantly routes back to test mode — a one-flip halt if something goes wrong post-launch,
no deploy required (Supabase secrets take effect on next function invocation).

### 3.2 Server derivation (gates B, C, D)

Replace the admin-only derivation with a role-branch:

```ts
// Shared helper — propose _shared/mode.ts:resolveLiveMode({ callerRole, callerAdminMode })
// so B and C derive identically (Rule 6 — one definition, two call sites).
const liveDefault = Deno.env.get("SENDMO_LIVE_DEFAULT") === "true";
if (callerRole === "admin") {
  isLive = callerAdminMode === "live_charge";     // admin keeps explicit control
  isComp = callerAdminMode === "live_comp";
} else {
  isLive = liveDefault;                            // real customer: environment decides
  isComp = false;                                  // comp stays admin-only
}
```

- **Gate B (`payments`)** — full-label PI creation uses `resolveLiveMode`. The existing
  `checkAccountBudget` ordering and H2 save-card logic are unchanged; only the `isLive`
  source changes.
- **Gate C (`labels`)** — flex/off-session uses the same helper. The `linkIsLive !== isLive`
  mode-mismatch defense stays and now *passes* naturally once links are created live (D).
- **Gate D (`links`)** — `sendmo_links.is_test` at creation must be derived the same way:
  admin → follows their mode; customer in prod → `is_test = false`. Trace the insert path
  in `links/index.ts` and set `is_test` from `resolveLiveMode`, not the TRUE default.

### 3.3 Client derivation (gate A) + admin-badge leak

```ts
// AuthContext.tsx ~198
const envLiveDefault = import.meta.env.VITE_SENDMO_LIVE_DEFAULT === "true";
const liveMode = isAdmin
  ? (adminActiveMode === "live_comp" || adminActiveMode === "live_charge")
  : envLiveDefault;                                // customers → live in prod
```

**Also fix the admin-badge leak:** the payment form renders an amber "TEST" / red "LIVE"
badge keyed on `liveMode` ([`StripePaymentForm.tsx:191`](../src/components/recipient/StripePaymentForm.tsx)).
Those are *admin dogfood* affordances — a real customer must never see a red "LIVE" badge.
Gate the badge render on `isAdmin`, not on `liveMode`. (Customers just see a normal
checkout; the price is already shown.)

### 3.4 The soft-launch ramp

`PAYMENTS_ALLOWED_USERS` currently gates *admin* live charges. For customers the useful
ramp is a **closed-beta lever**, not a per-identity allowlist (customers are new/unknown):

- Keep a gate: when `PAYMENTS_LIVE_ALLOWLIST_ONLY=true`, non-admin live charges are
  restricted to allowlisted authenticated UIDs (invite-only beta). When `false` (default
  post-launch), any customer can pay live.
- Full-label payers are authenticated by payment time (OTP account creation happens before
  the pay step — the account-creation-timing decision), so they have a UID to allowlist.
- Exposure is *also* bounded by the existing risk controls that already ship: Account
  Budget, per-shipment cap, velocity limits, Stripe Radar. The ramp is belt-and-suspenders
  over those.

See **OQ2** for whether you want the closed-beta lever at all or just flip the kill switch
and rely on narrow URL sharing + risk controls.

## 4. Safety model

- **Rule 14 preserved** — server re-derives mode; never trusts the client for the money
  decision. Client `live_mode` becomes a hint honored only for admins + a client-side
  key-selection signal.
- **Fail-safe default** — absent the env signal (any non-prod deploy), everyone is test.
  You cannot accidentally charge real money from a preview/local build.
- **Kill switch** — `SENDMO_LIVE_DEFAULT=false` halts all customer live charges instantly.
- **Key-mismatch guard (T2-4)** — lands alongside this: if the prod signal is set but a
  test key is present (or vice-versa), the money-path functions refuse to run.
- **No schema change, no data migration** — existing live + test rows already carry
  `is_test`/`mode`; this only changes how *new* transactions derive mode.

## 5. Rollout plan

1. Land the code behind the env signal **unset** (prod still admin-only — zero behavior
   change on merge). Ship T2-4 key-guard in the same window.
2. Set `PAYMENTS_LIVE_ALLOWLIST_ONLY=true` + a small allowlist (you + 2–3 friendlies).
3. Set `SENDMO_LIVE_DEFAULT=true` (server) + `VITE_SENDMO_LIVE_DEFAULT=true` (Vercel) →
   redeploy. Now allowlisted non-admins can pay live.
4. Run the T2-2 live smoke tests as a *non-admin* account: full-label buy, flex link
   create→sender-complete, cancel→refund→emails. Watch `event_logs` + reconciliation.
5. Flip `PAYMENTS_LIVE_ALLOWLIST_ONLY=false` → open to all. Write the launch-crossed
   `LOG.md` entry.

## 6. Test / verification plan

- **Unit:** `_shared/mode.ts:resolveLiveMode` — admin×{test,live_comp,live_charge},
  customer×{prod,non-prod}, comp-stays-admin-only. Pure function, fully unit-coverable.
- **E2e:** a non-admin mocked run through full-label pay asserting the client mounts the
  live Stripe key and posts without a `role:admin` requirement; a flex link created with
  `is_test=false`.
- **Manual (John, live):** the §5 step-4 smoke tests.
- **Regression guard:** an admin can still force test + live_comp (toolbar unaffected); a
  preview/local build still routes everyone to test even with prod keys mistakenly present
  (key-guard catches the latter).

## 7. Scope boundary — what this does NOT touch

Pricing, rate logic, the buy-time rate gate, the `transactions` ledger, refunds,
carrier-adjustment recovery, risk controls, email copy, the comp path (stays admin-only).
If a change to any of those seems required, stop — it belongs in a different proposal.

## 8. Open questions (for review)

- **OQ1 — Signal name + shape.** `SENDMO_LIVE_DEFAULT` (boolean, recommended) vs a broader
  `SENDMO_ENV=production|staging|dev` that other code can key off later. Broader is more
  reusable but invites scope creep. Recommend the boolean now; widen later if a real second
  consumer appears.
- **OQ2 — Do you want the closed-beta lever (`PAYMENTS_LIVE_ALLOWLIST_ONLY`) at all,** or
  just flip the kill switch straight to open and rely on narrow URL sharing + the existing
  risk controls to bound the first days? The lever is ~15 LOC of insurance; skipping it is
  simpler but gives a blunter launch.
- **OQ3 — Anonymous full-label payers.** Full-label OTPs the payer before payment, so they
  have a UID. Should we *require* auth for any live charge (belt), or keep the defensive
  anonymous fall-through that exists today? Recommend requiring auth for live (you already
  do in practice).
- **OQ4 — Staging.** [`STAGING_PLAN.md`](../STAGING_PLAN.md) envisioned a separate staging
  Supabase project. This proposal makes prod-vs-nonprod a single env flag on one project
  instead. Is that sufficient for launch (recommend yes — one project, env-gated), with a
  real staging project as a post-launch nicety?

## 9. Risks

| Risk | Mitigation |
|------|------------|
| Client/server env vars disagree ⇒ charge fails or wrong key | Mode-mismatch reject (gate C) + key-guard (T2-4) both catch it; document the paired-var requirement in PLAYBOOK env section |
| A customer sees an admin "LIVE" badge | §3.3 gates badges on `isAdmin` |
| Flex links still created test after flip | Gate D explicitly re-derives `is_test`; e2e asserts `is_test=false` |
| Something's wrong post-open | Kill switch (`SENDMO_LIVE_DEFAULT=false`) + allowlist-only re-clamp, both no-deploy |
| Regression to admin dogfood | Admin branch unchanged; regression test asserts toolbar still forces test/comp |

---

*Author's recommendation: approve the environment-signal design (§3), ship the code
inert (§5 step 1) bundled with the T2-4 key-guard, then ramp per §5. Answer OQ1–OQ4 to
finalize. This is the launch switch — once decided and verified, the next artifact is the
"live mode opened to customers" `LOG.md` entry.*

---

## Review

```yaml
reviewer: Claude (Fable 5) — fresh-eyes pre-launch session, 2026-07-04
reviewed_at: 2026-07-04
verdict: approve-with-changes
```

### Summary

The direction is right and should be kept: environment-driven mode, Rule 14 preserved,
fail-safe default, ship-inert-then-ramp, kill switch. Every file/line reference in
sections 1–3 checks out against the code. But the **gate map is incomplete** — I verified
each site against the code and prod DB, and the flex path as proposed would break for
real customers in a way that only surfaces after the flip. There are five gate sites,
not four (plus `rates`), the flex gate needs a *different* derivation source than the
proposed helper, and the kill-switch semantics have a hole once live links exist. None
of this invalidates the design; it changes the file list and two derivation rules.

**One hard fact that reframes gate C:** the prod DB has **zero `is_test=false` links,
ever** (query run 2026-07-04: `all_live_links = 0`). The sender client hardcodes
`live_mode: false` ([`SenderFlow.tsx:163`](../src/pages/SenderFlow.tsx) passes literal
`false` to `buyLabel`; `fetchSenderRates` omits the param, defaulting `false` in
[`api.ts`](../src/lib/api.ts)). So the live flex sender path has **never executed** — not
just "never for a non-admin." The mode-mismatch defense at `labels/index.ts:236` would
have rejected any sender completing a live link. Gate C isn't being *opened* by this
proposal; it's being *built for the first time*, and it should be scoped and tested
accordingly.

### Blocking issues

**B1 — `payment-methods/index.ts` is a fifth gate site; without it the customer flex
path is dead on arrival.**
- *Location:* [`payment-methods/index.ts:25-26, 64-70`](../supabase/functions/payment-methods/index.ts)
  — `liveMode = role === "admin" && adminActiveMode ∈ {live_comp, live_charge}`, its own
  role-driven derivation, independent of the four sites listed in §2.
- *Issue:* the flex onboarding saves the recipient's card through this function
  (SetupIntent via `FlexPaymentStep`), and the dashboard `AddCardModal` uses it too. A
  customer under this proposal gets a **live** link (gate D) but their card is saved
  **mode='test'** against the test Stripe account. Consequences chain: `links` GET
  `is_funded` looks for a `mode='live'` default PM ([`links/index.ts:402-411`](../supabase/functions/links/index.ts))
  → always false → link shows "isn't accepting payments"; if a buy is attempted anyway,
  the off-session PM lookup finds nothing → 402. The whole flex product breaks for
  customers, silently, only after the flip.
- *Suggested fix:* `payment-methods` adopts `resolveLiveMode` exactly like gate B. Add it
  to §2's table as gate E and to the §6 test plan (customer SetupIntent lands
  `mode='live'` in prod).

**B2 — Gate C must derive live-ness from the link, not from `resolveLiveMode(caller)`.**
- *Location:* §3.2 sketch applied to [`labels/index.ts:121`](../supabase/functions/labels/index.ts);
  [`SenderFlow.tsx:163`](../src/pages/SenderFlow.tsx).
- *Issue:* the flex sender is **anonymous** — there is no `callerRole` to branch on.
  Under the proposed helper, every sender in prod resolves `liveDefault = true`,
  including a sender completing an **admin's test link** → permanent `Link mode mismatch`
  reject → admin flex dogfood breaks. Meanwhile the sender client hardcodes
  `live_mode: false` today, so without a client change nothing works in the other
  direction either. The link already *is* the server-side source of truth
  (`labels/index.ts:228-236` says exactly this).
- *Suggested fix:* when `link_short_code` is present, `labels` sets
  `isLive = !link.is_test` and **ignores** client `live_mode`; `rates` does the same
  (it already receives `link_short_code` from `fetchSenderRates` but doesn't use it for
  mode). `SenderFlow` stops sending `live_mode`. The mismatch-reject becomes obsolete on
  this path — see B4 for what replaces it. Full-label buys through `labels` keep the
  caller-derived value (they carry a JWT + a PI that must verify in the same mode, which
  self-corrects lies).

**B3 — Gate D is deeper than the insert: the `initial_status: "auto"` path hardcodes a
test-mode PM lookup.**
- *Location:* [`links/index.ts:493-514`](../supabase/functions/links/index.ts) — comment
  literally says "the link is created with is_test=TRUE (column default), so we look up
  the user's default PM in **test** mode."
- *Issue:* post-flip, a customer with a saved live card using dashboard "+ New Link"
  gets classified `draft` (no test PM found) instead of `active` — link invisible to
  senders, another silent flex breakage.
- *Suggested fix:* derive both the `is_test` insert value AND the auto-status PM-lookup
  mode from the same `resolveLiveMode` result. Add an e2e/unit assertion for the auto
  path in §6.

**B4 — The kill switch doesn't cover the flex path once live links exist.**
- *Issue:* `SENDMO_LIVE_DEFAULT=false` re-clamps caller-derived gates (A/B). But a flex
  link already created `is_test=false` keeps driving **live off-session charges** under
  the link-derived model (B2) — the kill switch never consults it. §4's "halts all
  customer live charges instantly" is not true for the product's marquee path.
- *Suggested fix:* in `labels`, before any live off-session charge (and any live
  full-label buy), check the kill switch: if unset/false and the transaction would be
  live and the caller isn't an allowlisted admin, return a clean
  "payments are temporarily paused" error + `event_logs` row. Document this as the
  defined kill-switch semantics in §4.

**B5 — Reusing `SENDMO_LIVE_DEFAULT` as both the environment signal and the kill switch
disarms the T2-4 key guard exactly when you need it.**
- *Issue:* T2-4's `assertKeysMatchEnv` triggers "when the T1-1 production signal is set."
  If that signal *is* the kill switch, then flipping it `false` mid-incident silently
  disables the key-mismatch guard (and any future "am I prod" consumer) during the
  highest-chaos window — the moment misconfiguration is most likely.
- *Suggested fix (this is my OQ1 answer — see below):* two vars.
  `SENDMO_ENV=production` = environment identity, set once, never flipped; T2-4 keys off
  it. `SENDMO_LIVE_DEFAULT=true|false` = the customer-live gate / kill switch. Costs one
  extra secret; removes the coupling.

### Non-blocking concerns

**N1 — The badge leak is in three components, not one.** §3.3 fixes
`StripePaymentForm.tsx:189-216` but the same `liveMode`-keyed badge + test-card copy is
in [`FlexPaymentStep.tsx:436-438, 519`](../src/components/flex/FlexPaymentStep.tsx) and
[`AddCardModal.tsx:95-100, 136`](../src/components/dashboard/AddCardModal.tsx). Note
also: **today** a real customer sees an amber "Test Mode" badge and "use card 4242…"
copy at checkout — the leak is already customer-visible pre-flip. Gate all three on
`isAdmin`.

**N2 — `rates/index.ts:191` trusts client `live_mode` wholesale** to choose the live
EasyPost key — anyone can curl `live_mode: true` today and burn live rate-shop quota.
Existing exposure, not introduced here, and PRE-LAUNCH T2-3 (rate limiting) bounds the
volume — but since this proposal touches mode derivation everywhere, align `rates` too:
link-derived when `link_short_code` present (B2), client-hint otherwise (quote-only; the
buy-side gates protect the money).

**N3 — "No data migration" needs one explicit decision.** Prod today (queried
2026-07-04): 5 non-admin profiles, **2 non-admin active/draft test flex links**, 0
non-admin saved PMs, 0 live links. Post-flip those 2 links stay `is_test=true` forever —
under link-derived mode a real sender completing one gets a **fake label that looks
real**. Neither owner has a saved PM (links are unfunded/draft-equivalent), so the cheap
clean answer is: expire them at flip time + email the owners to recreate. Small, but
decide it in the proposal rather than discover it.

**N4 — Name the client/server policy duplication.** `_shared/mode.ts` is Deno-only; the
client can't import it (Vite/`import.meta.env`). Gate A in `AuthContext` is a second,
hand-synced copy of the policy. That's acceptable — but say so, add a mirrored unit test
on each side asserting the same truth table, and document the paired env vars in
PLAYBOOK's environment section (the §9 risk table already promises this).

**N5 — Two allowlist mechanisms will coexist; define the interplay.**
`PAYMENTS_ALLOWED_USERS` (admin live charges, empty=closed) stays, and §3.4 adds
`PAYMENTS_LIVE_ALLOWLIST_ONLY` for customers. Two env vars, two semantics ("empty means
closed" vs "flag plus list"). Spell out the post-launch end state — likely: keep the
admin one as-is, customer lever reuses the *same* UID list var with the new boolean, or
merge into one var with documented semantics.

**N6 — Verified: anonymous live full-label charges are real under this design, and they
skip the Account Budget.** `payments/index.ts:188-192` permits anonymous PIs by design,
and `checkAccountBudget` runs only `if (resolvedUserId …)` (line 267) — an anonymous
live payer would have Stripe Radar as the *only* velocity control. This upgrades OQ3
from preference to risk decision — see recommendation below.

### Nits

- §2 table: gate C cites `labels/index.ts:121` for `isLive` — worth also citing that the
  full-label leg of `labels` verifies the PI *in the claimed mode* (line ~759), which is
  the actual defense on that leg.
- §3.2 sketch sets `isComp` inside the helper; comp authorization in `labels` also
  requires the admin-JWT-or-active-flex-link gate (line ~361-364). Keep comp *authz* out
  of `resolveLiveMode` — mode and permission are different questions.
- §5 rollout: add "run a security review of the diff between step 1 (inert land) and
  step 3 (flip)" — this is the one change on the list that earns it.
- Filename should gain `_reviewed-2026-07-04` per protocol (done with this review).

### Predicted pitfalls (required)

1. **Silent flex-funding breakage post-flip (B1/B3 class).** Everything ships inert and
   green; on flip day a customer's link shows "isn't accepting payments" with no error
   anywhere but a missing `mode='live'` PM row. This is the exact "system claims
   success, user reports failure" shape PLAYBOOK Rule 20 exists for — if B1/B3 land,
   pre-write the telemetry query (PM mode × link mode join) into the §6 verification so
   flip-day triage is a SELECT, not an investigation.
2. **De-roled admin charges their real card.** The 2026-06-27 incident showed
   `profiles.role` can silently revert to `'user'` (profile row recreated after the
   migration-016 bootstrap). Today a de-roled admin falls to test mode — annoying but
   safe. Post-flip, the same failure routes them to **live**: they think they're
   dogfooding in test mode (toolbar gone is the only cue) and their personal card gets
   charged for real. Mitigation: the N1 badge fix helps (no badge = you're a customer);
   consider an `event_logs` warn when a previously-admin UID transacts as customer.
3. **Vercel preview deploys inherit `VITE_SENDMO_LIVE_DEFAULT=true`.** Vercel env vars
   apply to Production/Preview/Development scopes; if the var is added without scoping,
   every preview build mounts the **live** publishable key and sends `live_mode: true`
   hints. Server-side derivation limits the damage (previews hit the same prod
   functions, which resolve customers → live anyway — that's *by design* but means
   preview URLs are real-money surfaces). Set the var **Production-scope only** and say
   so in §5 step 3.
4. **Kill-switch flip mid-incident disarms the key guard (B5).** Sequence: incident →
   flip `SENDMO_LIVE_DEFAULT=false` → separately rotate a Stripe secret and fat-finger
   the test key into prod → T2-4 guard is dormant (signal off) → un-flip the switch a day
   later → customers now silently transact against the test key: fake labels, no money,
   no error. Two-var split (B5) removes the sequence entirely.

### What the proposal got right

- **Environment-driven, not role-driven, is the correct inversion** — and keeping the
  admin toolbar as an explicit override preserves the dogfood loop.
- **Ship-inert → allowlist ramp → open** is the right rollout shape for a never-executed
  code path, and the kill-switch instinct is correct (it just needs B4/B5 sharpening).
- Every file/line citation in §1–3 verified accurate against HEAD (`payments:226`,
  `AuthContext:198`, `labels:121/235`, `links:495`, `StripePaymentForm:102/191`).
- The client-also-needs-the-signal insight (§2, publishable-key selection) is real and
  frequently missed — server-only fixes would strand Elements on the wrong key.
- Catching the badge leak at all (§3.3) — most passes would have shipped a red LIVE
  badge to customers.
- §7's scope discipline ("if pricing/ledger/refunds seem required, stop") is exactly
  right for a money-path change.

### Recommended answers to OQ1–OQ4 (for John, one pass)

- **OQ1 — two vars, not one.** `SENDMO_ENV=production` (identity; set once; T2-4 keys
  off it) + `SENDMO_LIVE_DEFAULT` (customer-live gate / kill switch). One extra secret;
  removes the B5 coupling. If you strongly prefer a single var, the boolean is
  acceptable **only if** T2-4 triggers on live-key-presence rather than on the flag.
- **OQ2 — yes, keep the closed-beta lever.** ~15 LOC, and this review just added three
  gate sites to the scope — a controlled ramp is how the ones *we all* still missed get
  found by 3 friendlies instead of 30 strangers.
- **OQ3 — yes, require auth for live charges.** Verified: anonymous live payers would
  bypass the Account Budget entirely (N6). The UI already OTPs everyone before payment,
  so this closes a public-API-only hole at zero UX cost.
- **OQ4 — yes, single project + env flag is sufficient for launch.** The T2-4 guard is
  the compensating control; a real staging project is a post-launch nicety. (With the
  OQ1 two-var split, a staging project later just sets `SENDMO_ENV=staging` — the design
  extends cleanly.)

---

## Author response

> **Process note (recorded for honesty):** John directed the reviewer session to also
> write the author response after he accepted the review's recommendations wholesale —
> the normal two-session back-and-forth is collapsed by the tie-breaker having already
> decided. Every acceptance below carries the implementation choice it commits to, so
> the executing agents have an unambiguous spec.

**B1 (payment-methods is a fifth gate) — ✅ accept.** `payment-methods/index.ts` adopts
`resolveLiveMode` exactly like gate B. The §2 table is now read as six sites: A client,
B `payments`, C `labels`, D `links`, E `payment-methods`, F `rates` (F quote-only).
Test plan gains: customer SetupIntent in prod-signal mode lands `mode='live'`.

**B2 (gate C derives from the link, not the caller) — ✅ accept.** When
`link_short_code` is present, `labels` and `rates` set `isLive = !link.is_test`
server-side and ignore the client `live_mode` field; `SenderFlow` stops sending it.
The `linkIsLive !== isLive` mismatch-reject is retired on that path (superseded by
link-derived mode); the full-label leg keeps caller-derived mode + the existing
PI-verified-in-claimed-mode defense.

**B3 (links "auto" hardcodes test PM lookup) — ✅ accept.** The `is_test` insert value
and the `initial_status:"auto"` PM-lookup mode both derive from the same
`resolveLiveMode` result.

**B4 (kill switch must cover link-driven charges) — ✅ accept.** Defined semantics:
before any **live** charge (off-session flex or full-label PI verification), `labels`
checks `SENDMO_LIVE_DEFAULT`; if it is not `"true"` and the caller is not an admin in
`live_charge`, return a clean 503 "payments are temporarily paused" + an
`event_logs` row (`payment.live_paused_by_kill_switch`). Admin dogfood is exempt so
John can verify a fix while paused.

**B5 (split identity from kill switch) — ✅ accept.** Two server vars:
`SENDMO_ENV=production` (identity, set once; T2-4 keys off it) and
`SENDMO_LIVE_DEFAULT` (customer-live gate / kill switch). Client keeps the single
`VITE_SENDMO_LIVE_DEFAULT` (it only selects the publishable key).

**N1 (badge leak ×3) — ✅ accept.** Badge + test-card copy gate on `isAdmin` in
`StripePaymentForm`, `FlexPaymentStep`, and `AddCardModal`.

**N2 (rates trusts client) — ✅ accept** as scoped in B2: link-derived when
`link_short_code` present; client-hint otherwise (quote-only; buy-side gates protect
money). T2-3 rate limiting (shipped 2026-07-04) bounds the quota-burn volume.

**N3 (2 stranded non-admin test links) — ✅ accept.** Flip-day runbook item, not code:
expire both links + email the owners to recreate. Recorded in §5 rollout below.

**N4 (client/server policy duplication) — ✅ accept.** `_shared/mode.ts` is server-only;
`AuthContext` carries the mirrored policy with a **mirrored truth-table unit test on
each side** asserting identical outcomes. Paired env vars documented in PLAYBOOK's
environment section.

**N5 (two allowlist mechanisms) — ✅ accept, reuse-the-list variant.**
`PAYMENTS_ALLOWED_USERS` remains the single UID list. Existing semantics unchanged for
admin live charges (empty = closed). New boolean `PAYMENTS_LIVE_ALLOWLIST_ONLY`: when
`true`, non-admin live charges also require membership in that same list; when
`false`/unset, any authenticated customer may charge live (subject to the kill switch).

**N6 / OQ3 (anonymous live) — ✅ accept.** `resolveLiveMode` returns test for
anonymous callers unconditionally — an unauthenticated API caller can never resolve
live. Zero UX cost (the UI OTPs everyone before payment) and guarantees Account Budget
coverage on every live charge.

**Nits — all accepted** (comp authz stays out of `resolveLiveMode`; security review
scheduled between inert-land and flip; filename convention followed).

## Decision

**Decided 2026-07-04 by John: approve-with-changes accepted in full — implementation
begins immediately, shipping inert.**

- **OQ1:** two server signals — `SENDMO_ENV` (identity, powers T2-4) +
  `SENDMO_LIVE_DEFAULT` (kill switch). Client: `VITE_SENDMO_LIVE_DEFAULT`.
- **OQ2:** keep the closed-beta lever (`PAYMENTS_LIVE_ALLOWLIST_ONLY`, reusing the
  `PAYMENTS_ALLOWED_USERS` list per N5).
- **OQ3:** auth required for any live charge; anonymous always resolves test.
- **OQ4:** single Supabase project, env-gated; staging project is post-launch.
- T1-2 (Supabase Pro) completed by John 2026-07-04. Admin-alert fallback to John's
  Gmail is the *intended* configuration (not a gap).
- Rollout stays §5 as written, plus: **N3 runbook item** (expire the 2 non-admin test
  flex links + owner emails) and a **security review of the full diff between §5
  step 1 (inert land) and step 3 (flip)**.
