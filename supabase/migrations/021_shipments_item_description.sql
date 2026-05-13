-- Migration 021: shipments.item_description
-- Decided proposal:
--   proposals/2026-05-13_tracking-page-ia-polish_reviewed-2026-05-13_decided-2026-05-13.md
--   T1=(a), T2=(i) — item_description ships in this PR with anonymous-allowed visibility.
--
-- Context: the sender wizard captures `parcel.description` at SenderStepReview but
-- the labels function previously dropped it before reaching the database. This
-- migration adds the storage column; the labels function and tracking response
-- are updated in the same PR to persist and surface it.
--
-- NULL-able because (a) existing rows have no source for the value, (b) sender
-- flow may omit it, (c) admin-comp flows may not pass it. The tracking response
-- and Details UI treat NULL gracefully (line is hidden when absent).

ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS item_description TEXT NULL;

COMMENT ON COLUMN shipments.item_description IS
  'Sender-declared package contents (e.g. "A pair of running shoes"). '
  'Captured at SenderStepReview.parcel.description. Surfaced on /t/<public_code> '
  'across all viewer types per privacy decision T2=(i) (2026-05-13). NULL when '
  'no description was provided (pre-migration rows; admin-comp flows; older '
  'sender-wizard versions).';
