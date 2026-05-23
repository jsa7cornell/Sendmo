---
title: Edge function import resilience — JSR migration to eliminate CDN single-point-of-failure on deploy
slug: edge-function-import-resilience
project: sendmo
status: blocked
blocked_on: "OQ1 decided by John 2026-05-23 = defer to post-launch focus window. Tracked on WISHLIST.md under 'Test / CI debt'."
created: 2026-05-23
last_updated: 2026-05-23
reviewed: null
decided: 2026-05-23
author: Claude Opus 4.7 — drafted after the 22:05 UTC esm.sh 522 failed a deploy mid-H1-H5-launch-push
reviewer: null
outcome: deferred-to-wishlist
---

> **2026-05-23 — Status: deferred to WISHLIST.** John exercised OQ1 = defer to post-launch. The proposal is preserved here as the load-bearing artifact (full scope inventory, JSR/`Deno.serve` migration plan, `import type` Vitest contract, OQ2–OQ5). When the work is picked up post-launch, flip `status: in-review` and route through normal review. WISHLIST entry: see "Test / CI debt" section of [WISHLIST.md](../WISHLIST.md).


## 1. Context

### 1.1 The incident

Edge function deploy at **2026-05-23 22:05 UTC** failed with:

```
Import 'https://esm.sh/@supabase/supabase-js@2.39.3' failed: 522 <unknown status code>
```

`522` is Cloudflare's "origin connection timed out" — esm.sh's upstream was unreachable. A simple re-run of the workflow succeeded. **No code was broken; CI just rolled snake-eyes on a remote CDN.**

### 1.2 Why this suddenly became a priority — the honest version

> John asked for this section explicitly. The honest answer is *partly* the incident, *mostly* the timing, and a real counter-argument that the priority might be wrong.

**What changed today is not the fragility — it's the consequences of the fragility.**

The dependency on `https://esm.sh/...` has been there since the first edge function shipped. We have deployed through esm.sh hundreds of times with no issue. Today's 522 is statistically expected if you depend on a third-party CDN long enough. In a normal week, this is a "shrug, re-run, move on" event — exactly what happened.

What's different about *this week*:

1. **Deploy cadence is at an all-time high.** Three H1-H5 launch artifacts landed or moved in the last 48 hours: [recon + carrier adjustments decided 2026-05-22](2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_decided-2026-05-22.md), [buy-time-rate-gate](2026-05-23_buy-time-rate-gate.md) in review today, [pre-launch handoff plan](2026-05-23_pre-launch-handoff-plan.md) iterating. The H1-H5 implementation work is producing multiple edge-function deploys per day, and that pace will hold for ~1 week until launch.

2. **Each deploy is an independent dice roll against esm.sh.** Today: one 522. At ~5×/day cadence with esm.sh availability conservatively at 99.5%, the expected number of failed deploys before launch is single-digits but non-zero — and we're now in the part of the project where one of those failures could land on a payment-critical hotfix.

3. **Post-launch failure semantics are different.** Pre-launch: failed deploy → retry → no customer impact. Post-launch on a Stripe-webhook regression: failed deploy → minutes of broken charge handling → customer impact + reconciliation tail. The same fragility class, much worse blast radius.

4. **The fix is one-shot and mostly mechanical.** A few hours to permanently delete the fragility class, vs. carrying it through launch and beyond.

**The counter-argument — and it's a real one:**

- The fragility has existed for months; nothing about today changes the *probability*, only my *attention* to it. Availability bias.
- We are explicitly in the "don't touch H1-H5 surfaces lightly" window — this proposal touches all of them.
- The proposal-review + implementation + integration-test re-run for this is plausibly half a day. That's half a day not spent on [buy-time-rate-gate](2026-05-23_buy-time-rate-gate.md) (correctness fix worth $9.62/leak) or the recon implementation (the actual launch blocker).
- An equally defensible answer is *"land this the week after launch"* — by then deploy cadence drops, every minute of focus matters less, and we'd verify in a calmer window.

**My recommendation despite the counter-argument:** do it now, but only after this proposal is reviewed and decided. The migration is purely mechanical (no behavior change), the deploy strategy is atomic (one `_shared/` change triggers full redeploy — no half-state risk), and the cost of carrying the fragility through launch is asymmetric (cheap if nothing fails, expensive if a 522 lands on a charge-handling hotfix). But this is a judgment call, and I'm flagging it as **OQ1** for your decision — not pre-deciding it.

### 1.3 What's actually fragile — full scope (broader than the original brief)

The brief named esm.sh. The actual scope is broader. Audited via `grep -rE 'from\s+["'\'']https?://' supabase/functions/` (32 files):

| Registry | Package | Files | Risk |
|---|---|---|---|
| `https://esm.sh/` | `@supabase/supabase-js@2.39.3` | 21 (incl. type-only in 4 `_shared/`) | **Today's incident** |
| `https://esm.sh/` | `@supabase/supabase-js@2.43.0` | 1 ([_shared/refunds.ts:19](../supabase/functions/_shared/refunds.ts:19)) | Drift |
| `https://esm.sh/` | `@supabase/supabase-js@2` (unpinned) | 1 ([ingest/index.ts:17](../supabase/functions/ingest/index.ts:17)) | Drift + unpinned |
| `https://esm.sh/` | `libphonenumber-js@1.13.2` | 1 ([_shared/phone.ts:1](../supabase/functions/_shared/phone.ts:1)) | Same CDN |
| `https://deno.land/std@0.168.0/` | `http/server.ts` (`serve`) | ~22 (every function) | **Same CDN-outage class — deno.land has also gone down historically** |

**Fixing only esm.sh and ignoring deno.land/std would patch half the problem.** The Cloudflare 522 class hits any HTTP-imported dep, not specifically `esm.sh`. If we go through the migration cost, we should fix both registries in one pass.

`_shared/stripe.ts` is **not** affected — it's a hand-rolled raw-fetch client against `api.stripe.com/v1` ([commented intent at line 3-4](../supabase/functions/_shared/stripe.ts:3)). No package dependency. No change needed there.

### 1.4 Three-way version drift

The supabase-js version situation today, all stable but inconsistent:

| Surface | Version |
|---|---|
| Most edge functions | `@2.39.3` (esm.sh) |
| `_shared/refunds.ts` (type only) | `@2.43.0` (esm.sh) |
| `ingest/index.ts` | `@2` (esm.sh, unpinned) |
| `package.json` (Vitest tests + frontend) | `@^2.97.0` (npm) |

Nothing's broken — the `SupabaseClient` type surface and `createClient` signature have been stable across all of these. But it's debt we should pay during the migration since we're touching every import line anyway. **OQ3** asks whether to unify in the same PR.

### 1.5 Why this belongs in proposals (per PLAYBOOK and PROPOSAL-REVIEW-PROTOCOL)

This proposal touches every H1-H5 edge function ([labels](../supabase/functions/labels/index.ts), [stripe-webhook](../supabase/functions/stripe-webhook/index.ts), [payments](../supabase/functions/payments/index.ts), [refunds](../supabase/functions/refunds/index.ts), [_shared/ledger.ts](../supabase/functions/_shared/ledger.ts), [_shared/refunds.ts](../supabase/functions/_shared/refunds.ts), [_shared/budget.ts](../supabase/functions/_shared/budget.ts), [_shared/adjustments.ts](../supabase/functions/_shared/adjustments.ts), [webhooks/index.ts](../supabase/functions/webhooks/index.ts)). H1-H5 surfaces explicitly fall under the proposal-review gate per the [pre-launch handoff plan](2026-05-23_pre-launch-handoff-plan.md). Even "mechanical infra" qualifies if it touches the same files the launch-blocker proposals are amending.

## 2. Architecture

### 2.1 Target import shape

For each registry, the target replacement is the **Supabase-recommended path as of 2026** ([Supabase docs](https://supabase.com/docs/guides/functions/dependencies)) — Deno's native JSR registry plus `npm:` specifiers where JSR doesn't carry the package:

| Today | Target | Reason |
|---|---|---|
| `https://esm.sh/@supabase/supabase-js@2.39.3` | `jsr:@supabase/supabase-js@^2.43.0` (or pinned exact) | JSR is Deno's first-party registry; no CDN dep; Supabase publishes to it |
| `https://deno.land/std@0.168.0/http/server.ts` | `jsr:@std/http@^1/server` | Deno std lib was moved to JSR; the `deno.land/std` URLs are now soft-deprecated |
| `https://esm.sh/libphonenumber-js@1.13.2` | `npm:libphonenumber-js@1.13.2` | Not published to JSR; Deno supports `npm:` natively |

### 2.2 Replace `serve` with `Deno.serve` (preferred Deno-native, no `@std/http` needed)

Simpler than swapping the `serve` import to JSR: **delete the import line entirely** and replace `serve((req) => …)` call sites with `Deno.serve((req) => …)`. Deno has shipped `Deno.serve` as the recommended entry point since Deno 1.35 (Supabase Edge Runtime is on a much newer version). One fewer dep, one fewer place a CDN can fail.

This is what new Supabase function templates have used since late 2025. Adopting it eliminates the deno.land/std fragility class entirely, not just moves it.

### 2.3 Where the import-map lives

Two existing patterns in the repo, both in [supabase/config.toml](../supabase/config.toml:30-44):

- `test-db-insert` and `admin-report` have per-function [deno.json](../supabase/functions/test-db-insert/deno.json) import maps
- All other functions deploy without an explicit import map (Supabase Edge Runtime resolves URLs / JSR specifiers directly)

For this migration, **JSR + npm: specifiers can be inlined in the import statement** without an import map — Supabase Edge Runtime resolves them natively. No `deno.json` files needed unless we want bare-specifier aliasing (we don't, to keep diffs minimal).

### 2.4 Preserving the `import type` Vitest contract — non-negotiable

Five `_shared/` files use **type-only** imports specifically so Vitest's TS transform erases them and the Deno-style URL never resolves at test time:

- [_shared/ledger.ts:36](../supabase/functions/_shared/ledger.ts:36) — comment at lines 27–34 explains why
- [_shared/budget.ts:21](../supabase/functions/_shared/budget.ts:21) — comment at lines 18–20 explains why
- [_shared/refunds.ts:19](../supabase/functions/_shared/refunds.ts:19) — comment at lines 16–18 explains why
- [_shared/adjustments.ts:44](../supabase/functions/_shared/adjustments.ts:44)
- [_shared/actor.ts:18](../supabase/functions/_shared/actor.ts:18)

These are imported directly by Vitest unit tests (`tests/unit/ledger-writes.test.ts`, `tests/unit/budget.test.ts`, `tests/unit/getRefundableBalanceForPI.test.ts`, `tests/unit/adjustments.test.ts`) using `import type { SupabaseClient } from "@supabase/supabase-js"` — the npm package on Vitest side, the URL-imported package on Deno side, same type surface.

**The migration must:**
1. Keep these as `import type` (don't accidentally drop the `type` qualifier when changing the URL).
2. Change the URL to `jsr:@supabase/supabase-js@^2.43.0` so the Deno-side type still resolves at edge runtime.
3. Verify after the change that Vitest can still import the file (the TS transform should erase `import type` regardless of the URL shape).

This is the single most regression-prone part of the migration. Mechanical typo risk: high. Will be triple-checked.

### 2.5 Why JSR over vendoring

The brief offered two options. JSR is the right call for SendMo:

| | JSR | Vendoring (`deno cache --vendor`) |
|---|---|---|
| CDN dependency at deploy | None (deps fetched at first cold start, cached in Supabase's edge runtime layer) | None (deps in git) |
| CDN dependency at first cold start | JSR registry must be up | None |
| Repo footprint | No change | Adds `vendor/` directory — `@supabase/supabase-js` alone ≈ several hundred KB across many files |
| Update workflow | Edit version string, re-deploy | Re-run `deno cache --vendor`, commit large diff, re-deploy |
| Supabase's recommendation | **Yes** (their docs page leads with JSR) | Listed as a fallback, not primary |
| Bus factor / portability | Standard Deno tooling | Custom build step in CI |

**Vendoring trades one CDN dependency (deploy-time) for another (first-cold-start) without fully eliminating the fragility — plus pollutes the repo.** JSR moves us to Deno's first-party registry, which is what Supabase Edge Runtime is optimized for, and is operationally indistinguishable for our use case.

Vendoring would make sense if (a) JSR itself had outage history (it doesn't, materially), or (b) we needed bit-for-bit deploy reproducibility for compliance. Neither applies.

### 2.6 Deploy strategy

The repo's [deploy workflow](../.github/workflows/deploy-edge-functions.yml:74-76) already handles this well: **if any file under `_shared/` changes, redeploys ALL functions.** Since this migration touches every `_shared/` file *and* every function file, it's effectively atomic — one PR merge triggers one full-edge-function deploy. No half-migrated state is possible.

That's also the worst case if something goes wrong: every function fails to boot at once. Mitigated by:
1. Pre-merge: `supabase functions serve` locally for the 4 highest-risk functions (stripe-webhook, labels, payments, refunds) to confirm the new imports resolve.
2. Pre-merge: integration test suite (which hits real edge functions) confirms refund + webhook arms.
3. Post-merge: deploy logs show each function's import resolution within seconds; rollback is `git revert` + re-deploy.

## 3. File-by-file plan

### 3.1 The mechanical pass

For each of the 32 files, the change is one of three patterns:

**Pattern A — value `createClient` import (15 files):**
```diff
-import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
+import { createClient } from "jsr:@supabase/supabase-js@^2.43.0";
```

**Pattern B — type-only `SupabaseClient` import (5 files in `_shared/`):**
```diff
-import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
+import type { SupabaseClient } from "jsr:@supabase/supabase-js@^2.43.0";
```
**Critical: do NOT drop the `type` qualifier.** Verify each.

**Pattern C — combined `createClient + SupabaseClient` value import ([_shared/auth.ts:14](../supabase/functions/_shared/auth.ts:14) only):**
```diff
-import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
+import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@^2.43.0";
```

**Pattern D — `serve` import → `Deno.serve` (every function, ~22 files):**
```diff
-import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
 // …
-serve(async (req) => {
+Deno.serve(async (req) => {
   // unchanged body
 });
```

**Pattern E — libphonenumber ([_shared/phone.ts:1](../supabase/functions/_shared/phone.ts:1) only):**
```diff
-import { isPossiblePhoneNumber } from "https://esm.sh/libphonenumber-js@1.13.2";
+import { isPossiblePhoneNumber } from "npm:libphonenumber-js@1.13.2";
```

### 3.2 Files touched (full list)

Generated from `grep -rl 'from "https://' supabase/functions/`:

**`_shared/` (8 files):** [actor.ts](../supabase/functions/_shared/actor.ts), [adjustments.ts](../supabase/functions/_shared/adjustments.ts), [auth.ts](../supabase/functions/_shared/auth.ts), [budget.ts](../supabase/functions/_shared/budget.ts), [ledger.ts](../supabase/functions/_shared/ledger.ts), [phone.ts](../supabase/functions/_shared/phone.ts), [refunds.ts](../supabase/functions/_shared/refunds.ts), (and any other `_shared/` file with a `serve` import — none today, but verify)

**Functions (~24 files):** addresses, admin-recon-action, admin-report, admin-user-detail, autocomplete, backfill-refund-status, cancel-label, cron-refund-sweep, guestimate, ingest, label-print, labels, links, payment-methods, payments, place-details, rates, reconciliation-report, reconciliation-sweep, refunds, stripe-webhook, test-db-insert, tracking, tracking-admin, webhooks

### 3.3 No file additions or deletions

No new `deno.json`, no `vendor/` dir, no config changes. Pure import-line edits + `serve` → `Deno.serve` rename. **Total diff:** roughly 60–70 lines changed across 32 files, all isomorphic edits.

### 3.4 Version-pin unification (depends on OQ3)

If OQ3 = unify in same PR:
- All supabase-js imports go to `jsr:@supabase/supabase-js@^2.43.0` (the highest pin currently in use on Deno side).
- The `^2.43.0` caret matches semver-minor — won't accidentally pull `@3.x` if it ships.

If OQ3 = follow-up PR:
- Preserve each file's current pin verbatim (`@2.39.3` stays `^2.39.3`, `@2.43.0` stays `^2.43.0`, `@2` stays `^2`). Mechanical migration only.

## 4. Test plan

### 4.1 Pre-merge — local

1. **Unit tests (Vitest, jsdom):** `npm run test:unit` — all 24 tests pass. Critical that `ledger-writes.test.ts`, `budget.test.ts`, `getRefundableBalanceForPI.test.ts`, `adjustments.test.ts` (the type-only-import tests) all pass; failure here means `import type` was botched on one of the `_shared/` files.

2. **Type check:** `npx tsc -b` clean.

3. **Local Deno deploy:** `supabase functions serve labels stripe-webhook payments refunds` — boot 4 highest-risk functions locally, confirm no import resolution errors in stderr. (Equivalent to what CI deploy does, but on local Deno.)

4. **Smoke an edge function:** `curl http://localhost:54321/functions/v1/labels` with a stub payload, confirm function loads and returns expected 400 (missing fields) not 500 (import failure).

### 4.2 Pre-merge — integration

`npm run test:integration` — runs [refunds-endpoint.test.ts](../tests/integration/refunds-endpoint.test.ts), [refund-cron-sweep.test.ts](../tests/integration/refund-cron-sweep.test.ts), [shipment-invoice-webhook.test.ts](../tests/integration/shipment-invoice-webhook.test.ts), [flex-link-api.test.ts](../tests/integration/flex-link-api.test.ts), [recipient-flow-api.test.ts](../tests/integration/recipient-flow-api.test.ts) against real Supabase + real EasyPost test API. These exercise the migrated functions end-to-end including the `_shared/` ledger and refund helpers.

**Rule 0.5 reminder:** verify `POSTGRES_PRISMA_URL` is test before running. (N/A for SendMo — it uses Supabase URLs not Postgres, but the integration suite hits real Edge Functions so the same caution applies to the Supabase project ref.)

### 4.3 Post-merge — production

1. **Watch the CI deploy.** All ~24 functions redeploy (because `_shared/` changed). Confirm each prints `Deployed Function: <name>` with no import warnings.

2. **Smoke production by hitting a benign endpoint:** `curl https://<project>.supabase.co/functions/v1/place-details?…` or similar — confirms cold-start import resolution works against live JSR.

3. **Tail logs for 15 min** on stripe-webhook and labels (the two highest-volume H1-H5 functions) — watch for any import-resolution warnings or unexpected runtime errors.

4. **Trigger a benign Stripe test webhook** to confirm the migrated `stripe-webhook` function processes events end-to-end (signature verify → ledger write → response).

## 5. Out of scope

- **Stripe HTTP client.** `_shared/stripe.ts` is already a raw-fetch implementation — no package dep, no migration needed.
- **`npm:stripe` migration.** Not proposed; the raw client works fine. Adding the `stripe` npm package would be a separate proposal.
- **Vendoring (`deno cache --vendor`).** Considered and rejected in §2.5. Re-litigating that is reviewer's call.
- **Adding `deno.json` import maps for all functions.** Considered and rejected as unnecessary churn — JSR + `npm:` specifiers work inline. The existing two `deno.json` files (`test-db-insert`, `admin-report`) stay as-is.
- **Refactoring the type-only-import pattern.** Comments explain it well; the pattern works; leave it alone. (Touching the comment text is fine if a version string moves; don't restructure the pattern.)
- **Deno version pinning / Supabase CLI version pinning in CI.** Separate concern; not addressed here.
- **The buy-time-rate-gate proposal merge collision.** If both this and [buy-time-rate-gate](2026-05-23_buy-time-rate-gate.md) are approved, sequencing is reviewer/John's call — see OQ4.

## 6. Verification

End-to-end walkthrough to run after implementation:

1. **Branch & PR.** All changes in one PR titled `chore(edge): migrate URL imports to JSR + Deno.serve (eliminate esm.sh fragility)`.
2. **CI green.** All blocking checks (unit, tsc, mocked e2e) pass. Integration is run locally before merge; not gated in CI.
3. **Manual local boot.** `supabase functions serve` for stripe-webhook, labels, payments, refunds — confirm all four boot without import errors.
4. **Merge to main.** Triggers the deploy workflow → redeploys all ~24 functions atomically.
5. **Production smoke.**
   - `curl https://<project>.supabase.co/functions/v1/place-details?query=anything` → expect normal response, not 500 import error
   - `curl https://<project>.supabase.co/functions/v1/labels -X POST -H "Authorization: Bearer …" -d '{}'` → expect normal 400 (missing fields), not 500
   - Tail logs for stripe-webhook + labels for 15 minutes
   - Trigger one Stripe test webhook from the Stripe Dashboard → confirm end-to-end processing
6. **Update LOG.md** with the deploy outcome and any anomalies; cross-link this proposal.

**Rollback plan:** `git revert <merge-commit> && git push` → triggers redeploy of pre-migration code within ~2 minutes. Already-deployed migrated functions roll back atomically.

## 7. Open questions

**OQ1 — Now vs. after launch?** *The big one. Author leans "now" per §1.2 but flags this as a real judgment call.*

- **Now:** ~half-day of focus diverted from buy-time-rate-gate / recon implementation. Eliminates a known fragility class before launch. Lowers blast radius if a 522 lands on a hotfix.
- **Defer to week after launch:** Preserves H1-H5 focus this week. Accepts the (small but real) risk that the next esm.sh outage lands on a more sensitive deploy. Calmer window to verify post-launch.

**OQ2 — Per-function `deno.json` import maps, or inline `jsr:` specifiers?**
- *Author recommends inline.* Smaller diff, fewer new files, matches what most edge functions already do. The 2 existing `deno.json` files stay as-is.
- Counter: a shared `deno.json` at `supabase/functions/import_map.json` with bare specifiers (`"@supabase/supabase-js": "jsr:@supabase/supabase-js@^2.43.0"`) would let future version bumps happen in one place. Real but small benefit; can be a follow-up.

**OQ3 — Unify the supabase-js version pin in this PR, or follow-up?**
- *Author recommends unify in this PR.* We're editing every import line anyway; the marginal cost is ~zero, and the drift is real (`@2`, `@2.39.3`, `@2.43.0` across 22 files). Target: `^2.43.0`.
- Counter: bundles a *behavioral* change (version bump) into an *infra* change (registry switch). If JSR migration goes wrong, we don't want to also be debugging "did supabase-js@2.43 introduce something we depend on?" The clean answer might be: PR1 = migration with pins preserved verbatim, PR2 = pin unification.

**OQ4 — Sequencing with [buy-time-rate-gate](2026-05-23_buy-time-rate-gate.md).**
Both proposals touch `labels/index.ts`. Three options:
- (a) Buy-time-rate-gate ships first, then this migration rebases on it. *Author preference — the rate-gate is launch-critical correctness, this is infra.*
- (b) This migration ships first, then buy-time-rate-gate rebases on JSR imports. Cleaner imports for the gate work, but inverts launch priority.
- (c) Combine both into one PR. Rejected — different change types, different review profiles.

**OQ5 — Drop `import type` regression test?**
Should we add a CI check that catches "someone accidentally dropped the `type` qualifier on a `_shared/` URL import" in the future? E.g., `grep -E '^import \{[^}]*\}.*from.*https?://|jsr:|npm:' supabase/functions/_shared/*.ts` should match nothing. *Author leans yes (one-line CI grep), but it's bikeshed-level — happy to defer.*

## Reconciliation with prior decided proposals

- **[2026-05-22 reconciliation + carrier adjustments](2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_decided-2026-05-22.md)** — implementation is *in flight today*, touching [stripe-webhook](../supabase/functions/stripe-webhook/index.ts), [webhooks](../supabase/functions/webhooks/index.ts), [reconciliation-sweep](../supabase/functions/reconciliation-sweep/index.ts), [_shared/adjustments.ts](../supabase/functions/_shared/adjustments.ts), [_shared/ledger.ts](../supabase/functions/_shared/ledger.ts). This proposal touches the same files but only their import lines. No semantic conflict; potential merge conflict at the import-statement line — easy to resolve.

- **[2026-05-23 buy-time-rate-gate](2026-05-23_buy-time-rate-gate.md)** — in review today. Touches `labels/index.ts`. Same situation: import-line collision only, no semantic conflict. Sequencing discussed in OQ4.

- **[2026-05-21 refund system implementation](2026-05-21_refund-system-implementation_reviewed-2026-05-21_decided-2026-05-22.md)** — shipped (commit `205d315`). The `import type` pattern in `_shared/refunds.ts` was *established* by this proposal (B1 fix). Preserving it is non-negotiable; §2.4 calls this out explicitly.

- **[2026-05-13 phase-b saved cards](2026-05-13_phase-b-saved-cards-implementation_reviewed-2026-05-13_decided-2026-05-13.md)** — shipped. Touched many of the same edge functions but established the `_shared/` ledger pattern. No conflict.

No prior decided proposal speaks to the import-registry choice. This is greenfield in that sense.

## MCP reconciliation

No MCP-visible impact. SendMo is a customer-facing product, not an MCP server. The Supabase MCP server is used by Claude agents in development; nothing in this proposal touches it.
