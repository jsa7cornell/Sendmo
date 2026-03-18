-- =============================================================
-- SendMo — Add Refund/Cancellation Fields to Shipments
-- Migration: 002_add_refund_fields.sql
-- =============================================================

-- Add refund tracking columns to shipments table
ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS refund_status TEXT NOT NULL DEFAULT 'none'
    CHECK (refund_status IN ('none', 'submitted', 'refunded', 'rejected', 'not_applicable')),
  ADD COLUMN IF NOT EXISTS refund_submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS carrier_refund_id TEXT;  -- External carrier refund reference

-- Comment for clarity
COMMENT ON COLUMN public.shipments.refund_status IS
  'Tracks the label void/refund lifecycle: none → submitted → refunded|rejected|not_applicable';
COMMENT ON COLUMN public.shipments.refund_submitted_at IS
  'Timestamp when the refund request was submitted to the carrier';
COMMENT ON COLUMN public.shipments.cancelled_at IS
  'Timestamp when the shipment label was cancelled by admin or user';
COMMENT ON COLUMN public.shipments.carrier_refund_id IS
  'External reference ID from the carrier refund process';

-- Index on refund_status for admin reporting queries
CREATE INDEX IF NOT EXISTS idx_shipments_refund_status ON public.shipments(refund_status);
