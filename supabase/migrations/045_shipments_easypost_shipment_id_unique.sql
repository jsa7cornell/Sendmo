-- 045: UNIQUE partial index on shipments.easypost_shipment_id.
--
-- PR1 of proposals/2026-08-28_seller-link-launch_reviewed-2026-08-28_decided-2026-08-29.md
-- (the replay hole): the labels function now returns the existing row for a
-- replayed buy, and this index is the DB-level backstop — a duplicate insert
-- for the same EasyPost shipment must fail loudly rather than mint a second
-- shipments row against one label.
--
-- Pre-flight (migration 015 pattern): refuse to apply over existing
-- duplicates so the failure is an actionable message, not a bare 23505.
--
-- Deviation from the proposal text, on purpose: the proposal specified
-- CREATE UNIQUE INDEX CONCURRENTLY, which cannot run inside a transaction —
-- but supabase migrations each run in one. At the current table size the
-- plain CREATE INDEX lock is sub-millisecond, so transactional-and-simple
-- wins. Revisit only if this table is ever large enough for CONCURRENTLY to
-- matter (then: apply by hand outside the migration runner).

DO $$
DECLARE
    v_dupe_count INTEGER;
BEGIN
    SELECT count(*) INTO v_dupe_count FROM (
        SELECT easypost_shipment_id
        FROM public.shipments
        WHERE easypost_shipment_id IS NOT NULL
        GROUP BY easypost_shipment_id
        HAVING count(*) > 1
    ) d;
    IF v_dupe_count > 0 THEN
        RAISE EXCEPTION 'Cannot apply UNIQUE index: % duplicate easypost_shipment_id values detected. Reconcile the duplicate shipments rows before proceeding.', v_dupe_count;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS shipments_easypost_shipment_id_uidx
    ON public.shipments (easypost_shipment_id)
    WHERE easypost_shipment_id IS NOT NULL;
