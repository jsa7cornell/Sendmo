-- =============================================================
-- Migration 035 — refund_cron_state + notifications_log dedup index
--
-- H5 of the pre-launch P1 build.
-- Decided proposals:
--   proposals/2026-05-21_refund-system-implementation_reviewed-2026-05-21_decided-2026-05-22.md
--     D3 (cron — 21-day threshold), D4 (terminal 'rejected'), D5 (three emails)
--   proposals/2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_decided-2026-05-22.md
--     D3 (full bundle is launch-blocking, including these three refund emails)
-- Handoff:
--   proposals/2026-05-23_pre-launch-handoff-plan.md §Package H5
--
-- =============================================================
-- APPLY PROCESS (Supabase MCP is read-only on this project):
--   Paste the BLOCK 1 SQL below (up to the BLOCK 2 marker) into the
--   Dashboard SQL Editor. Wait for John to confirm with the verification
--   query result before continuing.
--
-- VERIFICATION QUERY:
--   SELECT
--     (SELECT key FROM recon_state WHERE key = 'refund_sweep')    AS refund_sweep_key,
--     (SELECT last_run_at FROM recon_state WHERE key = 'refund_sweep') AS initial_cursor,
--     (SELECT COUNT(*) FROM pg_indexes
--      WHERE tablename = 'notifications_log'
--        AND indexname = 'idx_notifications_log_refund_dedup')     AS refund_dedup_index_exists;
--
-- Expected: refund_sweep_key='refund_sweep', initial_cursor ≈ (now - 21 days),
--           refund_dedup_index_exists=1.
-- =============================================================

-- ═══════════════════════════════════════════════════════════════
-- BLOCK 1 — Apply now (no pg_cron required)
-- ═══════════════════════════════════════════════════════════════

-- ─── A. Seed the refund_sweep cursor in recon_state ─────────────────────────
-- The 21-day initial cursor is intentional — the sweep looks for refunds
-- older than 21 days. Starting the cursor 21 days back means the first
-- run picks up any existing stale submitted-refunds immediately.
INSERT INTO public.recon_state (key, last_run_at) VALUES
  ('refund_sweep', now() - interval '21 days')
ON CONFLICT (key) DO NOTHING;

-- ─── B. Partial unique index for refund lifecycle email dedup ────────────────
-- The existing idx_notifications_log_idempotent is keyed on
-- (shipment_id, contact_id, event_type) — good for tracker-status emails
-- that flow through notification_contacts. Refund lifecycle emails send
-- directly via sendEmail() (no contact_id row), so we need a separate
-- dedup surface keyed on (shipment_id, event_type, provider_id).
--
-- provider_id stores:
--   Email A (refund.submitted):   stripe_payment_intent_id
--   Email B (refund.completed):   stripe_refund_id
--   Email C (refund.unsuccessful): stripe_payment_intent_id
--
-- The partial WHERE contact_id IS NULL ensures this index only covers
-- direct-send refund emails and doesn't interfere with the existing
-- contact-based dedup index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_log_refund_dedup
  ON public.notifications_log (shipment_id, event_type, provider_id)
  WHERE contact_id IS NULL AND provider_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════
-- BLOCK 2 — DEFERRED (pg_cron registration; do not apply yet)
-- ═══════════════════════════════════════════════════════════════
-- Run this AFTER enabling the pg_cron + pg_net extensions and
-- setting the Postgres GUCs (same enable-later steps as migration 034).
--
-- Enable-later steps:
--   1. Dashboard → Database → Extensions → enable pg_cron + pg_net
--   2. ALTER DATABASE postgres SET app.supabase_url   = 'https://fkxykvzsqdjzhurntgah.supabase.co';
--      ALTER DATABASE postgres SET app.service_role_key = '<service-role-jwt>';
--   3. Apply the cron.schedule() call below in a follow-up migration.
--
-- Cron registration (04:30 UTC daily — offset 30 min from H4's 04:00 UTC
-- reconciliation-sweep to avoid concurrent load when both sweeps are active):
--
-- SELECT cron.schedule(
--   'refund-cron-sweep-daily',
--   '30 4 * * *',
--   $$
--     SELECT net.http_post(
--       url := current_setting('app.supabase_url') || '/functions/v1/cron-refund-sweep',
--       headers := jsonb_build_object(
--         'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
--         'Content-Type', 'application/json'
--       ),
--       body := '{}'::jsonb
--     );
--   $$
-- );
--
-- Tracked: WISHLIST → "Enable pg_cron + register refund-cron-sweep job."
-- (This is the same fast-follow pattern as migration 034 Block 2.)
