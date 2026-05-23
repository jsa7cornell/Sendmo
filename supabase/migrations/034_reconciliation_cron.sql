-- =============================================================
-- Migration 034 — recon_state cursor table (Block 1)
--
-- H4 of the pre-launch P1 build.
-- Decided proposal:
--   proposals/2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_decided-2026-05-22.md
--   §2.3 (detection — dual path), §3 reconciliation-sweep Edge Function
-- Handoff:
--   proposals/2026-05-23_pre-launch-handoff-plan.md §Package H4
--
-- APPLY PROCESS (Supabase MCP is read-only on this project — same as 032/033):
--   Paste this SQL into the Dashboard SQL Editor.
--   Applied 2026-05-23 via Dashboard SQL Editor (post-verification:
--   recon_state_rows=2, both keys present).
--
-- WHAT THIS MIGRATION DOES:
--   Creates the recon_state cursor table the reconciliation-sweep Edge
--   Function reads/writes to track its position across runs. Seeds two
--   rows so the first sweep has a starting point.
--
-- CRON REGISTRATION — DEFERRED (NOT IN THIS MIGRATION):
--   The original H4 plan included pg_cron jobs (daily 04:00 UTC + weekly
--   05:00 UTC Sundays). Deferred to a fast-follow because:
--     (a) pg_cron + pg_net extensions are not enabled on this project today.
--     (b) Pre-launch traffic doesn't generate sweep work for the first week
--         (no live customer shipments yet), so the sweep can run manually.
--     (c) Cron registration also needs `app.supabase_url` + `app.service_role_key`
--         configured as Postgres GUCs (or service-role JWT in pg_net config).
--
--   To enable cron later:
--     1. Dashboard → Database → Extensions → enable pg_cron + pg_net
--     2. Set the URL/key Postgres settings (or use vault.secrets):
--          ALTER DATABASE postgres SET app.supabase_url   = 'https://fkxykvzsqdjzhurntgah.supabase.co';
--          ALTER DATABASE postgres SET app.service_role_key = '<service-role-jwt>';
--     3. Apply the cron-registration SQL in a follow-up migration. The
--        sketch lived in this file's earlier draft — see git history at the
--        H4 commit if you want the cron.schedule() boilerplate.
--
--   Until then: the sweep is admin-triggerable via the Reconciliation tab
--   or a direct POST to /functions/v1/reconciliation-sweep.
--
--   Tracked: WISHLIST → "Enable pg_cron + register reconciliation-sweep jobs."
-- =============================================================

-- ─── recon_state cursor table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.recon_state (
  key          TEXT PRIMARY KEY,
  last_run_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_cursor  TEXT,                     -- EasyPost pagination cursor (base64) when applicable
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.recon_state ENABLE ROW LEVEL SECURITY;
-- No RLS policies: only the service-role client (in the sweep Edge Function)
-- reads/writes this table. Service role bypasses RLS; everyone else is denied.

COMMENT ON TABLE public.recon_state IS
  'Cursor storage for the reconciliation-sweep Edge Function. One row per '
  'sweep mode (daily/weekly). last_run_at is the timestamp the previous '
  'successful run completed at — the next run lists EasyPost shipments + '
  'refunds created after this. last_cursor is reserved for pagination resume.';

-- ─── Seed initial cursors ────────────────────────────────────────────────────
-- Set the daily cursor to "1 day ago" and the weekly to "7 days ago" so the
-- first run has a sensible look-back window. ON CONFLICT keeps idempotency
-- if this migration is re-applied.
INSERT INTO public.recon_state (key, last_run_at) VALUES
  ('reconciliation_daily',  now() - interval '1 day'),
  ('reconciliation_weekly', now() - interval '7 days')
ON CONFLICT (key) DO NOTHING;

-- ─── Verification query ──────────────────────────────────────────────────────
-- Run after applying to confirm:
--
-- SELECT
--   (SELECT COUNT(*) FROM recon_state)                                AS recon_state_rows,
--   (SELECT key FROM recon_state WHERE key = 'reconciliation_daily')  AS daily_key,
--   (SELECT key FROM recon_state WHERE key = 'reconciliation_weekly') AS weekly_key;
--
-- Expected: recon_state_rows=2, both keys present.
