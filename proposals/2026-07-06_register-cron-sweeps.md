---
title: Register the pg_cron sweeps (reconciliation + refund finalizer)
slug: register-cron-sweeps
project: sendmo
status: reviewed
created: 2026-07-06
last_updated: 2026-07-06
reviewed: 2026-07-06
decided: null
author: Claude (T2-1 owner session — cron registration end-to-end)
reviewer: Claude Opus 4.8 — fresh-eyes review; cold read against PLAYBOOK Rules 0.5/6/16/17/19/21, PRE-LAUNCH T2-1, migrations 034/035, the reconciliation-sweep + cron-refund-sweep + _shared/auth.ts source, the 2026-05-22 reconciliation + 2026-05-23 handoff decided proposals, and the LIVE prod DB (migration tracker, pg_cron/pg_net extension state, postgres role/superuser, current_setting throw behavior, config.toml verify_jwt)
outcome: null
---

## 1. Context

Two self-healing background sweeps were **built during the pre-launch P1 work and deployed as Edge Functions, but their pg_cron schedules were never registered** — the extensions weren't enabled on the Free tier, so the `cron.schedule()` calls in migrations 034/035 were deliberately left as commented "apply-later" blocks. Today both sweeps only run if an admin manually POSTs to them. This is PRE-LAUNCH item **T2-1**, unblocked by T1-2 (Supabase Pro, done 2026-07-04).

What the sweeps do, and why "never self-heals" is the risk if they stay manual:

- **`reconciliation-sweep`** — daily incremental list-and-diff of EasyPost shipments/refunds vs. SendMo's `shipments`/`transactions`, plus a weekly bulk CSV reconciliation. It also **re-fires `resolveRecovery` on carrier-adjustment rows stuck at `recovery_status='pending'`** (the N1 drift-detector). Without it, a carrier reweigh that the webhook missed, or a recovery that crashed mid-flight, sits unrecovered forever — SendMo silently eats the cost.
- **`cron-refund-sweep`** — the 21-day refund finalizer. Finds `refund_status='submitted'` shipments older than 21 days, polls EasyPost one last time, and terminates them (refunded / rejected / timeout) with the correct customer email. Without it, a refund whose `charge.refunded` webhook never arrived stays `submitted` forever — the customer's money is stuck in limbo and no email ever tells them.

This proposal is **drift-restoration of a documented-but-unexecuted plan**, not new design. The schedules, offsets, and GUC boilerplate were all decided in migrations 034/035 and the 2026-05-22 reconciliation proposal. See §8 (Reconciliation with prior decided proposals).

### The one real finding (not a schedule question)

While tracing the invoke contract, I found a **blocking bug in the deployed `cron-refund-sweep`**: it calls `requireAdmin(req)` unconditionally, with **no cron-auth-bypass branch**. `reconciliation-sweep` has one (`isCronCall = authHeader === "Bearer " + serviceRoleKey`, lines 584–597); `cron-refund-sweep` does not (it goes straight to `requireAdmin` at line 194).

`requireAdmin` validates the Bearer token via `supabase.auth.getUser(token)` then looks up `profiles.role='admin'`. When pg_cron POSTs `Bearer <service_role_key>`, that token resolves to the service-role principal, which has **no `profiles` row** → `requireAdmin` throws **403 "Profile not found"**. So **if we schedule `cron-refund-sweep` as written today, every cron run is silently rejected 403 and the sweep never executes** — exactly the "silent auth failure" failure mode T2-1 is meant to close, reproduced. This must be fixed *before or with* the cron registration, or we'd be scheduling a job that can't run.

## 2. Architecture

```
pg_cron (in Postgres)                       Edge Function                     Effect
─────────────────────                       ─────────────                     ──────
'reconciliation-sweep-daily'  0 4 * * *  ─┐
  net.http_post → /functions/v1/           ├─► reconciliation-sweep          daily diff + N1
  reconciliation-sweep  body {"mode":      │   (cron-bypass branch EXISTS)   recovery re-fire
  "daily"}                                 │
'reconciliation-sweep-weekly' 0 5 * * 0  ─┤                                   weekly bulk CSV
  body {"mode":"weekly"}                    │
                                           │
'refund-cron-sweep-daily'    30 4 * * * ─┘►  cron-refund-sweep               finalize stale
  net.http_post → /functions/v1/               (cron-bypass branch MISSING   'submitted' refunds
  cron-refund-sweep  body {}                    → must be added first)

Auth header on every call:  Bearer <app.service_role_key GUC>
GUCs read by net.http_post:  app.supabase_url, app.service_role_key
```

**Why the offsets:** reconciliation-daily at 04:00 UTC, refund at 04:30 UTC. Both hit the EasyPost list/GET API; running them 30 min apart avoids concurrent list-load (decided in migration 035's header + the handoff §H5). Weekly bulk at 05:00 UTC Sundays, after the daily has finished, per migration 034's header.

**Three schedules, not two:** the reconciliation-sweep has two modes (`daily` and `weekly`) selected by request body. The pre-launch checklist mentions "daily + weekly Sundays variant" — that's two `cron.schedule()` calls pointing at the same function with different bodies. Plus the one refund schedule = **three cron jobs total.**

**Idempotency:** every `cron.schedule(name, ...)` is upsert-by-name in pg_cron (re-scheduling the same jobname replaces it), but to be safe and explicit the migration wraps each in `cron.unschedule(name)`-if-exists then `cron.schedule(name, ...)`. Re-applying the migration yields exactly three jobs, never duplicates.

## 3. File-by-file plan

### 3a. Fix `cron-refund-sweep` auth (BLOCKING PREREQUISITE) — `supabase/functions/cron-refund-sweep/index.ts`

Add the same cron-bypass branch `reconciliation-sweep` already uses, before the `requireAdmin` call (~line 191–198). Replace:

```ts
  // ── Auth: admin only ────────────────────────────────────────────────────────
  let supabase: ReturnType<typeof createClient>;
  try {
    ({ supabase } = await requireAdmin(req, corsHeaders));
  } catch (r) {
    if (r instanceof Response) return r;
    throw r;
  }
```

with (mirrors reconciliation-sweep lines 577–597, same pattern — Rule 6, reuse the established shape):

```ts
  // Auth — called by pg_cron (service-role Bearer) OR manually by admins.
  const authHeader = req.headers.get("Authorization");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    || Deno.env.get("SB_SERVICE_ROLE_KEY") || "";
  const isCronCall = serviceRoleKey !== "" && authHeader === `Bearer ${serviceRoleKey}`;

  let supabase: ReturnType<typeof createClient>;
  if (!isCronCall) {
    // Manual admin invocation — verify admin JWT.
    try {
      ({ supabase } = await requireAdmin(req, corsHeaders));
    } catch (r) {
      if (r instanceof Response) return r;
      throw r;
    }
  }
  // (isCronCall path falls through; the function already builds its own
  //  service-role `serviceSupabase` client below for all DB writes, so the
  //  admin-path `supabase` binding is only used by requireAdmin's own checks.)
```

Note: `cron-refund-sweep` already constructs a dedicated `serviceSupabase` client (lines 208–211) for all its actual DB work and does **not** use the `supabase` returned by `requireAdmin` for anything downstream — so the cron path needs no `supabase` binding at all. This is a minimal, behavior-preserving change: the admin path is byte-for-byte the same; the cron path is newly *allowed* instead of 403'd. (TypeScript: `let supabase` becomes possibly-unassigned on the cron path; declare it `let supabase: ReturnType<typeof createClient> | undefined` or drop the binding entirely since it's unused past this block. I'll drop it — cleaner.)

### 3b. New migration — `supabase/migrations/036_register_cron_sweeps.sql`

A single idempotent migration that (a) enables the extensions, (b) sets the **non-secret** GUC, (c) registers all three jobs. It does **NOT** set `app.service_role_key` (that's John's — a secret; §7). Structure:

```sql
-- Migration 036 — register pg_cron sweeps (T2-1)
-- Restores the DEFERRED Block 2 of migrations 034 + 035.

-- 1. Extensions (idempotent; Supabase installs these into the `extensions` schema)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 2. Non-secret GUC (service_role_key GUC is set separately by John — a secret)
ALTER DATABASE postgres SET app.supabase_url = 'https://fkxykvzsqdjzhurntgah.supabase.co';

-- 3. Register the three jobs (unschedule-if-exists → schedule = idempotent)
DO $$
BEGIN
  PERFORM cron.unschedule('reconciliation-sweep-daily')  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='reconciliation-sweep-daily');
  PERFORM cron.unschedule('reconciliation-sweep-weekly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='reconciliation-sweep-weekly');
  PERFORM cron.unschedule('refund-cron-sweep-daily')     WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='refund-cron-sweep-daily');
END $$;

SELECT cron.schedule('reconciliation-sweep-daily', '0 4 * * *', $CRON$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/reconciliation-sweep',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'),
    body := '{"mode":"daily"}'::jsonb
  );
$CRON$);

SELECT cron.schedule('reconciliation-sweep-weekly', '0 5 * * 0', $CRON$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/reconciliation-sweep',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'),
    body := '{"mode":"weekly"}'::jsonb
  );
$CRON$);

SELECT cron.schedule('refund-cron-sweep-daily', '30 4 * * *', $CRON$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/cron-refund-sweep',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$CRON$);
```

The `net.http_post` shape is copied verbatim from migration 035 Block 2 — same `current_setting('app.service_role_key')` read, same header build, same body pattern.

**Ordering caveat (see Open Question 1):** `cron.schedule` here reads `app.service_role_key` at *fire time*, not at schedule time, so registering the jobs before John sets the key GUC is safe — the jobs just no-op-fail (a `current_setting(... , false)` on a missing GUC would error inside the job, logged in `cron.job_run_details`) until the key lands. So the migration can be applied by the agent; the jobs sit idle-but-registered until John completes step §7.

### 3c. Docs

- Append the T2-1 execution note to `LOG.md` (Rule 17) with the exact SQL applied + target (Rule 0.5).
- Flip PRE-LAUNCH T2-1 status to `[x]` (or `[~]` with the John-only remainder) with a dated note.
- Add this proposal to `proposals/README.md`.

## 4. Test / verification plan

Post-apply verification (§6 has the copy-paste). No unit tests — this is infra/SQL + a one-branch auth change on an Edge Function whose behavior is verified by the manual force-run. The auth change itself is covered by: (a) `tsc`/deploy green, (b) the forced cron-shaped POST in §6 returning 200 instead of 403.

## 5. Out of scope

- **No change to sweep business logic** — only the auth gate on `cron-refund-sweep` and the schedule registration.
- **Not forcing a real refund sweep run** that could move money. The refund sweep can fire real Stripe refunds (`createRefund(..., liveMode: true)`) on genuinely-stale `submitted` live shipments. I will **verify it's scheduled + auth-reachable without triggering money movement** — see §6 for how (query stale-set first; only force if the stale-set is empty/test-only).
- **No `pg_net` response-handling / retry logic.** `net.http_post` is fire-and-forget; the sweeps are self-idempotent (cursor + dedup indexes), so a dropped response just means the next day's run picks up the slack. Not adding a response reconciler here.
- **No live-payment env-var flips.** Untouched.

## 6. Verification (run after apply)

```sql
-- (1) All three jobs registered + active
SELECT jobname, schedule, active FROM cron.job ORDER BY jobname;
-- Expect: reconciliation-sweep-daily | 0 4 * * *  | t
--         reconciliation-sweep-weekly| 0 5 * * 0  | t
--         refund-cron-sweep-daily    | 30 4 * * * | t

-- (2) Extensions present
SELECT extname FROM pg_extension WHERE extname IN ('pg_cron','pg_net');

-- (3) GUCs (after John sets the key): url set, key present (never SELECT the key value)
SELECT current_setting('app.supabase_url', true) AS url,
       (current_setting('app.service_role_key', true) IS NOT NULL) AS key_set;
```

**Force one safe run** (reconciliation daily — read-heavy, no money): after John confirms the key GUC is set,
```sql
SELECT cron.schedule('recon-oneoff-verify', '* * * * *', $CRON$ ... reconciliation-sweep body {"mode":"daily"} $CRON$);
-- wait ~90s, then:
SELECT jobname, status, return_message, start_time FROM cron.job_run_details
  WHERE jobname='recon-oneoff-verify' ORDER BY start_time DESC LIMIT 3;
SELECT key, last_run_at FROM recon_state WHERE key='reconciliation_daily';  -- last_run_at should advance to ~now
SELECT cron.unschedule('recon-oneoff-verify');
```
`status='succeeded'` + `recon_state.reconciliation_daily.last_run_at` advancing to ~now confirms the whole chain: cron → net.http_post → GUC-authenticated call → function ran → wrote state.

**Refund sweep — verify reachability without moving money.** First check whether forcing it could refund anything:
```sql
SELECT count(*) FROM shipments
 WHERE refund_status='submitted' AND is_test=false
   AND refund_submitted_at < now() - interval '21 days'
   AND easypost_shipment_id IS NOT NULL;
```
If **0**, forcing it is safe (it will process nothing) — do the same one-off-schedule dance against `cron-refund-sweep`, expect `status='succeeded'` and `results` all-zero, confirming the auth fix works end-to-end. If **>0**, do NOT force it — those are real stale live refunds it would finalize/refund. Instead confirm reachability by checking that the deployed function returns 200 (not 403) to a service-role Bearer via a single manual `net.http_post` one-off with `body {}` is still risky if the count>0; in the count>0 case, verify auth only by reading the deployed function's post-deploy logs after the scheduled 04:30 run, or by temporarily pointing a one-off at it and immediately checking it returned 200 — but since even one real run refunds money, the honest answer is: **let the natural 04:30 schedule be the first real run, and confirm via `cron.job_run_details` + `event_logs` the next morning.** (I expect count=0 at launch — no live refunds are stale yet — so the safe force-run will apply.)

## 7. John-only step (secret — Rule 0)

The `app.service_role_key` GUC is the **service-role JWT, a secret**. The agent does not set or print it. John runs, once, in the Supabase Dashboard → SQL Editor (or `psql`):

```sql
ALTER DATABASE postgres SET app.service_role_key = '<service-role-jwt>';
```
Where to find the value: Supabase Dashboard → Project `fkxykvzsqdjzhurntgah` → Settings → API → **`service_role` secret** (the `service_role` key, NOT the `anon`/publishable one). Paste it into the single quotes. Do not paste it into this chat.

After running it, the three already-registered jobs become live on their next scheduled fire. (If John prefers, he can also toggle the two extensions via Dashboard → Database → Extensions instead of letting the agent's migration `CREATE EXTENSION` them — see Open Question 2.)

## Open questions (for the reviewer)

1. **Is agent-applying `CREATE EXTENSION pg_cron/pg_net` via the write-capable MCP the right call, or should extension-enable be a John-in-dashboard step?** The MCP runs as `postgres` with CREATE on the DB, and Supabase whitelists these extensions for that role, so `apply_migration` should succeed. But extensions are a heavier-than-usual DDL on a live prod DB. I lean agent-applies (it's idempotent, reversible via `DROP EXTENSION`, and the whole point of the write-capable MCP), but flag it for a sanity check.

2. **Registering the jobs *before* John sets the `service_role_key` GUC** — I claim this is safe (jobs fire, fail to read the missing GUC, log the failure in `job_run_details`, self-heal once the key lands). Is there a downside to idle-failing jobs sitting in the schedule for the window between agent-apply and John's step (could be hours)? Alternative: gate the whole migration behind John's step and have the agent apply it *after*. I lean apply-now-idle-fail (simpler handoff, self-heals), but the failing-job noise in `job_run_details` is a mild smell.

3. **The `cron-refund-sweep` auth fix — is the minimal cron-bypass branch (drop the unused `supabase` binding on the cron path) the right shape, or should I extract a shared `_shared/cron-auth.ts:isCronCall(req)` helper** used by both sweeps (Rule 6)? Both functions now have the identical `authHeader === "Bearer " + serviceRoleKey` check. I lean toward extracting it since it's now duplicated in two money-adjacent functions and the check is subtle (empty-key guard matters), but it's a slightly larger diff. Reviewer's call on whether the abstraction earns its keep.

4. **Should the weekly bulk run be scheduled at all in week one?** The weekly `mode=weekly` sweep generates EasyPost Reports and polls up to ~10 min inside the Edge Function. With near-zero live volume it'll mostly no-op, but it's the heaviest job. Alternative: register daily now, defer weekly until there's a few weeks of live shipments to reconcile. I lean **register all three now** (it's the decided plan; a no-op weekly run is cheap and proves the path), but a reviewer might argue for staging.

## 8. Reconciliation with prior decided proposals

This proposal **restores deferred work**, it does not decide anything new. Sources:

- **Migration 034** (`034_reconciliation_cron.sql`) header, lines 21–42: explicitly defers the reconciliation cron to a fast-follow, names the exact enable-later steps (enable pg_cron+pg_net, set `app.supabase_url` + `app.service_role_key` GUCs, apply the `cron.schedule()` in a follow-up migration) and the exact cadence: **"daily 04:00 UTC + weekly 05:00 UTC Sundays."** My daily `0 4 * * *` + weekly `0 5 * * 0` match this verbatim. The header notes the `cron.schedule()` boilerplate "lived in this file's earlier draft — see git history at the H4 commit"; I checked — it was **never actually committed** (only referenced), so I reconstruct it fresh from migration 035 Block 2's identical shape, which is the authoritative surviving template.
- **Migration 035** (`035_refund_cron_state.sql`) Block 2, lines 62–93: the `cron.schedule('refund-cron-sweep-daily','30 4 * * *', …)` call **written out in full** as a deferred block, with the 04:30-vs-04:00 offset rationale ("avoid concurrent load when both sweeps are active"). I apply it verbatim (jobname, schedule, body `{}`, net.http_post shape all preserved).
- **Decided proposal `2026-05-22_reconciliation-and-carrier-adjustments_…_decided-2026-05-22.md`** §3 (reconciliation-sweep Edge Function, dual daily/weekly path) + N1 (drift re-fire) — the sweep logic these schedules drive. Its Open-Question-3 explicitly proposed "daily incremental at 04:00 UTC, weekly bulk Sundays" and it was decided as-is.
- **Decided proposal `2026-05-21_refund-system-implementation_…_decided-2026-05-22.md`** D3 (21-day cron threshold) — the refund sweep's terminal-timeout policy the schedule enforces.
- **`2026-05-23_pre-launch-handoff-plan.md`** §H4 ("pg_cron registration: daily at 04:00 UTC … weekly Sundays") + §H5 ("daily at 04:30 UTC (offset from H4's 04:00)") — the handoff that packaged both as fast-follows.
- **2026-05-24 "Pre-launch P1 wrap-up"** (LOG) — documents these two sweeps as built-but-manual with explicit enable-later intent.

**The one thing that is genuinely new** (and therefore the thing to scrutinize): the `cron-refund-sweep` auth-bypass fix in §3a. This is **not** in any prior proposal — it's a latent bug in the deployed H5 code that only bites the moment cron actually calls it. Framing: the H5 handoff (§H5) said "service role JWT for the pg_cron scheduled path," implying the bypass was *intended*, but the code shipped without it (reconciliation-sweep got the bypass, refund-sweep didn't — an asymmetry that went unnoticed because neither was ever cron-invoked). So §3a is *restoring the intended H5 behavior*, consistent with the decided design, not adding a new capability.
