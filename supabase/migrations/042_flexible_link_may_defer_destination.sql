-- 042 — a flexible link may defer the DESTINATION to the sender
--
-- WHY
-- Unified-onboarding Phase 3 (proposal 2026-08-18, decision B: John chose
-- "any combination" of skips). The creator can now answer "the sender picks
-- the destination" — producing a flexible link whose recipient_address_id is
-- NULL; the link user (sender) supplies the destination when they ship, and
-- the creator still pays. Under 041's constraint that INSERT throws
-- sendmo_links_addr_by_type_check (non-seller links must have a recipient).
--
-- WHAT CHANGES
-- flexible links: NO address requirement — any combination of recipient /
-- origin may be present, per decision B (the price cap is the bound).
-- Preserved exactly:
--   • seller_link still MUST have an origin and MUST NOT have a recipient
--   • full_label still MUST have a recipient
--
-- SAFETY
-- Strictly relaxing: every row satisfying 041's constraint satisfies this one,
-- so no existing row can be invalidated. Idempotent (drop-then-add), matching
-- the convention in 002–041.

ALTER TABLE public.sendmo_links DROP CONSTRAINT IF EXISTS sendmo_links_addr_by_type_check;

ALTER TABLE public.sendmo_links
  ADD CONSTRAINT sendmo_links_addr_by_type_check
  CHECK (
    CASE link_type
      WHEN 'seller_link' THEN origin_address_id IS NOT NULL AND recipient_address_id IS NULL
      WHEN 'flexible'    THEN TRUE
      ELSE                    recipient_address_id IS NOT NULL
    END
  );

COMMENT ON COLUMN public.sendmo_links.recipient_address_id IS
  'Delivery address. REQUIRED for full_label. OPTIONAL for flexible (2026-08-18 '
  'Phase 3): NULL means the creator deferred the destination — the sender supplies '
  'it in the sender flow, resolved at label time from the EasyPost shipment. '
  'Always NULL for seller_link (the buyer supplies the destination).';
