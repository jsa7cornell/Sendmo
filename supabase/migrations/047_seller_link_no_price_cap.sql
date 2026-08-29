-- 047: seller links carry NO price cap — max_price_cents becomes nullable,
-- restricted to seller_link.
--
-- PR4 of proposals/2026-08-28_seller-link-launch_reviewed-2026-08-28_decided-2026-08-29.md
-- (Q3 decided: on a buyer-pays link a cap protects nobody — the buyer spends
-- their own money on options they pick). The column was NOT NULL DEFAULT
-- since 001, so writing NULL without this migration 23502s every seller
-- create; omitting the key would silently reimpose the DEFAULT cap.
--
-- Recipient-pays links keep a mandatory cap (there it bounds someone ELSE's
-- spend) — enforced by the per-type CHECK below, in the spirit of 040's
-- airtight per-type address CHECK.

ALTER TABLE public.sendmo_links
    ALTER COLUMN max_price_cents DROP NOT NULL;

ALTER TABLE public.sendmo_links
    DROP CONSTRAINT IF EXISTS sendmo_links_cap_by_type_check;
ALTER TABLE public.sendmo_links
    ADD CONSTRAINT sendmo_links_cap_by_type_check
    CHECK (max_price_cents IS NOT NULL OR link_type = 'seller_link');

-- Existing seller links (prod holds only the two 2026-07-19 test fixtures)
-- were stamped with the silent $100 default this PR retires.
UPDATE public.sendmo_links
    SET max_price_cents = NULL
    WHERE link_type = 'seller_link';

COMMENT ON COLUMN public.sendmo_links.max_price_cents IS
    'Display-price ceiling in cents for recipient-pays links (mandatory there — it bounds the link owner''s spend). NULL on seller_link (buyer-pays, PR4 2026-08-29): the buyer picks and pays their own option; the platform-wide $200 ceiling is the only guard.';
