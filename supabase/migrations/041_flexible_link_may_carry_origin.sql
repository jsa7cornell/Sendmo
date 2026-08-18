-- 041 — a flexible link may carry the ship-from address its creator already knew
--
-- WHY
-- Migration 040 made the per-type address constraint airtight:
--
--   ELSE recipient_address_id IS NOT NULL AND origin_address_id IS NULL
--
-- That was right for the seller-link split — a recipient link knows its
-- destination, not an origin. But onboarding now lets the creator answer "the
-- sender will fill this in" per question (2026-08-18). Someone who knows the
-- ship-from address but not the parcel produces a FLEXIBLE link with a known
-- origin, and under 040 that INSERT throws sendmo_links_addr_by_type_check.
-- The address was therefore being discarded, and the sender retyped their own.
--
-- WHAT CHANGES
-- Non-seller links may now OPTIONALLY carry an origin. Everything 040 actually
-- guarded is preserved:
--   • a seller link still MUST have an origin and MUST NOT have a recipient
--   • every non-seller link still MUST have a recipient
-- Only the "…AND origin_address_id IS NULL" clause is dropped.
--
-- SAFETY
-- Strictly relaxing: every row that satisfied the old constraint satisfies this
-- one, so no existing row can be invalidated and the change cannot fail on
-- legacy data. Idempotent (drop-then-add), matching the convention in 002–040.

ALTER TABLE public.sendmo_links DROP CONSTRAINT IF EXISTS sendmo_links_addr_by_type_check;

ALTER TABLE public.sendmo_links
  ADD CONSTRAINT sendmo_links_addr_by_type_check
  CHECK (
    CASE link_type
      WHEN 'seller_link' THEN origin_address_id IS NOT NULL AND recipient_address_id IS NULL
      ELSE                     recipient_address_id IS NOT NULL
    END
  );

COMMENT ON COLUMN public.sendmo_links.origin_address_id IS
  'Ship-FROM address. REQUIRED for seller_link (the seller''s own). OPTIONAL for flexible '
  '(2026-08-18): set when the link creator already knew the sender''s address, so the sender '
  'is not asked to retype it. NULL for full_label.';
