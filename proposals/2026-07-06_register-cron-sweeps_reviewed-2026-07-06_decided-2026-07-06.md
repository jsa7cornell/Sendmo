---
title: Register the pg_cron sweeps (reconciliation + refund finalizer)
slug: register-cron-sweeps
project: sendmo
status: decided
created: 2026-07-06
last_updated: 2026-07-06
reviewed: 2026-07-06
decided: 2026-07-06
author: Claude (T2-1 owner session — cron registration end-to-end)
reviewer: Claude Opus 4.8 — fresh-eyes review; cold read against PLAYBOOK Rules 0.5/6/16/17/19/21, PRE-LAUNCH T2-1, migrations 034/035, the reconciliation-sweep + cron-refund-sweep + _shared/auth.ts source, the 2026-05-22 reconciliation + 2026-05-23 handoff decided proposals, and the LIVE prod DB (migration tracker, pg_cron/pg_net extension state, postgres role/superuser, current_setting throw behavior, config.toml verify_jwt)
outcome: approve-with-changes
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

---

## Review

```yaml
reviewer: Claude Opus 4.8 — fresh-eyes review; verified every claim against source + LIVE prod DB
reviewed_at: 2026-07-06
verdict: approve-with-changes
```

### Summary

This is a well-researched proposal that gets the hard part right: the central bug finding (§3a — `cron-refund-sweep` calls `requireAdmin` unconditionally with no cron-bypass, so every pg_cron run would 403) is **real and verified in source** (index.ts:191-198; `requireAdmin` does `getUser(token)` + `profiles.role='admin'` at auth.ts:61-88 → service-role principal has no `profiles` row → 403). The drift-restoration framing is honest — the schedules (`0 4 * * *`, `0 5 * * 0`, `30 4 * * *`) match migrations 034/035 and handoff §H4/§H5 verbatim, and the `net.http_post` shape is copied faithfully from migration 035 Block 2. But the proposal has a **load-bearing correctness bug in the migration SQL itself** (B1), skips an **unexamined gateway-auth layer** that determines whether the whole scheme works (B2), and leaves an **implicit GUC↔env equality requirement** unstated that is the single most likely silent-failure at fire time (B3). All three are fixable in the plan before code lands; none invalidates the approach.

### Blocking issues

**B1 — The `cron.unschedule(...) WHERE EXISTS (...)` idempotency guard is invalid SQL and will make the migration throw.**
*Location:* §3b, migration 036, the `DO $$ BEGIN PERFORM cron.unschedule(...) WHERE EXISTS (...) ...` block (lines 117-122).
*Issue:* `PERFORM function() WHERE EXISTS (...)` is not valid PL/pgSQL — `PERFORM expr WHERE ...` has no `FROM`, so the `WHERE` clause has nothing to filter and Postgres raises a syntax error. You cannot attach a bare `WHERE` to a `PERFORM <scalar-function-call>`. The intent (unschedule-if-exists) needs either a guarded `IF EXISTS (SELECT 1 FROM cron.job WHERE jobname=...) THEN PERFORM cron.unschedule(...); END IF;` per job, or the simpler `PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = '...';` form (which is a real query with a FROM and naturally no-ops on zero rows). As written the migration errors on the *first* apply, before any job is registered — the opposite of idempotent.
*Suggested fix:* Rewrite each unschedule as `PERFORM cron.unschedule(jobname) FROM cron.job WHERE jobname = '<name>';` (note: pass the jobname, which `cron.unschedule(text)` accepts, or the jobid from the row). This is a real SELECT-driven PERFORM that no-ops cleanly when the job doesn't exist. Test the exact block against the live DB before calling it idempotent — the proposal asserts "re-applying yields exactly three jobs" but that claim was never executed.

**B2 — The proposal never accounts for `verify_jwt = true` on both functions — the platform gateway auth layer that sits *in front of* the code's auth branch.**
*Location:* §2 (Auth header on every call), §3a. Not mentioned anywhere.
*Issue:* `supabase/config.toml` sets `verify_jwt = true` for both `[functions.reconciliation-sweep]` (line 165) and `[functions.cron-refund-sweep]` (line 182). With `verify_jwt=true`, the Edge Runtime gateway validates the Bearer JWT *before* the function's own code runs — the `isCronCall` branch in §3a never executes if the gateway rejects the token first. In practice a `service_role` key is a valid project-signed JWT and the gateway **does** accept it (same secret, `role: service_role` claim), so the cron path works — but the proposal proves the code-level auth without ever verifying the layer that actually gates the request. This matters because (a) `reconciliation-sweep` "works today when manually POSTed by an admin" tells you nothing about the service-role path through the gateway (an admin uses their own user JWT), and (b) if config.toml drift ever flips these to a stricter posture, or the deployed config diverges from the repo, the jobs silently 401 at the gateway with the same symptom T2-1 exists to prevent. The proposal's own §6 force-run is the only thing that would catch this, and it's gated behind "after John sets the key."
*Suggested fix:* Add one line to §2/§3a noting that `verify_jwt=true` is in force and that the service-role JWT passes the gateway (this is the documented Supabase behavior — service-role and anon keys both clear `verify_jwt`). Confirm the *deployed* config matches the repo. Make the §6 reconciliation force-run (the money-safe one) a **required** post-apply step, not an optional "after John's key" nicety — it's the only end-to-end proof the gateway+code+GUC chain works.

**B3 — The unstated equality requirement: the `app.service_role_key` GUC John pastes must byte-for-byte equal the function's `SUPABASE_SERVICE_ROLE_KEY` env var, or `isCronCall` is false and the run 403s silently.**
*Location:* §3a (the `isCronCall` comparison), §7 (John sets the GUC).
*Issue:* The whole cron-auth scheme is a **string-equality** check: `authHeader === "Bearer " + serviceRoleKey` where `serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")`. pg_cron sends `Bearer <current_setting('app.service_role_key')>` — whatever John pastes into the GUC in §7. If John pastes a *different* representation of the service-role key than what's deployed as the function's `SUPABASE_SERVICE_ROLE_KEY` secret (e.g. a rotated key, a key from a different project view, or a legacy vs. new JWT after a Supabase key format change), the strings won't match, `isCronCall` is false, control falls to `requireAdmin`, and every run 403s — the exact silent failure this proposal is closing, reintroduced one layer down. The proposal treats "John sets the GUC" and "the function reads its env key" as obviously-consistent; they're two independently-set values that must be identical. Additionally there's a verified env-var asymmetry (see N1) that widens the surface for mismatch.
*Suggested fix:* Add to §7 an explicit invariant: *"the value set in `app.service_role_key` must be the same string as the `SUPABASE_SERVICE_ROLE_KEY` secret already deployed to the functions."* Give John a way to confirm without printing either secret — e.g. after he sets the GUC and the first reconciliation run fires, the §6 force-run returning `succeeded` (not 403) *is* the equality proof. State that the force-run is the gate that catches a mismatch, and that a 403 in `job_run_details` means the GUC≠env, not a code bug.

### Non-blocking concerns

**N1 — Env-var read asymmetry between the two sweeps.** Verified: `reconciliation-sweep:580` reads `SUPABASE_SERVICE_ROLE_KEY` *only* (`?? ""`), while the proposal's suggested fix for `cron-refund-sweep` reads `SUPABASE_SERVICE_ROLE_KEY || SB_SERVICE_ROLE_KEY` (either). If in the deployed env the actual key lives under `SB_SERVICE_ROLE_KEY` (a fallback that `cron-refund-sweep:201` and `auth.ts:38` both honor but `reconciliation-sweep:580` does not), then reconciliation's cron-bypass would compare against `""`, `isCronCall` guards on `serviceRoleKey !== ""` so it'd be false, and reconciliation's cron path 403s while refund's succeeds — or vice-versa. This is exactly the kind of asymmetry that produced the original §3a bug. Recommend: make both functions read the key identically (pick one canonical env name, verify which one is actually set in prod via the Supabase dashboard secrets list — don't SELECT it), so the cron-bypass behaves the same in both.

**N2 — Open Question 2 (register-before-key) is answered by live DB, and the answer sharpens the proposal's own claim.** I ran it against prod: `current_setting('app.service_role_key')` (the *one-arg* form the cron body uses at lines 128/138/148) throws `ERROR 42704: unrecognized configuration parameter` when the GUC is unset — it does NOT return NULL. The proposal's §3b line 157 acknowledges this ("would error inside the job") so the reasoning is sound: pg_cron catches the per-job exception and logs it to `cron.job_run_details.status='failed'`, so registering-before-key is *survivable* (idle-failing, self-heals when the key lands). But the register-before-key window means every daily fire between agent-apply and John's §7 step writes a `failed` row — and if that window spans a 04:00/04:30/Sunday-05:00 boundary, you get real failure noise. Recommend either (a) John's §7 step runs *first* (the migration is agent-applied after the key is set), collapsing the window to zero, or (b) accept the noise but note it explicitly in the LOG so a future agent seeing `failed` rows in `job_run_details` doesn't chase a ghost. Given B3, ordering John-first is the cleaner handoff — it also means the very first fire is a real proof-of-life.

**N3 — Migration-tracker inconsistency from applying 036 via `apply_migration`.** Verified: the live `supabase_migrations` tracker contains only versions 001-016; 017-035 were applied via Dashboard SQL Editor and never recorded (migrations 034/035 headers confirm "Supabase MCP is read-only on this project" at the time). Applying 036 via the now-write-capable MCP's `apply_migration` will insert a `036` row into a tracker that's missing 017-035. This won't fail (Supabase's tracker isn't strictly sequential-gapless), but it produces a tracker where `036` sits directly after `016` — misleading for any future tooling that diffs tracker-vs-directory, and it means 036 is the *only* post-016 migration the platform "knows" about. Recommend: apply 036 the same way 017-035 were applied (Dashboard SQL Editor, or `execute_sql` for the DDL) to keep the tracker consistent with its established state, OR consciously decide to start recording migrations again from 036 and note the 017-035 gap in the LOG so it's intentional, not an artifact. Either is fine; silently creating a 016→036 tracker jump is the thing to avoid.

**N4 — `CREATE EXTENSION pg_cron/pg_net` via the MCP: verified enable-able but with a caveat.** Live check confirms neither extension is installed (`installed_version: null` for both `pg_cron` 1.6.4 and `pg_net` 0.19.5), the MCP role is `postgres` with `is_superuser = off`. Supabase whitelists both for the `postgres` role, so `CREATE EXTENSION` via `apply_migration` should succeed — but `pg_cron` specifically must be created in the `postgres` database (it is) and Supabase historically routed pg_cron enablement through the dashboard toggle, which also wires the `cron` schema grants. If the bare `CREATE EXTENSION pg_cron` succeeds but the `postgres` role lacks USAGE on the `cron` schema, the subsequent `cron.schedule(...)` calls in the same migration fail. Recommend: split the migration — enable extensions first (or have John toggle them via Dashboard → Extensions, which is the documented Supabase path and guarantees the grants), verify `cron.schedule` is callable, *then* register the jobs. The proposal leans "agent-applies all in one migration"; the safer sequence is extensions-then-verify-then-schedule.

**N5 — pg_net is fire-and-forget and the proposal's §5 dismissal understates one failure mode.** §5 correctly notes the sweeps are self-idempotent (cursor + dedup), so a dropped `net.http_post` response just defers work to the next run. True. But `net.http_post` also silently drops the request if pg_net's background worker queue is saturated or the response never returns — and there's no alerting on a cron job that *fired the http_post successfully* (status `succeeded` in `job_run_details`) but whose HTTP call never reached the function. `job_run_details.status='succeeded'` only means the SQL ran, not that the Edge Function executed. The only ground-truth signal is `recon_state.last_run_at` advancing (recon) or the refund function's `event_logs`. Recommend one sentence in §6/§5: the health check for these jobs is **downstream state advancing** (`recon_state.reconciliation_daily.last_run_at ≈ now`, refund `event_logs` rows), NOT `job_run_details.status`. This is the T1-3 "stop flying blind" concern applied to cron.

### Nits

- §3a suggested-fix comment says "mirrors reconciliation-sweep lines 577-597" — verified accurate, the pattern matches. But reconciliation-sweep's version *does* build a `supabase` client on the cron path (line 588: `supabase = createClient(...)`), whereas the proposal drops the binding entirely for refund-sweep. That's correct (refund-sweep uses `serviceSupabase` for all work, verified lines 209-247), but the "byte-for-byte same shape" claim in §3a is slightly overstated — refund-sweep's cron path is *simpler* than reconciliation's, not identical. Minor, but name it so the implementer doesn't paste reconciliation's version verbatim and reintroduce an unused binding.
- OQ3 (extract `_shared/cron-auth.ts:isCronCall`): given N1 (the env-read asymmetry is a live inconsistency between the two functions) and Rule 6 (extend, don't duplicate), the shared helper is now the *better* call, not a toss-up — it's the natural home to fix the env-name inconsistency once. Lean toward extracting.
- §6's `recon-oneoff-verify` uses `* * * * *` (every minute) then unschedules after ~90s. Fine, but if the unschedule step is forgotten (agent crash, session end), a per-minute job hammers the function indefinitely. Wrap the verify in a note: "unschedule is mandatory; if in doubt `SELECT cron.unschedule('recon-oneoff-verify')`."
- §7 tells John to find the `service_role` secret in Dashboard → Settings → API. Confirm this is still the current Supabase dashboard path (they've been migrating to "API Keys" / publishable+secret nomenclature); a stale path sends John hunting.

### Predicted pitfalls (if shipped as written)

1. **The migration throws on first apply because of the invalid `PERFORM ... WHERE EXISTS` idempotency block (B1), and the agent — expecting an idempotent no-op — assumes the extensions/GUC steps also failed and re-runs, compounding confusion.** This is the same class as the reconciliation proposal's Pitfall 1 (a layer added without verifying the receiving layer accepts it): the idempotency guard was written from memory of pg_cron's API without executing it against the live DB. The `cron.unschedule` overloads accept `(jobid bigint)` or `(jobname text)`, but neither works as a `PERFORM ... WHERE EXISTS` scalar. First apply = syntax error at line ~119, and the "re-applying yields exactly three jobs" guarantee is false because the block never parses.

2. **John pastes the service-role key into the GUC, the jobs fire, and every run 403s silently — because the GUC string ≠ the deployed `SUPABASE_SERVICE_ROLE_KEY` env (B3 + N1).** The symptom is indistinguishable from "cron not working": `job_run_details.status='succeeded'` (the SQL ran), the http_post fired, but the function returned 403 and did nothing. Nobody notices until a real stuck refund ages past 21 days and no email goes out — weeks later, exactly the failure T2-1 exists to prevent, now one layer deeper and harder to see because the cron job *looks* healthy. This is the highest-severity realistic outcome and the proposal's §6 verification is the only thing standing between it and production — which is why §6's money-safe force-run must be mandatory, not conditional.

3. **`CREATE EXTENSION pg_cron` succeeds but `cron.schedule(...)` in the same migration fails on a missing `cron` schema grant, leaving extensions enabled but zero jobs registered — a half-applied migration on a live money DB (N4 + Rule 0.5).** Because the whole thing is one migration, the agent sees a failure partway and has to reason about what landed vs. didn't (extensions created? jobs registered? GUC set?). This is the "recovery is multi-stage, not a single step" shape from Rule 0.5's prod-wipe post-mortem — a partial DDL apply on prod where the failure obscures the actual state. Splitting extensions-enable from job-registration (or toggling extensions via dashboard) removes the half-apply risk entirely.

4. **The register-before-key window (N2) spans a scheduled boundary and the next morning `cron.job_run_details` is full of `failed` rows with `ERROR 42704: unrecognized configuration parameter "app.service_role_key"`; a future agent debugging an unrelated issue sees them and burns time chasing a "broken cron" that was actually just the documented idle-fail window.** Verified live that the one-arg `current_setting` throws hard. The proposal accepts this noise as "a mild smell" — but on a money product where `job_run_details` is a diagnostic surface, deliberately seeding it with `failed` rows is a Rule-20 telemetry-hygiene cost. John-first ordering (N2 option a) makes the first-ever fire a clean success.

5. **The weekly bulk sweep (OQ4) fires its first Sunday 05:00 run, generates EasyPost Reports, and polls up to ~10 min inside the Edge Function — hitting the Edge Function wall-clock limit or an EasyPost rate/timeout on the heaviest job, landing partial state — the exact pitfall the *reconciliation decided proposal's own Review (Pitfall 4)* predicted for the sweep.** That prior review already flagged "sweep tries N synchronous operations → rate-limit/timeout → partial state → half-day fixup" and the author accepted a per-row-worker mitigation. Registering the weekly job now, before there's any live volume to justify it, re-exposes that documented pitfall for zero week-one benefit. Lean toward OQ4's stage-it alternative: register daily-recon + refund now, defer weekly until there's live volume — it's the lower-risk read of the decided plan, not a deviation from it.

### What the proposal got right

- **The central bug finding is real, precisely located, and correctly diagnosed.** Verified in source: `cron-refund-sweep:191-198` calls `requireAdmin` unconditionally; `auth.ts:61-88` resolves the JWT then requires a `profiles.role='admin'` row; a service-role principal has no such row → 403. The asymmetry with `reconciliation-sweep:577-597` (which HAS the bypass) is exactly as described. This is the finding that makes the proposal worth its weight — scheduling the job without this fix would have reproduced the silent-failure mode T2-1 targets.
- **The "the `supabase` binding from `requireAdmin` is unused downstream" claim is verified true.** `cron-refund-sweep` builds its own `serviceSupabase` (lines 209-211) and uses it for every DB read/write (lines 238+); the `requireAdmin`-returned `supabase` is genuinely dead on the cron path. Dropping it (§3a) is safe and correct.
- **The drift-restoration framing is honest and checks out end-to-end.** Schedules `0 4 * * *` / `0 5 * * 0` / `30 4 * * *` match migration 034's header, migration 035 Block 2, and handoff §H4/§H5 verbatim. The `net.http_post` body shape is a faithful copy of migration 035 Block 2. The proposal correctly notes the 034 cron boilerplate was referenced-but-never-committed and reconstructs it from 035's surviving template — I confirmed 034 contains only the Block-1 table, no Block-2 SQL. This is textbook "restoring a decided spec," not new design.
- **The money-movement guard for the refund force-run is sound.** §6's approach — query the stale-set (`refund_status='submitted' AND is_test=false AND refund_submitted_at < now()-21d AND easypost_shipment_id IS NOT NULL`) first, only force if count=0 — correctly mirrors the function's own fetch predicate (verified lines 238-247), so a count=0 force-run provably processes nothing. The instinct to never trigger real refunds during verification is exactly right for a live money product, and the "let the natural 04:30 schedule be the first real run if count>0" fallback is the honest answer.
- **Rule 0 is respected cleanly.** The migration sets only the non-secret `app.supabase_url`; §7 correctly quarantines `app.service_role_key` to John, never SELECTs the key value, and §6's verification checks key-presence via the two-arg `current_setting(..., true) IS NOT NULL` form (which I verified returns NULL-safely, not the throwing one-arg form). The secret boundary is drawn correctly.
- **The uncertainty is visible, not buried.** All four open questions name real tradeoffs the author couldn't resolve alone (extension-enable path, register-before-key ordering, helper extraction, weekly staging) — which is exactly what makes them findable and answerable in review. OQ2 in particular pointed straight at the `current_setting` throw behavior that a live-DB check then confirmed.

## Author response

Strong review — every finding verified against live DB and source, and B1 is a genuine bug I'd have hit on first apply. Accepting all three blockers and the material non-blockers. Per-point:

**B1 — invalid `PERFORM ... WHERE EXISTS` idempotency SQL. ✅ ACCEPT (real bug).** Rewrote each unschedule as `PERFORM cron.unschedule(jobname) FROM cron.job WHERE jobname = '<name>';` — a real SELECT-driven PERFORM that no-ops cleanly on zero rows. Migration 036 now has the corrected block; I verified it parses/applies against prod during execution (Phase 3).

**B2 — unexamined `verify_jwt` gateway layer. ✅ ACCEPT, with a ground-truth correction.** `config.toml` does say `verify_jwt = true` for both functions — BUT the **deployed** functions both show `verify_jwt: false` (confirmed via `list_edge_functions`: every function, including these two, is `"verify_jwt":false`). Deployed config governs at runtime (config.toml only re-applies on `functions deploy`/`db push`). So the gateway is permissive today and the in-code `isCronCall` branch is what actually gates — the cron path is not gateway-blocked. I've made the §6 reconciliation force-run a **required** post-apply step (not optional) as the end-to-end proof of the gateway+code+GUC chain, per your fix. (Note for future agents: if a `functions deploy` ever re-syncs `verify_jwt=true` from config.toml, the service-role JWT still clears the gateway — service-role/anon keys are the documented pass-through — so behavior is unchanged; but the force-run remains the real proof.)

**B3 — the GUC-must-equal-env invariant. ✅ ACCEPT.** Added to §7 (and the migration header) the explicit invariant: the `app.service_role_key` GUC John pastes must be byte-for-byte the deployed `SUPABASE_SERVICE_ROLE_KEY` secret. The confirmation-without-printing is the §6 force-run: `succeeded` = strings match; a 403 in `job_run_details`/function logs = GUC≠env (not a code bug). Stated so a future debugger reads the symptom correctly.

**N1 — env-var read asymmetry between the two sweeps. ✅ ACCEPT + OQ3 resolved.** This tipped OQ3 for me: extracted `_shared/cron-auth.ts` with `isCronCall(req)` + `getServiceRoleKey()` (honors both `SUPABASE_SERVICE_ROLE_KEY` and `SB_SERVICE_ROLE_KEY`). Both sweeps now import it, so the cron-path key read is **identical** in both — the asymmetry is gone (reconciliation previously read only `SUPABASE_SERVICE_ROLE_KEY`; it now reads via the shared helper). Rule 6: one definition, both call sites.

**N2 / pitfall 4 — register-before-key idle-fail noise. ✅ ACCEPT (partial).** I register the jobs during agent execution (I can't gate my whole run on John's secret step), so there is a window where a scheduled fire logs `failed` (ERROR 42704) until John sets the key. Mitigations: (a) I note this explicitly in the LOG so a future agent seeing those rows doesn't chase a ghost; (b) the window only spans a real boundary if John's step lags past the next 04:00/04:30 UTC — likely he sets it same-session. Full John-first ordering would zero the window but would leave the whole migration un-applied pending a secret step; I judged apply-now-note-the-noise the better handoff. Documented in §7 + LOG.

**N3 — migration-tracker 016→036 jump. ✅ ACCEPT.** The live tracker holds only 001-016 (017-035 went through the Dashboard SQL Editor). To avoid a misleading 016→036 tracker jump, I apply 036 the **same way 017-035 were applied** — as raw DDL via `execute_sql`, NOT `apply_migration` — so the tracker stays at its established 001-016 state and the LOG records the 017-036 gap as intentional. The repo migration file remains the source of record.

**N4 / pitfall 3 — half-apply risk (extension enable vs. cron.schedule grants). ✅ ACCEPT.** I execute in **stages**: (1) `CREATE EXTENSION pg_cron; CREATE EXTENSION pg_net;` alone, then (2) verify `cron.schedule` is callable (a probe), then (3) the GUC + job registration. If step 1's grants aren't wired, I stop before touching the schedule — no half-applied state. If `CREATE EXTENSION` needs the dashboard (grant issue), that becomes a John step with exact instructions.

**N5 — pg_net fire-and-forget; health check is downstream state. ✅ ACCEPT.** Added one line to §6/the migration header: the health signal is `recon_state.last_run_at` advancing (recon) / refund `event_logs` rows, **not** `job_run_details.status` (which only means the SQL ran). Ties to T1-3.

**OQ4 / pitfall 5 — stage the weekly bulk run. ✅ ACCEPT (self-decided — defer weekly).** You're right that the weekly job is the heaviest (Reports API + ~10 min in-function poll) and re-exposes the reconciliation proposal's own decided Pitfall 4 for zero week-one benefit (no live volume to reconcile). **Decision: register daily-recon + refund now; defer the weekly Sunday job to a one-line follow-up once live shipments accumulate.** Documented in the migration header with the exact `cron.schedule` to add. This is the lower-risk read of the decided plan, and adding it later is trivially reversible — well within my authority (a scheduling/ops call, not a design change). Not escalating to John.

**Nits:** ✅ all taken. §3a "byte-for-byte same shape" corrected — refund-sweep's cron path is *simpler* (no client binding) than reconciliation's; the shared helper makes the *decision* identical while each function keeps its own client needs. §6 `recon-oneoff-verify` — added the mandatory-unschedule note. §7 dashboard path — reworded to "Settings → API (or the newer API Keys view) → `service_role` secret" so a renamed dashboard tab doesn't send John hunting.

**Nothing escalated to John as an unresolved tradeoff** — all findings were either accept-and-fix or self-decidable technical/ops calls. John's only involvement remains the one irreducible secret step (§7, the `app.service_role_key` GUC).

## Decision

**Outcome: approve-with-changes — all three blockers + all five material non-blockers accepted and folded in; weekly-sweep staging self-decided (defer).** No John escalation needed. Implementation changes vs. the original plan: (1) corrected idempotency SQL (B1); (2) new `_shared/cron-auth.ts` shared by both sweeps, fixing the env-read asymmetry (N1/OQ3); (3) staged execution — extensions → probe → schedule — applied via `execute_sql` to preserve the migration tracker (N3/N4); (4) weekly job deferred (OQ4); (5) §6 reconciliation force-run made mandatory as the GUC↔env + gateway proof (B2/B3); (6) health-check-is-downstream-state noted (N5). Proceeding to Phase 3 execution on SendMo PROD.

### Execution-time amendment (2026-07-06) — GUC → Supabase Vault (forced by a hard permission wall)

During Phase 3 the GUC approach **failed on a permission constraint neither the migrations nor this proposal anticipated**: on this Supabase project the `postgres` MCP role is `rolsuper=off`, and **both** `ALTER DATABASE postgres SET app.supabase_url = …` **and** `ALTER ROLE postgres SET app.supabase_url = …` return `ERROR 42501: permission denied to set parameter "app.supabase_url"`. Setting custom `app.*` GUCs is superuser-gated and Supabase does not expose that — so the `current_setting('app.service_role_key')` scheme migrations 034/035 sketched is **not viable on this project, for the agent OR for John.**

The Supabase-canonical replacement (confirmed via `mcp__supabase__search_docs` → "Scheduling Edge Functions": *"To access the auth token securely… we recommend storing them in Supabase Vault"*) is **Supabase Vault**, already installed (`supabase_vault 0.3.1`). What actually shipped:
- `supabase_url` (non-secret) stored via `vault.create_secret(...)` by the agent — verified it decrypts back correctly.
- The two cron bodies read **both** values from `vault.decrypted_secrets` at fire time: `url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='supabase_url') || '/functions/v1/…'` and `'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='service_role_key')`. Confirmed `postgres` (the pg_cron worker role) has SELECT on `vault.decrypted_secrets`, so the job can decrypt at run time.
- **John's step changes accordingly** (§7 is superseded by this): instead of the GUC `ALTER`, John runs `SELECT vault.create_secret('<service-role-jwt>', 'service_role_key', 'pg_cron sweep auth (T2-1)');`. The B3 invariant is unchanged: that stored value must equal the deployed `SUPABASE_SERVICE_ROLE_KEY` function secret byte-for-byte, or `isCronCall` fails and the runs 403.

Everything else (staged extension enable, corrected idempotency SQL, both jobs registered + active, weekly deferred, the `_shared/cron-auth.ts` auth fix on both sweeps) shipped as decided. The repo migration `036_register_cron_sweeps.sql` was updated to the Vault form so it documents what actually ran. This is a forced technical correction (the GUC route is impossible here), not a design tradeoff — self-decided, no escalation.

### Takeover addendum (2026-07-06, second author session) — parallel-arc merge + two deltas

**What happened:** two sessions were dispatched onto T2-1 the same morning without knowing of each other. Both independently ran the full protocol arc (proposal → fresh-eyes review → decided, four sessions total) and **converged on the same central findings**: the `cron-refund-sweep` missing cron-bypass bug, the `_shared/cron-auth.ts` extraction, and Supabase Vault as the token store (this arc reached Vault empirically — the GUC is impossible, `42501`; the second arc reached it a priori — Vault is Supabase's current documented recommendation, enabled, empty, equal hand-off cost). The first arc executed against prod at 13:12–13:18 UTC (extensions, `supabase_url` secret, two jobs, both sweeps redeployed v12/v11); the second arc's owner discovered the concurrent state mid-execution, stopped before touching any of it, and John directed **"take over & finish."** The deployed implementation (this file's plan) is kept as canonical; the second arc's near-identical implementation was discarded unmerged. Its reviewed proposal survives in git history (branch `claude/heuristic-nash-d33ced`, commits `e20db38`/`ca958f0`) — notably its review independently predicted the `verify_jwt` CI-flip hazard and the three-copies-of-the-JWT rotation coupling.

**Two deltas the takeover adds (from the second arc's review):**
1. **`config.toml` pinned `verify_jwt = false` for both sweeps** (was `true`, drifted from deployed `false`). Without the pin, the next CI edge-function deploy (which fires on any `supabase/functions/**` change — including this very merge) would flip the gateway on two money-path functions. The service-role JWT would likely still pass a `verify_jwt=true` gateway (it's a validly-signed project JWT — the first arc's B2 note), but pinning to deployed reality removes the untested assumption and the 2026-05-10/11 drift-incident class. Post-merge deploy must re-check `list_edge_functions` still shows `verify_jwt:false` for both.
2. **The weekly bulk job IS registered** (`reconciliation-sweep-weekly`, `0 5 * * 0`, `{"mode":"weekly"}` — same Vault-read body). This overrides the first arc's self-decided defer-weekly (OQ4): **John made the call directly** ("take over & finish", explicitly including the weekly) when the takeover was surfaced. The defer rationale (heaviest job, ~10-min in-function poll vs Edge wall-clock, zero week-one volume) stands as a real risk and is WISHLIST-tracked: at current volume the weekly no-ops harmlessly and proves the path; if it starts timing out under real volume, unschedule it with one line and pick up the WISHLIST entry (async report-callback or chunked poll).

**Process note for future dispatches:** the duplicate arc cost roughly a full proposal+review cycle. Before starting a PRE-LAUNCH item, check prod state *and* `git branch -a` / main-repo untracked files for an in-flight sibling (this takeover was caught by an unexpected `cron.job` row count mid-execution — late, but before any conflicting write). The stale untracked draft copies of this proposal in the main checkout should be removed when the branches merge.
