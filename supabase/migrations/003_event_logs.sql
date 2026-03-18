-- Migration 003: Event Logs (Logging & Debugging Knowledge Base)
-- Purpose: Structured event log for debugging agent queries and future analytics.
-- Retention: 90 days via pg_cron (transactional tables keep data indefinitely).
-- Last updated: 2026-02-25

-- ─── Table ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What happened
  event_type   TEXT NOT NULL,                    -- e.g. 'address.verified', 'label.created'

  -- Who / context
  session_id   TEXT,                             -- x-session-id header (client-generated)
  actor_id     UUID,                             -- user_id from Supabase Auth (null = anonymous)

  -- What was affected
  entity_type  TEXT,                             -- 'address' | 'shipment' | 'rate' | 'label'
  entity_id    TEXT,                             -- EasyPost ID or Supabase UUID

  -- Classification
  severity     TEXT NOT NULL DEFAULT 'info'
                 CHECK (severity IN ('info', 'warn', 'error')),
  source       TEXT NOT NULL DEFAULT 'edge_fn'
                 CHECK (source IN ('edge_fn', 'webhook', 'frontend')),

  -- Performance
  duration_ms  INTEGER,                          -- external API call latency in ms

  -- All structured details — use for ALL investigation queries
  properties   JSONB NOT NULL DEFAULT '{}',

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

-- Primary investigation: filter by event type + time range
CREATE INDEX IF NOT EXISTS idx_event_logs_type_time
  ON event_logs (event_type, created_at DESC);

-- Session replay: "what happened in session X?"
CREATE INDEX IF NOT EXISTS idx_event_logs_session
  ON event_logs (session_id, created_at)
  WHERE session_id IS NOT NULL;

-- Error dashboard: all non-info events
CREATE INDEX IF NOT EXISTS idx_event_logs_severity
  ON event_logs (severity, created_at DESC)
  WHERE severity != 'info';

-- Entity trace: "all events for EasyPost ID X"
CREATE INDEX IF NOT EXISTS idx_event_logs_entity
  ON event_logs (entity_type, entity_id, created_at)
  WHERE entity_id IS NOT NULL;

-- Actor trace: "all events for user X"
CREATE INDEX IF NOT EXISTS idx_event_logs_actor
  ON event_logs (actor_id, created_at DESC)
  WHERE actor_id IS NOT NULL;

-- Time-range queries (general)
CREATE INDEX IF NOT EXISTS idx_event_logs_created_at
  ON event_logs (created_at DESC);

-- ─── RLS ──────────────────────────────────────────────────────────────────────
-- No public access. event_logs is written via service role only.
-- Agents and admins query via Supabase SQL editor (service role).
ALTER TABLE event_logs ENABLE ROW LEVEL SECURITY;

-- ─── 90-day TTL via pg_cron ───────────────────────────────────────────────────
-- Requires pg_cron extension. Enable via Supabase Dashboard → Database → Extensions.
-- If pg_cron is not enabled, run this manually after enabling:
--
--   SELECT cron.schedule(
--     'purge-event-logs-90d',
--     '0 3 * * *',
--     $$DELETE FROM event_logs WHERE created_at < now() - INTERVAL '90 days'$$
--   );
--
-- Skipping the cron.schedule() call here to avoid migration failure if pg_cron
-- is not yet enabled. Add once confirmed active.

COMMENT ON TABLE event_logs IS
  'Structured event log for debugging and observability. '
  'Written by Edge Functions via the ingest function (service role). '
  'Retained for 90 days. See CLAUDE.md §Logging for query examples.';
