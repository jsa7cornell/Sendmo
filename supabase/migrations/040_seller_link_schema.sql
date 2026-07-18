-- Migration: 040_seller_link_schema.sql
--
-- Seller Link — the third shipment type. The SELLER creates a link with the
-- package already specced (origin + dims/weight), the BUYER opens it, enters
-- their destination, picks a speed, and pays on-session. Mirror of the
-- recipient-pays flex link; first SendMo flow where the payer is not the
-- account holder.
--
-- Decided proposal:
--   proposals/2026-07-17_seller-link-buyer-pays_reviewed-2026-07-17_decided-2026-07-17.md
--
-- This migration is PR1 of the series — schema only, fully additive. Existing
-- rows and the two existing link_types (full_label, flexible) are untouched;
-- every ADD is guarded IF NOT EXISTS and every CHECK is drop-then-add so the
-- file is safe to re-run.
--
-- ── What changes on sendmo_links ────────────────────────────────────────────
--   • link_type CHECK gains 'seller_link'.
--   • origin_address_id — the seller's ship-FROM, known at link creation
--     (the flip: a recipient link knows the destination; a seller link knows
--     the origin, and the destination arrives later from the buyer).
--   • length_in / width_in / height_in — the seller's specced package.
--     Weight reuses the existing weight_hint_oz column (no second weight
--     column — see review nit).
--   • max_shipments — NULL = reusable (flex-style child shipments), 1 =
--     single-use (closes to status='in_use' after the first paid label).
--   • funder — the future-proof seam (proposal amendment 2026-07-18). Default
--     'buyer'; v1 only ever sets 'buyer'. When "seller covers shipping" ships,
--     it flips to 'seller' and the payment step reuses Pattern D. link_type
--     deliberately does NOT encode who funds — that lives here.
--   • recipient_address_id NOT NULL is relaxed (a seller link has no known
--     recipient at creation), replaced by an airtight per-type CHECK.
--
-- ── What changes on shipments ───────────────────────────────────────────────
--   • buyer_email — the paying buyer's email (new; today recipient_email is
--     resolved server-side and never persisted). Needed for the buyer's
--     receipt/tracking/cancel emails and the optional account claim.
--   • recipient_user_id — normally NULL; set only if the buyer later claims
--     the shipment under a Supabase-verified email. New RLS lets that user
--     read their own claimed shipments.

BEGIN;

-- ── sendmo_links: link_type gains 'seller_link' ─────────────────────────────
ALTER TABLE public.sendmo_links DROP CONSTRAINT IF EXISTS sendmo_links_link_type_check;
ALTER TABLE public.sendmo_links
  ADD CONSTRAINT sendmo_links_link_type_check
  CHECK (link_type IN ('full_label', 'flexible', 'seller_link'));

-- ── sendmo_links: new seller-link columns (all NULL for existing rows) ───────
ALTER TABLE public.sendmo_links
  ADD COLUMN IF NOT EXISTS origin_address_id UUID REFERENCES public.addresses(id),
  ADD COLUMN IF NOT EXISTS length_in         NUMERIC,
  ADD COLUMN IF NOT EXISTS width_in          NUMERIC,
  ADD COLUMN IF NOT EXISTS height_in         NUMERIC,
  ADD COLUMN IF NOT EXISTS max_shipments     INTEGER,
  ADD COLUMN IF NOT EXISTS funder            TEXT NOT NULL DEFAULT 'buyer';

COMMENT ON COLUMN public.sendmo_links.origin_address_id IS
  'Seller ship-FROM address (seller_link only). Recipient links leave this NULL.';
COMMENT ON COLUMN public.sendmo_links.max_shipments IS
  'NULL = reusable (each buyer spawns a child shipment); 1 = single-use (link closes to in_use after first paid label).';
COMMENT ON COLUMN public.sendmo_links.funder IS
  'Who pays for the label: buyer (v1) | seller (future "I''ll cover shipping"). link_type does NOT encode this — future-proof seam per proposal amendment 2026-07-18.';

-- funder domain (drop-then-add for idempotency)
ALTER TABLE public.sendmo_links DROP CONSTRAINT IF EXISTS sendmo_links_funder_check;
ALTER TABLE public.sendmo_links
  ADD CONSTRAINT sendmo_links_funder_check
  CHECK (funder IN ('buyer', 'seller'));

-- ── sendmo_links: relax recipient NOT NULL, enforce airtight per-type addresses ──
-- A seller link knows its ORIGIN, not its destination; recipient/full-label
-- links know their DESTINATION, not a seller origin. The CHECK makes each type
-- carry exactly the address it should and forbid the other — the "airtight
-- per-type constraint" the single-table decision (OQ2) relies on.
ALTER TABLE public.sendmo_links ALTER COLUMN recipient_address_id DROP NOT NULL;

ALTER TABLE public.sendmo_links DROP CONSTRAINT IF EXISTS sendmo_links_addr_by_type_check;
ALTER TABLE public.sendmo_links
  ADD CONSTRAINT sendmo_links_addr_by_type_check
  CHECK (
    CASE link_type
      WHEN 'seller_link' THEN origin_address_id IS NOT NULL AND recipient_address_id IS NULL
      ELSE                     recipient_address_id IS NOT NULL AND origin_address_id IS NULL
    END
  );

CREATE INDEX IF NOT EXISTS idx_links_origin_address_id
  ON public.sendmo_links(origin_address_id);

-- ── shipments: buyer identity for seller-link shipments ─────────────────────
ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS buyer_email       TEXT,
  ADD COLUMN IF NOT EXISTS recipient_user_id UUID REFERENCES public.profiles(id);

COMMENT ON COLUMN public.shipments.buyer_email IS
  'Paying buyer''s email (seller_link shipments). Recipient/full-label leave NULL — their payer email resolves from the link owner.';
COMMENT ON COLUMN public.shipments.recipient_user_id IS
  'Set only when a buyer claims this shipment under a Supabase-verified email (optional, low-adoption). Enables the buyer to see it in their own dashboard.';

-- Buyer dashboard lookup + the verified-email claim backfill
-- (SET recipient_user_id ... WHERE buyer_email = <verified> AND recipient_user_id IS NULL).
CREATE INDEX IF NOT EXISTS idx_shipments_recipient_user_id
  ON public.shipments(recipient_user_id);
CREATE INDEX IF NOT EXISTS idx_shipments_buyer_email_unclaimed
  ON public.shipments(buyer_email)
  WHERE recipient_user_id IS NULL;

-- A buyer who has claimed a shipment can read it (in addition to the existing
-- link-owner SELECT policy). Service-role writes are unaffected.
DROP POLICY IF EXISTS "Buyers can view own claimed shipments" ON public.shipments;
CREATE POLICY "Buyers can view own claimed shipments"
    ON public.shipments FOR SELECT
    USING (auth.uid() = recipient_user_id);

COMMIT;
