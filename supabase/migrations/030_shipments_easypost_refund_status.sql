-- Migration: 030_shipments_easypost_refund_status.sql
--
-- Triggered by: admin-dashboard audit (2026-05-20) — cancelled labels are a
-- money-leak surface; when SendMo voids a label, the EasyPost carrier refund
-- must complete before we get the cost back, but there was no persistent
-- column to track EasyPost's side of the void.
--
-- ── What this adds ───────────────────────────────────────────────────────────
-- shipments.easypost_refund_status TEXT (nullable) — the EasyPost-side void
-- status for this shipment. Mirrors the EasyPost Shipment object's
-- `refund_status` field:
--
--   NULL           — not yet voided / void not applicable (live label)
--   'submitted'    — void request queued with the carrier; awaiting confirmation
--   'refunded'     — carrier confirmed the void; EasyPost credited our account
--   'rejected'     — carrier rejected the void (label was scanned)
--   'not_applicable' — no refund applies (comp/test shipments, instantaneous carriers)
--
-- This column is distinct from the existing `refund_status` column (migration
-- 002), which tracks the Stripe / SendMo money-movement side. The two columns
-- advance on different schedules:
--
--   shipments.refund_status          — who owes money back to the customer
--   shipments.easypost_refund_status — whether EasyPost has credited SendMo
--
-- A cancelled, Stripe-paid label in a healthy state looks like:
--   refund_status          = 'submitted'  → 'refunded'
--   easypost_refund_status = 'submitted'  → 'refunded'
-- Both must land 'refunded' before SendMo is whole.
--
-- ── Populated from three places ──────────────────────────────────────────────
-- 1. cancel-label/index.ts  — set at void time from EasyPost refund API response.
-- 2. tracking/index.ts      — lazy-poll when user visits /t/<code> on submitted.
-- 3. webhooks/index.ts      — EasyPost 'refund.successful' push event (when the
--    EASYPOST_WEBHOOK_HMAC_SECRET and EasyPost dashboard subscription are wired).
--    See WISHLIST "EasyPost refund webhook wiring" for the cron-poll follow-up.
--
-- ── Reversibility ────────────────────────────────────────────────────────────
-- Column is nullable; dropping it is:
--   ALTER TABLE public.shipments DROP COLUMN easypost_refund_status;
--
-- ── Apply instructions (John-only — agents must NOT apply) ──────────────────
-- Run in the Supabase SQL Editor for the production project.
-- Post-apply check:
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND table_name = 'shipments'
--     AND column_name = 'easypost_refund_status';
-- Expect: column_name='easypost_refund_status', data_type='text', is_nullable='YES'.

BEGIN;

ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS easypost_refund_status TEXT;

-- Optional: enforce at the DB level that only known EasyPost values land here.
-- Commented out by default — the set of EasyPost values is stable but could
-- gain values in a future API version; a soft TEXT column is safer.
-- ALTER TABLE public.shipments
--   ADD CONSTRAINT shipments_easypost_refund_status_check
--   CHECK (easypost_refund_status IN ('submitted','refunded','rejected','not_applicable'));

COMMENT ON COLUMN public.shipments.easypost_refund_status IS
  'EasyPost-side void/refund status. NULL=not voided. submitted=void queued with carrier. '
  'refunded=carrier confirmed, EasyPost credited SendMo account. rejected=label was scanned. '
  'not_applicable=comp or instantaneous-carrier shipment. '
  'Distinct from refund_status (Stripe money-movement side).';

COMMIT;
