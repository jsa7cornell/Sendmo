---
title: Seller Link — PR14 launch runbook (gated on the prod-env read)
slug: seller-launch-runbook
project: sendmo
status: blocked
blocked_on: John's read of the current production env values (review B2)
created: 2026-08-29
last_updated: 2026-08-29
---

> **This is the ONLY unexecuted piece of the seller-link launch plan.** PR1–PR13
> are implemented (PRs #114–#126, stacked; see the decided proposal). This
> runbook exists so PR14 is executed from the world as it IS, not as remembered
> — the review's B2 finding: `SENDMO_LIVE_DEFAULT=true` has been set in prod
> since 2026-07-05, so "flip it" as a launch step was already wrong once.

## Step 0 — John reads the current values (agents don't read prod secrets)

```bash
npx supabase secrets list --project-ref fkxykvzsqdjzhurntgah
```

Plus the Vercel dashboard env. Record here, then plan the delta:

| Variable | Expected (PRE-LAUNCH T1-1, 2026-07-05) | Actual |
|---|---|---|
| `SENDMO_LIVE_DEFAULT` | `true` (already flipped — closed beta) | |
| `PAYMENTS_LIVE_ALLOWLIST_ONLY` | `true` | |
| `PAYMENTS_ALLOWED_USERS` | John's UID only | |
| `VITE_ENABLE_SELLER_LINK` (Vercel) | unset or `coming-soon` | |

Also confirm the vault `service_role_key` exists (migration 036's John-step) —
migration 049's band sweep posts with it.

## Step 1 — merge + deploy the stack (in order)

#114 → #115 → #116 → #117 → #118 → #119 → #120 → #121 → #122 → #123 → #124 → #125 → #126.
After each merge, retarget the next PR to `main` (that's what triggers its CI —
the workflow only fires on PRs targeting main; wait for green before merging).
Migrations 045–050 apply with the deploys (045/047/050 are the money-relevant
ones; all pre-flighted/additive; 049 registers the band cron; deploy 046
BEFORE/WITH the functions or the money paths fail open onto the speed bump —
one admin alert per isolate fires if that happens).

## Step 2 — the actual launch delta (likely, pending Step 0)

1. Set `VITE_ENABLE_SELLER_LINK=true` in Vercel Production → redeploy → the
   Sell & Ship entry points go live (in test mode for everyone).
2. Live money needs NOTHING flipped if Step 0 confirms T1-1's state: the
   allowlist (`PAYMENTS_ALLOWED_USERS` = John) already contains exactly the
   launch cohort, and seller-checkout gates the SELLER against it. Widening
   the allowlist later is the "one seller at a time" lever.

## Step 3 — verification (§6 of the decided proposal), THEN cleanup

Run the decided proposal's §6 walkthrough (steps 1–12) with the allowlist
containing only John. The test fixtures `SELLE2E01` / `SELLTEST01` are
deliberately retained for this run (LOG 2026-07-19) — delete them **after**
it passes, per Rule 0.5 stated-SQL:

```sql
DELETE FROM sendmo_links WHERE short_code IN ('SELLE2E01','SELLTEST01');
```

(Post-050 this fails loudly if any shipment still references them — that's
the RESTRICT FK working; repoint or delete those test shipments first.)
Log the deletion in LOG.md.
