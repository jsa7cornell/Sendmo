-- =============================================================
-- SendMo — Add shipments.delivered_at (long-standing missing column)
-- Migration: 013_add_delivered_at.sql
--
-- Background: the `webhooks` and `tracking` Edge Functions have been
-- writing `delivered_at = NOW()` on the status→delivered transition
-- since the notifications/tracking flow was built. The column was
-- never actually created in any migration, so every UPDATE silently
-- failed (write-only path, fire-and-forget, no error surfaced).
--
-- Exposed on 2026-05-11 when migration 012 + the redeployed tracking
-- function started SELECTing the column — the SELECT errored, which
-- the function maps to a 404 "Tracking number not found" for every
-- shipment. Created this migration to fix forward.
--
-- Backfill: for rows already at status='delivered', set delivered_at
-- to updated_at — best available proxy since updated_at is bumped on
-- every webhook/poll and would have been touched at the delivery
-- transition. Approximate but better than NULL for the new
-- delivery-performance badge.
-- =============================================================

ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

COMMENT ON COLUMN public.shipments.delivered_at IS
  'Timestamp the shipment status transitioned to delivered. Written by the webhooks + tracking Edge Functions on the delivered-event handler.';

-- Backfill already-delivered rows using updated_at as a proxy
UPDATE public.shipments
   SET delivered_at = updated_at
 WHERE status = 'delivered'
   AND delivered_at IS NULL;
