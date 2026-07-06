---
title: Register the pg_cron sweeps (reconciliation + refund finalizer)
slug: register-cron-sweeps
project: sendmo
status: decided
created: 2026-07-06
last_updated: 2026-07-06 18:10
reviewed: 2026-07-06
decided: 2026-07-06
author: Claude (T2-1 owner session — cron registration end-to-end, worktree heuristic-nash-d33ced)
reviewer: Claude (fresh-eyes reviewer — verified fn/migration/MCP state, worktree heuristic-nash-d33ced)
outcome: approve-with-changes
---

## 1. Context

Two self-healing background sweeps were **built during the pre-launch P1 work and deployed as Edge Functions, but their pg_cron schedules were never registered** — the extensions weren't enabled on the Free tier, so the `cron.schedule()` calls in migrations 034/035 were deliberately left as commented "apply-later" blocks. Today both sweeps only run if an admin manually POSTs to them. This is PRE-LAUNCH item **T2-1**, unblocked by T1-2 (Supabase Pro, done 2026-07-04).

What the sweeps do, and why "never self-heals" is the risk if they stay manual:

- **`reconciliation-sweep`** — daily incremental list-and-diff of EasyPost shipments/refunds vs. SendMo's `shipments`/`transactions`, plus a weekly bulk CSV reconciliation. It also **re-fires `resolveRecovery` on carrier-adjustment rows stuck at `recovery_status='pending'`** (the N1 drift-detector). Without it, a carrier reweigh that the webhook missed, or a recovery that crashed mid-flight, sits unrecovered forever — SendMo silently eats the cost.
- **`cron-refund-sweep`** — the 21-day refund finalizer. Finds `refund_status='submitted'` shipments older than 21 days, polls EasyPost one last time, and terminates them (refunded / rejected / timeout) with the correct customer email. Without it, a refund whose `charge.refunded` webhook never arrived stays `submitted` forever — the customer's money is stuck in limbo and no email ever tells them.

This proposal is mostly **drift-restoration of a documented-but-unexecuted plan**: the schedules, offsets, and cron boilerplate were all decided in migrations 034/035 and the 2026-05-22 reconciliation proposal (see §8). It makes **two deliberate departures** from the 2026-05-24-era design, both flagged for the reviewer:

1. **A blocking bug fix** (§3a) — `cron-refund-sweep` has no cron-auth path and would 403 every scheduled run as-shipped.
2. **A secret-storage upgrade** (§9) — store the auth token in **Supabase Vault** (Supabase's current documented pattern, already enabled on this project) instead of the plaintext `app.service_role_key` GUC the migrations sketched in 2026-05. Equal hand-off cost for John, strictly better at-rest.

### 1.1 The one real bug (not a schedule question)

While tracing the invoke contract I found a **blocking bug in the deployed `cron-refund-sweep`**: it calls `requireAdmin(req)` unconditionally, with **no cron-auth-bypass branch**. `reconciliation-sweep` has one (`isCronCall = authHeader === "Bearer " + serviceRoleKey`, [`reconciliation-sweep/index.ts:584`](../supabase/functions/reconciliation-sweep/index.ts)); `cron-refund-sweep` does not — it goes straight to `requireAdmin` at [`cron-refund-sweep/index.ts:194`](../supabase/functions/cron-refund-sweep/index.ts).

`requireAdmin` ([`_shared/auth.ts:61`](../supabase/functions/_shared/auth.ts)) validates the Bearer via `supabase.auth.getUser(token)`, then looks up `profiles.role='admin'`. When pg_cron POSTs `Bearer <service_role_key>`, that token does **not** resolve to a user (the service-role key is a project-scoped JWT with no `sub` mapping to an `auth.users` row) → `getUser` returns an error → `requireAdmin` throws **401 "Invalid or expired token"** (and even if it resolved, there's no `profiles` row → 403). Either way: **if we schedule `cron-refund-sweep` as written today, every cron run is rejected and the sweep never executes** — exactly the silent-failure mode T2-1 exists to close, reproduced. This must be fixed *with* the cron registration, or we'd schedule a job that can't run.

The H5 handoff (§H5) said *"service role JWT for the pg_cron scheduled path,"* so the bypass was **intended** — reconciliation-sweep got it, refund-sweep didn't. The asymmetry went unnoticed because **neither sweep has ever been cron-invoked**. So §3a *restores intended H5 behavior*, it doesn't add a new capability.

## 2. Architecture

```
pg_cron (in Postgres)                        Edge Function                    Effect
─────────────────────                        ─────────────                    ──────
'reconciliation-sweep-daily'  0 4 * * *  ─┐
  net.http_post → /functions/v1/           ├─► reconciliation-sweep          daily diff + N1
  reconciliation-sweep  body {"mode":      │   (cron-bypass branch EXISTS)   recovery re-fire
  "daily"}                                 │
'reconciliation-sweep-weekly' 0 5 * * 0  ─┤                                   weekly bulk CSV
  body {"mode":"weekly"}                   │
                                          │
'refund-cron-sweep-daily'    30 4 * * * ─┘►  cron-refund-sweep               finalize stale
  net.http_post → /functions/v1/               (cron-bypass branch ADDED     'submitted' refunds
  cron-refund-sweep  body {}                    in §3a — was MISSING)

Auth header on every call:  Bearer <service_role_key, read from Vault at fire time>
URL:                        <project_url, read from Vault at fire time> || /functions/v1/<fn>
```

**Why the offsets:** reconciliation-daily 04:00 UTC, refund 04:30 UTC. Both hit the EasyPost list/GET API; running them 30 min apart avoids concurrent list-load (decided in migration 035's header + handoff §H5). Weekly bulk 05:00 UTC Sundays, after the daily finishes (migration 034's header). On a Sunday all three fire 04:00 / 04:30 / 05:00 — each 30 min apart, no overlap.

**Three schedules, not two:** `reconciliation-sweep` has two modes (`daily`/`weekly`) selected by request body — two `cron.schedule()` calls at the same function with different bodies. Plus the one refund schedule = **three cron jobs.**

**Auth token source:** every job reads the service-role JWT and the project URL from **Supabase Vault** (`vault.decrypted_secrets`) at fire time — never inlined into the stored job command. The pg_cron job runs as `postgres`, which is authorized to read `vault.decrypted_secrets`. See §9 for why Vault over the plaintext GUC the 2026-05 migrations sketched.

**Idempotency:** pg_cron 1.6.4 upserts `cron.schedule` by jobname (re-scheduling replaces), but the migration also wraps each in an explicit `unschedule`-if-exists → `schedule` so re-applying yields exactly three jobs, never duplicates.

## 3. File-by-file plan

### 3a. Fix `cron-refund-sweep` auth (BLOCKING PREREQUISITE) — `supabase/functions/cron-refund-sweep/index.ts`

Add the cron-bypass branch `reconciliation-sweep` already uses, before the `requireAdmin` call (~lines 191–198). Replace:

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

with (mirrors reconciliation-sweep — Rule 6, reuse the established shape):

```ts
  // ── Auth: called by pg_cron (service-role Bearer) OR manually by an admin ────
  const authHeader = req.headers.get("Authorization");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    || Deno.env.get("SB_SERVICE_ROLE_KEY") || "";
  const isCronCall = serviceRoleKey !== "" && authHeader === `Bearer ${serviceRoleKey}`;

  if (!isCronCall) {
    // Manual admin invocation — verify admin JWT (throws a Response on failure).
    try {
      await requireAdmin(req, corsHeaders);
    } catch (r) {
      if (r instanceof Response) return r;
      throw r;
    }
  }
```

`cron-refund-sweep` already builds a dedicated `serviceSupabase` client ([lines 208–211](../supabase/functions/cron-refund-sweep/index.ts)) for **all** its DB work and never uses the `supabase` binding `requireAdmin` returned — so dropping that binding is behavior-preserving. The admin path stays byte-for-byte identical; the cron path is newly *allowed* instead of rejected. This resolves the `let supabase` unused-binding cleanly (no `| undefined` gymnastics). See Open Question 3 on whether to extract a shared `isCronCall` helper.

### 3b. New migration — `supabase/migrations/036_register_cron_sweeps.sql`

Single idempotent migration: (a) enable extensions, (b) register all three jobs reading auth from Vault. It does **NOT** create the `service_role_key` Vault secret — that's John's one step (§7). The **public** `project_url` secret is seeded by the agent (it's not a secret; PLAYBOOK line 79). Shape:

```sql
-- Migration 036 — register pg_cron sweeps (PRE-LAUNCH T2-1)
-- Restores the DEFERRED Block 2 of migrations 034 + 035, with two departures:
--   (1) cron-refund-sweep auth-bypass fix ships alongside (see the fn change).
--   (2) auth token read from Supabase Vault, not a plaintext app.* GUC (§9).
-- Preconditions (see §7): vault secrets 'project_url' (agent-seeded) and
--   'service_role_key' (John-seeded) exist. Jobs registered before the key
--   exists sit idle-failing (401) until it lands — self-healing, no error.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Idempotent re-register: drop any prior instance of each job by name.
DO $$
BEGIN
  PERFORM cron.unschedule(jobname)
  FROM cron.job
  WHERE jobname IN ('reconciliation-sweep-daily','reconciliation-sweep-weekly','refund-cron-sweep-daily');
END $$;

SELECT cron.schedule('reconciliation-sweep-daily', '0 4 * * *', $CRON$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='project_url')
           || '/functions/v1/reconciliation-sweep',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='service_role_key'),
      'Content-Type', 'application/json'),
    body := '{"mode":"daily"}'::jsonb
  );
$CRON$);

SELECT cron.schedule('reconciliation-sweep-weekly', '0 5 * * 0', $CRON$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='project_url')
           || '/functions/v1/reconciliation-sweep',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='service_role_key'),
      'Content-Type', 'application/json'),
    body := '{"mode":"weekly"}'::jsonb
  );
$CRON$);

SELECT cron.schedule('refund-cron-sweep-daily', '30 4 * * *', $CRON$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='project_url')
           || '/functions/v1/cron-refund-sweep',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='service_role_key'),
      'Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$CRON$);
```

The `net.http_post` shape is the one from **Supabase's current "Scheduling Edge Functions" doc** (Vault subselect for the auth token) — which is also structurally identical to migration 035 Block 2 except the token comes from `vault.decrypted_secrets` instead of `current_setting('app.service_role_key')`. Because the file lands as `036_*.sql`, the enable-later comment blocks in 034/035 stay as historical provenance; a short "superseded by 036" note is added to each (docs-only).

**Fire-time read, not schedule-time:** the Vault subselects run when the job fires, so registering jobs before John seeds `service_role_key` is safe — until the key exists the subselect returns NULL, the `Authorization` header is null, the function replies 401, and the failure is logged in `cron.job_run_details`. It self-heals the moment the key lands. (`project_url` is agent-seeded first, so `url` is never NULL.)

### 3c. Docs

- Append the T2-1 execution note to `LOG.md` (Rule 17) with the exact SQL applied + target (Rule 0.5 — every prod write stated + logged).
- Flip PRE-LAUNCH T2-1 to `[~]` with the John-only remainder called out (then `[x]` after John's step + the safe force-run verify).
- Add this proposal to `proposals/README.md`.
- One-line "superseded by migration 036" note appended to the deferred blocks in 034/035.

## 4. Test / verification plan

No unit tests — this is infra/SQL plus a one-branch auth change on an Edge Function whose behavior is proven by the forced cron-shaped run (§6). The auth change is covered by: (a) `tsc -b`/deploy green; (b) the forced service-role POST in §6 returning **200 instead of 401**; (c) the safe reconciliation force-run advancing `recon_state`. The refund-sweep auth path is confirmed reachable *without moving money* by the stale-set guard in §6.

## 5. Out of scope

- **No change to sweep business logic** — only the auth gate on `cron-refund-sweep` + schedule registration.
- **Not forcing a money-moving refund run.** The refund sweep can fire real Stripe refunds (`createRefund(..., liveMode: true)`) on genuinely-stale live shipments. §6 verifies it's scheduled + auth-reachable **without** triggering money movement (query the stale-set first; only force if empty).
- **No `pg_net` response-handling / retry logic.** `net.http_post` is fire-and-forget; the sweeps are self-idempotent (cursor + dedup indexes), so a dropped response just means tomorrow's run picks up the slack.
- **No live-payment env-var flips.** Untouched.
- **The weekly sweep's ~10-min internal poll** (EasyPost Reports) can exceed the Edge Function wall-clock limit — a pre-existing property of the weekly `mode`, independent of scheduling it. Flagged in Open Question 4; not fixed here.

## 6. Verification (run after apply)

```sql
-- (1) All three jobs registered + active
SELECT jobname, schedule, active FROM cron.job ORDER BY jobname;
-- Expect: reconciliation-sweep-daily | 0 4 * * *  | t
--         reconciliation-sweep-weekly| 0 5 * * 0  | t
--         refund-cron-sweep-daily    | 30 4 * * * | t

-- (2) Extensions present
SELECT extname FROM pg_extension WHERE extname IN ('pg_cron','pg_net');

-- (3) Vault secrets present (names only — never SELECT decrypted values)
SELECT name FROM vault.secrets WHERE name IN ('project_url','service_role_key') ORDER BY name;
```

**Force one safe run** (reconciliation daily — read-heavy, no money) after John seeds the key:
```sql
SELECT cron.schedule('recon-oneoff-verify', '* * * * *', $CRON$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='project_url') || '/functions/v1/reconciliation-sweep',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='service_role_key'),
      'Content-Type', 'application/json'),
    body := '{"mode":"daily"}'::jsonb);
$CRON$);
-- wait ~90s, then:
SELECT jobname, status, return_message, start_time
  FROM cron.job_run_details WHERE jobname='recon-oneoff-verify'
  ORDER BY start_time DESC LIMIT 3;
SELECT key, last_run_at FROM recon_state WHERE key='reconciliation_daily'; -- should advance to ~now
SELECT event_type, created_at FROM event_logs
  WHERE event_type IN ('recon.sweep_started','recon.sweep_completed')
    AND created_at > now() - interval '5 minutes' ORDER BY created_at DESC;
SELECT cron.unschedule('recon-oneoff-verify');
```
`status='succeeded'` + `recon_state.reconciliation_daily.last_run_at` at ~now + the two `recon.sweep_*` event rows confirm the whole chain: cron → net.http_post → Vault-authenticated call → function ran → wrote state.

**Refund sweep — prove reachability without moving money.** First check whether forcing it could refund anything:
```sql
SELECT count(*) FROM shipments
 WHERE refund_status='submitted' AND is_test=false
   AND refund_submitted_at < now() - interval '21 days'
   AND easypost_shipment_id IS NOT NULL;
```
If **0** (expected at launch — no live refunds are stale yet), force it via the same one-off-schedule dance against `cron-refund-sweep` with `body {}`; expect `status='succeeded'` and a `cron_refund_sweep.completed` event with all-zero `results`, confirming the §3a auth fix works end-to-end. If **>0**, do **not** force it — those are real stale live refunds it would finalize. In that case let the natural 04:30 schedule be the first real run and confirm the next morning via `cron.job_run_details` + `event_logs`.

## 7. John-only step (secret — Rule 0)

The service-role JWT is a secret; the agent never sets, types, reads, or prints it. **John runs exactly one statement**, once, in Supabase Dashboard → SQL Editor:

```sql
-- Stores the service-role JWT encrypted in Supabase Vault. Run once.
SELECT vault.create_secret('<service-role-jwt>', 'service_role_key');
```

Where to get `<service-role-jwt>`: Dashboard → Project `fkxykvzsqdjzhurntgah` → **Settings → API → `service_role` secret** (the `service_role` key, NOT `anon`/publishable). Paste it between the quotes. **Do not paste it into this chat.**

Everything else — enabling the extensions, seeding the public `project_url` Vault secret, deploying the auth fix, applying migration 036, and the safe verification run — is done by the agent. After John's one statement, the three already-registered jobs authenticate on their next fire (and the agent's safe force-run confirms it immediately).

> If a value ever needs updating (service-role key rotation), it's `SELECT vault.update_secret((SELECT id FROM vault.secrets WHERE name='service_role_key'), '<new-jwt>');` — and note the coupling in §9.1.

## 8. Reconciliation with prior decided proposals

This proposal **restores deferred work** and makes the two departures named in §1. Sources:

- **Migration 034** (`034_reconciliation_cron.sql`) header, lines 21–42: defers the reconciliation cron, names the enable-later steps and the exact cadence **"daily 04:00 UTC + weekly 05:00 UTC Sundays."** My `0 4 * * *` + `0 5 * * 0` match verbatim. The header says the `cron.schedule()` boilerplate "lived in this file's earlier draft — see git history at the H4 commit"; I checked (`git log --all -p -S cron.schedule -- supabase/migrations/034*`) — it was **never committed**, only referenced. Reconstructed fresh from 035 Block 2's surviving template.
- **Migration 035** (`035_refund_cron_state.sql`) Block 2, lines 62–93: the `cron.schedule('refund-cron-sweep-daily','30 4 * * *', …)` call written out in full, with the 04:30-vs-04:00 offset rationale. Jobname, schedule, and `body {}` preserved verbatim; **only the token source changes** (Vault vs the GUC that block sketched) — §9.
- **Decided `2026-05-22_reconciliation-and-carrier-adjustments_…_decided-2026-05-22.md`** §3 (dual daily/weekly sweep) + N1 (drift re-fire) — the logic these schedules drive.
- **Decided `2026-05-21_refund-system-implementation_…_decided-2026-05-22.md`** D3 (21-day threshold) — the refund sweep's terminal-timeout policy the schedule enforces.
- **`2026-05-23_pre-launch-handoff-plan.md`** §H4 + §H5 — packaged both as fast-follows; §H5 explicitly says "service role JWT for the pg_cron scheduled path" (the intent §3a restores).
- **LOG 2026-05-24 "Pre-launch P1 wrap-up"** — documents both sweeps as built-but-manual with explicit enable-later intent.

**Genuinely new (scrutinize these):** (1) the `cron-refund-sweep` auth-bypass fix (§3a — latent bug, not in any prior proposal); (2) the Vault-over-GUC secret storage (§9 — a departure from the migrations' sketched `app.service_role_key` GUC, justified below).

## 9. Secret storage: Supabase Vault vs the plaintext `app.service_role_key` GUC

The 2026-05 migrations (034/035) sketched the token as a Postgres GUC: `ALTER DATABASE postgres SET app.service_role_key = '<jwt>'`, read at fire time via `current_setting('app.service_role_key')`. That was the common pattern at the time. This proposal instead uses **Supabase Vault**. Why:

| Axis | Plaintext GUC (`app.service_role_key`) | Supabase Vault (recommended) |
|---|---|---|
| **At-rest** | Stored **plaintext** in the catalog (`pg_db_role_setting`). Appears in `pg_dump`, logical backups, and the Dashboard's DB settings. | Stored **encrypted** (authenticated encryption, key held outside the table). `pg_dump` of the secrets table yields ciphertext. |
| **Exposure** | Any SQL session on the DB can `SHOW app.service_role_key` / `current_setting(...)`. | `vault.decrypted_secrets` is readable only by `postgres`/`service_role`; `anon`/`authenticated` are denied. |
| **Supabase's current guidance** | Pre-dates the Vault recommendation. | Supabase's live "Scheduling Edge Functions" doc says, verbatim: *"To access the auth token securely for your Edge Function call, we recommend storing them in Supabase Vault."* |
| **John's hand-off cost** | One secret-bearing statement (`ALTER DATABASE … SET …`). | One secret-bearing statement (`vault.create_secret(…)`). **Identical.** |
| **Availability today** | Would need the GUC set. | `supabase_vault` **already enabled** (v0.3.1) on this project, **zero secrets stored** — clean slate (verified via MCP `list_extensions` + `vault.secrets`). |

**Recommendation: Vault.** It's strictly better on every security axis at *identical* hand-off cost for John, it's Supabase's current documented recommendation, and it's already enabled. This is precisely the kind of "the world moved since the plan was written" call review exists to ratify. The plaintext GUC still works and is the smaller diff from the literal migrations — so if the reviewer or John prefers minimal deviation, the **GUC fallback is fully specified in §9.2** and swapping back is mechanical (change the three subselects to `current_setting('app.service_role_key')` and change John's step to two `ALTER DATABASE` statements). I don't consider this worth blocking on either way — but Vault is the better default and I've built the plan around it.

### 9.1 Coupling to note (either pattern)

The cron job's Bearer must equal the `SUPABASE_SERVICE_ROLE_KEY` env var the Edge Functions compare against (that's how the `isCronCall` check matches). If the service-role key is ever **rotated**, *both* the Vault secret (or GUC) **and** the functions' env var must be updated together, or the cron calls start 401'ing. This is inherent to the "service-role Bearer = cron identity" model both sweeps already use — not introduced here — but worth stating so a future rotation doesn't silently break self-healing.

### 9.2 GUC fallback (only if Vault is rejected in review)

John's step becomes two statements (one secret):
```sql
ALTER DATABASE postgres SET app.supabase_url    = 'https://fkxykvzsqdjzhurntgah.supabase.co';  -- public
ALTER DATABASE postgres SET app.service_role_key = '<service-role-jwt>';                         -- secret
```
and the three `cron.schedule` bodies swap the Vault subselects for `current_setting('app.supabase_url')` / `current_setting('app.service_role_key')` — i.e. migration 035 Block 2 verbatim. One caveat: `current_setting('app.service_role_key')` (1-arg) **errors** if the GUC is unset, so with the GUC pattern the jobs must be registered *after* John's step (not idle-fail-friendly like Vault's NULL subselect). Net: Vault also gives a cleaner apply-before-John-step ordering.

## Open questions (for the reviewer)

1. **Vault vs GUC (§9)** — I recommend Vault (enabled, empty, Supabase-recommended, equal hand-off cost, cleaner idle-fail). The counter-argument is "the migrations wrote the GUC; minimize deviation." Do you agree Vault is the right default, or should we ship the literal GUC the migrations sketched? *(This is the one place I've departed from the decided artifacts on purpose — the highest-value thing to sanity-check.)*
2. **Agent-applies `CREATE EXTENSION pg_cron/pg_net` via the write-capable MCP, or John-in-dashboard?** The MCP runs as `postgres` (verified) and Supabase whitelists these extensions for that role, so `apply_migration` should succeed and is idempotent/reversible (`DROP EXTENSION`). I lean agent-applies (that's the point of the write-capable MCP). Flagging because enabling extensions is heavier-than-usual DDL on live prod.
3. **The auth fix — minimal inline branch, or extract `_shared/cron-auth.ts:isCronCall(req)`** used by both sweeps (Rule 6)? The `authHeader === "Bearer " + serviceRoleKey` check (with the empty-key guard that matters) is now duplicated in two money-adjacent functions. I lean extract, but it's a slightly larger diff touching reconciliation-sweep too. Reviewer's call on whether the abstraction earns its keep now vs. a follow-up.
4. **Schedule the weekly bulk run in week one?** `mode=weekly` generates EasyPost Reports and polls up to ~10 min inside the function — the heaviest job, and its poll can exceed the Edge Function wall-clock limit (a pre-existing property, §5). With near-zero live volume it mostly no-ops. I lean **register all three now** (decided plan; a no-op weekly proves the path), but a reviewer might argue for staging weekly until there's live volume — and might want the wall-clock-timeout risk tracked to WISHLIST regardless.

---

## Review

> **reviewer:** Claude (fresh-eyes reviewer session — verified the Edge Functions, migrations 034/035, config.toml, deployed function state + extensions via the read-only Supabase MCP; worktree heuristic-nash-d33ced)
> **reviewed_at:** 2026-07-06 17:40
> **verdict:** approve-with-changes

### Summary

This is a strong, honest proposal. Every load-bearing claim I could check held up against the code: the `cron-refund-sweep` auth bug is real (line 194 calls `requireAdmin` unconditionally, no cron branch), `requireAdmin` does throw 401 on a service-role JWT (`auth.ts:62` — `getUser` returns an error before the profile lookup), the `serviceSupabase` client is built independently (line 209) so dropping the `requireAdmin`-returned `supabase` binding typechecks and is behavior-preserving, the reconciliation-sweep bypass at lines 584/586-597 is exactly what §3a mirrors, and `cron.schedule` was genuinely never committed in 034 (git log confirms). Vault v0.3.1 is installed with zero secrets, and pg_cron 1.6.4 / pg_net 0.19.5 are available-but-not-installed — all as stated. The Vault-over-GUC call is argued fairly and I agree with it. Two things keep this at approve-with-changes rather than approve: **(1) a config/deployed-state drift the proposal doesn't mention** — both sweeps are deployed with `verify_jwt: false` but config.toml declares `verify_jwt = true`, and the apply path could silently flip the gateway; and **(2) a service-role-key env-var-name asymmetry** between the §3a snippet and the reconciliation-sweep it mirrors, which under one env-var configuration would make the two functions disagree about what counts as a cron call. Neither is hard to fix; both should be nailed down before applying.

### Blocking issues

**B1 — `verify_jwt` config/deployed-state drift is unaddressed, and the apply path can flip the gateway.**
- **Location:** `supabase/config.toml:163-165` (reconciliation-sweep) + `:180-182` (cron-refund-sweep) say `verify_jwt = true`; the **deployed** functions are both `verify_jwt: false` (confirmed via MCP `list_edge_functions` — `reconciliation-sweep` v11 and `cron-refund-sweep` v10 both `"verify_jwt":false`). The proposal deploys the §3a auth fix to `cron-refund-sweep` but never states which `verify_jwt` value the deploy will land.
- **Why it matters:** This is the exact failure class the config.toml header comments memorialize (the 2026-05-10 place-details + 2026-05-11 links `verify_jwt` regressions). Two independent risks: **(a)** if the fix is deployed via `supabase functions deploy cron-refund-sweep` *with* config.toml in effect, the gateway flips to `verify_jwt: true`. A raw service-role JWT still passes the gateway (it's a validly-signed project JWT), so the cron path likely still works — but this is an untested gateway-behavior assumption the proposal leans on implicitly and never states. **(b)** More concerning: the CI deploy workflow ("Deploy Supabase Edge Functions", per PLAYBOOK Rule 21) fires on any `supabase/functions/**` change. Editing `cron-refund-sweep/index.ts` will trigger a redeploy of that function through CI — which reads config.toml — so the flip to `verify_jwt: true` happens whether or not the agent runs a manual deploy. The proposal's §4 says "deploy green" is the test, but green ≠ verify_jwt-unchanged.
- **Suggested fix:** State the intended end state explicitly. Recommended: set `config.toml` to `verify_jwt = false` for both sweeps to match deployed reality (the function's own `requireAdmin` / `isCronCall` is the real gate — the gateway JWT check is redundant and, at `true`, is one more thing that must accept the service-role JWT). Then the §6 verification must include a **post-deploy re-check** that `list_edge_functions` still shows `verify_jwt: false` for both — not just `cron.job_run_details` status. If instead the intent is to keep `true`, the proposal must (a) say so and (b) add a verification step proving a raw service-role Bearer passes the gateway at `verify_jwt: true` before relying on it for the money-path refund sweep.

**B2 — service-role-key env-var-name asymmetry between §3a and the function it mirrors.**
- **Location:** Proposal §3a snippet (lines 87-89) reads `Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SB_SERVICE_ROLE_KEY")`. The reconciliation-sweep it mirrors reads **only** `Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""` (`reconciliation-sweep/index.ts:580`). Separately, reconciliation-sweep builds its cron client from `SUPABASE_URL` only (`:581`), while the proposal's cron-refund-sweep already reads `SUPABASE_URL || VITE_SUPABASE_URL` (`cron-refund-sweep/index.ts:200`).
- **Why it matters:** The whole cron-auth model (correctly called out in §9.1) is that the Bearer the job sends must byte-equal the key each function compares against. If the deployed secret is exposed under `SB_SERVICE_ROLE_KEY` but **not** `SUPABASE_SERVICE_ROLE_KEY` (or vice-versa), the two functions would compute `isCronCall` against *different* strings from the *same* incoming Bearer — one accepts the cron call, the other 401s it. Today both sweeps happen to use `SUPABASE_SERVICE_ROLE_KEY`, and the Vault secret John seeds is a third independent copy of the same JWT — so there are now **three** places the same value must agree (Vault secret, reconciliation-sweep's env lookup, cron-refund-sweep's env lookup). Adding a differing fallback to only one of them widens the surface for a silent mismatch.
- **Suggested fix:** Make the §3a `serviceRoleKey` lookup **identical** to reconciliation-sweep's (`Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""`), dropping the `SB_SERVICE_ROLE_KEY` fallback — or, if the `SB_` fallback is deliberate, add it to reconciliation-sweep too *in the same change* so the two money-adjacent functions can never disagree. This also strengthens the case for OQ3 (extract `_shared/cron-auth.ts:isCronCall`): a single shared helper makes divergence structurally impossible, which for two money-path auth gates is worth the slightly larger diff. I lean **extract** — see Non-blocking N1.

### Non-blocking concerns

**N1 (OQ3) — extract the shared `isCronCall` helper now, don't defer.** B2 is a live illustration of why: the check is already drifting between two copies before it's even shipped. Rule 6 favors extending an established shape, and a `_shared/cron-auth.ts` that both sweeps import removes the "three copies must agree" fragility from the code side (the Vault copy is unavoidable). The diff touches reconciliation-sweep, but it's a pure substitution of an already-proven expression. This is the higher-leverage version of the fix for B2.

**N2 (OQ4) — I agree with registering all three now, but track the weekly wall-clock risk explicitly.** Confirmed the weekly poll is `maxAttempts = 20 × 30s = 10 min` (`reconciliation-sweep/index.ts:397, 401-402`). Supabase Edge Functions have a wall-clock ceiling (CPU/wall limits; the platform default request timeout is well under 10 min for synchronous responses on many plans). Because `net.http_post` is fire-and-forget (§5), a killed weekly run doesn't corrupt state — but it *will* update the weekly cursor only if it reaches line 552, so a timeout mid-poll means the cursor doesn't advance and the next weekly run re-scans the same window (safe, idempotent, but the report generation is wasted). Registering it is fine; add a one-line WISHLIST entry for "weekly sweep may exceed Edge wall-clock — convert to async report-callback or chunk the poll" so it isn't rediscovered under load.

**N3 — the one-off verify job (`recon-oneoff-verify`, §6) queries `cron.job_run_details` by `jobname`, but that column may be `jobid`-keyed.** In pg_cron, `cron.job_run_details` has a `jobid` column and (in 1.6.x) also `jobname`. Worth confirming the `WHERE jobname='recon-oneoff-verify'` filter returns rows on 1.6.4 before relying on it as the pass/fail signal; if not, join `cron.job` on `jobid`. Cheap to verify at run time, but if it silently returns zero rows the verifier reads as "job never ran" when it did.

**N4 — no cleanup path if the `recon-oneoff-verify` unschedule (§6 last line) is never reached.** If the agent's session ends or errors between scheduling the `* * * * *` one-off and the final `cron.unschedule`, the verify job keeps firing every minute against the real reconciliation-sweep (harmless-ish — read-heavy, advances the daily cursor repeatedly) until someone notices. Consider scheduling it, forcing one run, and unscheduling in the *same* SQL batch, or set it to a far-future single-shot rather than `* * * * *`.

### Nits

- **§3b migration comment vs. reality:** the header says "Jobs registered before the key exists sit idle-failing (401)." With Vault's NULL-subselect path the `Authorization` header value becomes `Bearer ` + NULL = SQL NULL, so `jsonb_build_object` yields a JSON null for that header. Worth confirming pg_net sends *no* Authorization header (→ gateway/function 401) rather than a literal `"null"` string or erroring in `jsonb_build_object` — the self-healing claim rests on it. Behaviorally still non-catastrophic, but the "clean 401" wording is an assumption, not verified.
- **§8 says migration 035 Block 2 is "preserved verbatim … only the token source changes"** — accurate, but Block 2 also uses `current_setting('app.supabase_url')` for the URL, and 036 swaps *both* url and token to Vault subselects. Minor: "only the token source changes" undersells that the URL source changes too (harmless — `project_url` is public/agent-seeded).
- **PRE-LAUNCH T2-1 step 2** still documents the GUC (`ALTER DATABASE … SET app.service_role_key`), which 036 supersedes with Vault. When flipping T2-1 to `[~]` (§3c), update that step text too, or a future reader follows the stale GUC instructions.

### Predicted pitfalls (what's most likely to go wrong)

1. **The CI edge-function redeploy silently flips `cron-refund-sweep` to `verify_jwt: true` (B1).** Highest-probability failure. The moment `cron-refund-sweep/index.ts` lands on `main`, the "Deploy Supabase Edge Functions" workflow redeploys it through config.toml (`verify_jwt = true`). This is the *same* config-drift class as the 2026-05-10/05-11 incidents the config.toml comments were written to prevent. Best case the service-role JWT still passes the gateway and nothing breaks; worst case a gateway-level rejection means the refund sweep 401s on every fire and *the exact silent-self-heal-failure T2-1 exists to close is reproduced* — now one layer deeper (gateway, not function), so `cron.job_run_details` shows a 401 with no function log to explain it. Mitigation: pin `verify_jwt = false` in config.toml and re-check deployed state post-deploy.

2. **Three-way key divergence bites on the first real refund run (B2 + §9.1).** The same service-role JWT now lives in the Vault secret, reconciliation-sweep's env lookup, and cron-refund-sweep's env lookup — and after B2 the two env lookups don't even use the same variable names. A future service-role key rotation (or an env set under `SB_*` on one function only) updates some-but-not-all copies. The reconciliation sweep keeps working while the refund sweep 401s (or vice-versa), and because both are silent background jobs nobody notices until a customer's refund sits in limbo past 21 days — precisely the money-in-limbo failure §1 describes. This is a recurrence of the "self-healing job that silently stops self-healing" pattern.

3. **The weekly sweep times out mid-poll under real volume and never advances its cursor (N2).** At launch it no-ops, so it looks healthy in week one — the dangerous kind of green. Once live shipment volume makes the EasyPost Report take real time, the 10-minute internal poll collides with the Edge wall-clock ceiling. pg_net fire-and-forget means the cron row may even read `succeeded` (the POST was accepted) while the function was killed — so `cron.job_run_details` lies about success. The weekly reconciliation quietly stops producing ground-truth CSV diffs exactly when volume makes them matter most. Track it now (N2) so it's a known limitation, not a future incident.

4. **The one-off verify job outlives the session and pollutes the daily cursor (N3 + N4).** If `cron.unschedule('recon-oneoff-verify')` is never reached, a `* * * * *` job hammers reconciliation-sweep every minute, advancing `recon_state.reconciliation_daily.last_run_at` far past where the real daily job expects it — so the next legit daily sweep looks back over a near-empty window and may miss a diff. Low-severity but a real correctness footgun in the verification procedure itself.

### What the proposal got right

- **The bug find is real and correctly diagnosed.** `requireAdmin` unconditional at `cron-refund-sweep/index.ts:194`, no cron branch; the 401 (not 403) path via `getUser` failing at `auth.ts:62` before the profile lookup; `serviceSupabase` built separately at line 209 and the `requireAdmin`-returned binding genuinely unused downstream. All verified. Catching this *now* — before scheduling a job that would 401 forever — is exactly the point of the review-before-apply discipline.
- **Framed as drift-restoration, not a new feature, with the prior decisions cited by section.** §8 correctly names 034/035 + the two decided proposals + H5's "service role JWT for the pg_cron scheduled path" as the intent §3a restores. This is the load-bearing-institutional-memory framing the protocol asks for, done well.
- **The Vault-over-GUC call is honest and correct.** The tradeoff table doesn't oversell (equal hand-off cost is stated plainly, not spun), the GUC fallback is fully specified in §9.2 so the departure is reversible, and the "world moved since the plan was written" reasoning is sound. I agree Vault is the right default — enabled, empty, encrypted-at-rest, and the NULL-subselect gives the cleaner idle-fail ordering. No disagreement here.
- **Money-safety in the verification plan.** §6's "query the stale-set first; only force the refund sweep if it's empty" is exactly right — it proves the §3a auth fix end-to-end without risking a real Stripe refund on a genuinely-stale live shipment. The `liveMode: true` awareness (§5) shows the author understood the blast radius.
- **Idempotency is handled at every layer** — the `unschedule`-if-exists DO block, the `ON CONFLICT DO NOTHING` cursor seeds, the fire-and-forget + self-idempotent-cursor argument for skipping pg_net retry logic. Re-applying 036 yields exactly three jobs.
- **Plainspoken and self-standing**, with the architecture diagram leading §2 and concrete file:line refs throughout — meets the house-style bar.

## Author response

Strong review — it caught a real drift the draft missed (B1) and made a persuasive case that flipped my lean on OQ3. Accepting effectively everything; no point goes to John (he pre-authorized the arc and there's no design disagreement).

- **B1 (verify_jwt drift) — ✅ accept.** Pinning `verify_jwt = false` in `config.toml` for **both** `[functions.reconciliation-sweep]` and `[functions.cron-refund-sweep]` to match deployed reality. The function's own `requireAdmin`/`isCronCall` is the real gate; the gateway JWT check is redundant, and at `true` it's one more thing that must accept the service-role JWT on a money path. Adding a **post-deploy `list_edge_functions` re-check** that both remain `verify_jwt: false` to the verification steps (not just "deploy green"). This is exactly the 2026-05-10/05-11 config-drift class — good catch.
- **B2 (env-var asymmetry) — ✅ accept, resolved via N1.** Rather than align the two inline copies, I'm extracting the shared helper (below), so both functions read the service-role key through one definition (`SUPABASE_SERVICE_ROLE_KEY` only, matching reconciliation-sweep). The `SB_SERVICE_ROLE_KEY` fallback in the draft snippet is dropped — the three-way agreement (Vault secret ↔ both env lookups) now has one code-side source, not two drifting ones.
- **N1 / OQ3 (extract `_shared/cron-auth.ts:isCronCall`) — ✅ accept (reversing my draft lean).** My §3a leaned inline-minimal to keep the money-path diff small. The reviewer's point wins: the check *already* drifted between two copies before shipping (that's B2), and a shared helper makes divergence structurally impossible — which for two background money-path auth gates is worth the marginally larger diff. The refactor touching reconciliation-sweep is a pure substitution of an already-proven boolean expression, and the new import is a **local** `_shared/` file (no esm.sh/CDN dependency, so no import-resilience exposure). Rule 6 favors the shared shape. Implementing `isCronCall(req)` and calling it from both sweeps.
- **N2 / OQ4 (register all three; track weekly wall-clock) — ✅ accept.** Registering all three now (decided plan; a no-op weekly proves the path). Adding a WISHLIST entry: *"reconciliation-sweep weekly mode may exceed Edge wall-clock under real volume — convert to async report-callback or chunk the 10-min poll; fire-and-forget means cron.job_run_details can read 'succeeded' while the function was killed."*
- **N3 (job_run_details schema) + N4 (orphaned one-off) — ✅ accept, verification redesigned.** Dropping the `* * * * *` one-off-cron dance entirely. Verification now issues a **single one-shot `SELECT net.http_post(...)`** against reconciliation-sweep (same Vault-authenticated path a real cron fire uses), then reads `net._http_response` (status_code=200) + `event_logs` (`recon.sweep_*`) + `recon_state.last_run_at`. No lingering job to orphan (N4 gone), and no dependency on `cron.job_run_details`'s `jobname` column (N3 gone). The scheduled jobs themselves are verified structurally via `SELECT ... FROM cron.job`.
- **Nits — ✅ accept.** (a) PRE-LAUNCH T2-1 step 2 still documents the `ALTER DATABASE … SET app.service_role_key` GUC — updating it to the Vault `create_secret` step when flipping status, so no future reader follows stale instructions. (b) §8 "only the token source changes" undersells that 036 moves the URL to a Vault subselect too — noted; harmless (`project_url` is public/agent-seeded). (c) The migration's "idle-failing (401)" wording rests on pg_net sending no/blank Authorization when the Vault subselect is NULL — I'll confirm empirically in the register-before-John's-secret window (the first fires will show status in `net._http_response`); non-catastrophic either way.
- **OQ1 (Vault) / OQ2 (agent enables extensions) — reviewer concurred.** Proceeding: Vault is the token store; the agent applies `CREATE EXTENSION` via the write-capable MCP (postgres role, verified; idempotent + reversible).

**Net delta from the reviewed draft:** (1) new `_shared/cron-auth.ts`; (2) both sweeps use it (reconciliation-sweep = pure refactor); (3) `config.toml` verify_jwt pinned false ×2; (4) verification is one-shot `net.http_post`, not a `* * * * *` cron; (5) WISHLIST weekly-wall-clock entry; (6) PRE-LAUNCH step-2 text → Vault. No change to schedules, offsets, the Vault decision, or the register-all-three call.

## Decision

**Decided 2026-07-06 — approve-with-changes, on John's standing pre-authorization for the T2-1 arc** (write → fresh-eyes review → execute without another round-trip, pausing only for a genuine reviewer-vs-author disagreement or a step that requires John). The review surfaced no design disagreement — the reviewer explicitly agreed with both deliberate departures (Vault-over-GUC, register-all-three) — so no tie-break is needed and the author-response changes above are folded in directly.

The one genuinely John-gated step remains outstanding as a **hand-off, not a blocker to the rest**: seeding the `service_role_key` Vault secret (§7, Rule 0 — the agent never handles the JWT). Everything else (extension enable, public `project_url` secret, the auth-fix deploy, migration 036, and the money-safe verification) is executed by the agent; the jobs sit registered-and-idle until John runs his one statement, then self-authenticate on the next fire. Implementation begins.
