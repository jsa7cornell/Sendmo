-- 048: a seventh link status — 'closed' — for the seller's off switch.
--
-- PR5 of proposals/2026-08-28_seller-link-launch_reviewed-2026-08-28_decided-2026-08-29.md
-- (Q1 decided: a NEW value, not a reuse). With no inventory counting, the
-- seller's hand on the switch IS the inventory control — and there was no
-- switch: nothing anywhere could take a seller link down. The value is new
-- because every existing status has another writer whose semantics would
-- collide: 'completed' is written by the delivery webhook, 'cancelled' by
-- rotate, 'expired' is time-driven. Disjoint writers, no forever-guards.
--
-- Buyer-facing behavior needs nothing: the links GET already 410s any
-- non-active seller link, and the 410 body carries link_type (PR3), so a
-- closed listing renders "This item has already sold".
--
-- Note for the reader of WISHLIST's 2026-05-18 "status enum cleanup" entry
-- (drop in_use/completed as dead values): that entry predates the seller
-- link, which now uses in_use for the single-use claim — it is stale, and
-- annotated as such in this PR.

ALTER TABLE public.sendmo_links DROP CONSTRAINT IF EXISTS sendmo_links_status_check;
ALTER TABLE public.sendmo_links
  ADD CONSTRAINT sendmo_links_status_check
  CHECK (status IN ('draft', 'active', 'in_use', 'completed', 'expired', 'cancelled', 'closed'));

-- Refresh 020's column COMMENT — the only in-database documentation of the
-- enum; without this a schema reader concludes a 'closed' row is corrupt.
COMMENT ON COLUMN public.sendmo_links.status IS
    'Lifecycle: draft → active → in_use → completed. Terminal-by-policy: completed, expired, cancelled, closed. ''closed'' (048) is the seller''s off switch on seller_link — written only by POST /links/:id/close.';
