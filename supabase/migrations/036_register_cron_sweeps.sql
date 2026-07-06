-- =============================================================
-- Migration 036 — register the pg_cron sweeps (PRE-LAUNCH T2-1)
--
-- Restores the DEFERRED "Block 2" cron registration of migrations
-- 034 (reconciliation-sweep) + 035 (cron-refund-sweep). Those blocks
-- were left un-applied because pg_cron/pg_net weren't enabled on the
-- Free tier; T1-2 (Supabase Pro, 2026-07-04) unblocked this.
--
-- Decided proposals:
--   proposals/2026-07-06_register-cron-sweeps_reviewed-2026-07-06_decided-2026-07-06.md (this work)
--   proposals/2026-05-22_reconciliation-and-carrier-adjustments_..._decided-2026-05-22.md §3 (cadence)
--   proposals/2026-05-21_refund-system-implementation_..._decided-2026-05-22.md D3 (21-day threshold)
--   proposals/2026-05-23_pre-launch-handoff-plan.md §H4 (daily 04:00) + §H5 (04:30 offset)
--
-- Cadence (decided): reconciliation-sweep daily 04:00 UTC; cron-refund-sweep
-- daily 04:30 UTC (offset 30 min to avoid concurrent EasyPost list-load).
-- The weekly bulk reconciliation (Sundays 05:00 UTC) is DEFERRED per the
-- review (OQ4 / pitfall 5): heaviest job (EasyPost Reports + ~10 min in-function
-- poll), no live volume to justify it in week one. Add later as a one-liner:
--   SELECT cron.schedule('reconciliation-sweep-weekly','0 5 * * 0', <same body, {"mode":"weekly"}>);
--
-- ─── AUTH via Supabase Vault (NOT a GUC — see the amendment below) ────────────
-- The original 034/035 sketch used `current_setting('app.service_role_key')`
-- GUCs. That is IMPOSSIBLE on this project: the postgres role is rolsuper=off,
-- and both `ALTER DATABASE postgres SET app.*` and `ALTER ROLE postgres SET
-- app.*` return `ERROR 42501: permission denied to set parameter`. The
-- Supabase-canonical pattern (docs: "Scheduling Edge Functions") is
-- Supabase Vault. So the job bodies read from vault.decrypted_secrets:
--   * 'supabase_url'      — non-secret, stored by the agent (this migration).
--   * 'service_role_key'  — the service-role JWT, a SECRET, stored by John
--       (never by the agent, never printed — Rule 0):
--         SELECT vault.create_secret('<service-role-jwt>', 'service_role_key',
--                                    'pg_cron sweep auth (T2-1)');
--       It MUST equal the deployed SUPABASE_SERVICE_ROLE_KEY function secret
--       byte-for-byte, or the sweeps' isCronCall check fails and every run 403s
--       (review B3). Until John stores it, the subquery returns NULL → the
--       Authorization header is 'Bearer ' → the function 403s (idle-fail,
--       self-heals the moment the secret lands).
--
-- IDEMPOTENT: each job is unschedule-if-exists (a FROM-driven PERFORM that
-- no-ops on zero rows) then scheduled, so re-applying yields the same jobs.
--
-- APPLIED 2026-07-06 to SendMo PROD (fkxykvzsqdjzhurntgah) as raw DDL via the
-- write-capable Supabase MCP (execute_sql, NOT apply_migration) — to preserve
-- the established migration tracker state (001-016 registered; 017-035 were
-- applied via Dashboard SQL Editor and never recorded). See LOG 2026-07-06.
-- =============================================================

-- 1. Extensions (idempotent). Applied FIRST as a separate step so a
--    grant/availability failure can't leave a half-registered schedule.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 2. Non-secret value in Vault. (service_role_key is John's step — never here.)
--    Guarded so re-apply doesn't error on the UNIQUE name.
DO $seed_url$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'supabase_url') THEN
    PERFORM vault.create_secret(
      'https://fkxykvzsqdjzhurntgah.supabase.co',
      'supabase_url',
      'Project URL for pg_cron sweep net.http_post (T2-1, non-secret)'
    );
  END IF;
END
$seed_url$;

-- 3. Register the jobs (unschedule-if-exists -> schedule = idempotent).
--    PERFORM cron.unschedule(jobname) FROM cron.job WHERE ... is a real
--    SELECT-driven PERFORM that no-ops on zero rows. (The bare
--    `PERFORM cron.unschedule(...) WHERE EXISTS (...)` form is INVALID PL/pgSQL.)
DO $unsched$
BEGIN
  PERFORM cron.unschedule(jobname) FROM cron.job WHERE jobname = 'reconciliation-sweep-daily';
  PERFORM cron.unschedule(jobname) FROM cron.job WHERE jobname = 'refund-cron-sweep-daily';
END
$unsched$;

-- reconciliation-sweep — daily incremental (mode=daily), 04:00 UTC
SELECT cron.schedule(
  'reconciliation-sweep-daily',
  '0 4 * * *',
  $cron$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/reconciliation-sweep',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
        'Content-Type', 'application/json'
      ),
      body := '{"mode":"daily"}'::jsonb
    );
  $cron$
);

-- cron-refund-sweep — 21-day refund finalizer, daily 04:30 UTC
SELECT cron.schedule(
  'refund-cron-sweep-daily',
  '30 4 * * *',
  $cron$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/cron-refund-sweep',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    );
  $cron$
);

-- =============================================================
-- VERIFICATION (run after apply; John's Vault secret needed for jobs to
-- SUCCEED, not just register):
--   SELECT jobname, schedule, active FROM cron.job ORDER BY jobname;
--     -> reconciliation-sweep-daily | 0 4 * * *  | t
--        refund-cron-sweep-daily    | 30 4 * * * | t
--   SELECT extname FROM pg_extension WHERE extname IN ('pg_cron','pg_net');
--   SELECT name FROM vault.secrets WHERE name IN ('supabase_url','service_role_key');
-- Health check = downstream state advancing (recon_state.last_run_at ~ now
-- after a fire; refund event_logs rows), NOT job_run_details.status alone —
-- status='succeeded' only means the SQL ran, not that the HTTP call reached
-- the function (review N5).
-- =============================================================
