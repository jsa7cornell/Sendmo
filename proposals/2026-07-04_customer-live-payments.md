---
title: Open the live-payment path to real customers (decouple live-mode from admin-role)
slug: customer-live-payments
project: sendmo
status: in-review
created: 2026-07-04
last_updated: 2026-07-04
reviewed:
decided:
author: Claude (Opus 4.8) — pre-launch readiness review, 2026-07-04; found the admin-only payment gate while mapping what stands between dogfood and launch
reviewer:
outcome:
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
