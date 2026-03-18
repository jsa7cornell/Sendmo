-- =============================================================
-- SendMo — Add is_test flag to Shipments
-- Migration: 003_add_is_test_to_shipments.sql
--
-- Design decision: is_test is an attribute of the shipment record,
-- set at creation time by the server using the API key that was used.
-- It is NEVER derived from client-provided parameters at runtime.
-- This ensures deterministic, honest behavior — no silent simulation.
-- =============================================================

ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.shipments.is_test IS
  'True if this shipment was created using the test carrier API key.
   Set server-side at creation time — never trust the client for this value.
   Test labels cannot be voided via the carrier API (they are synthetic).';

-- Index for admin filtering and eligibility guards
CREATE INDEX IF NOT EXISTS idx_shipments_is_test ON public.shipments(is_test);
