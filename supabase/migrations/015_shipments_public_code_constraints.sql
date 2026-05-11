-- =============================================================
-- SendMo — Lock shipments.public_code to NOT NULL + UNIQUE
-- Migration: 015_shipments_public_code_constraints.sql
--
-- Migration 014 added the column nullable and backfilled existing rows;
-- this migration flips it to NOT NULL + UNIQUE. Split into a second
-- file so that if 014's backfill ever fails partway in production, this
-- migration can be retried independently after the rows are healed
-- (instead of having to recover a half-applied combined migration).
--
-- Defense-in-depth: pre-verifies no NULL rows and no duplicates before
-- applying the constraints, so failures here are clear instead of being
-- a generic constraint violation.
--
-- See: proposals/2026-05-11_sendmo-public-tracking-code_reviewed-2026-05-11_decided-2026-05-11.md
-- =============================================================

DO $$
DECLARE
    v_null_count INTEGER;
    v_dupe_count INTEGER;
BEGIN
    SELECT count(*) INTO v_null_count FROM public.shipments WHERE public_code IS NULL;
    IF v_null_count > 0 THEN
        RAISE EXCEPTION 'Cannot apply NOT NULL constraint: % rows have NULL public_code. Re-run migration 014''s backfill.', v_null_count;
    END IF;

    SELECT count(*) INTO v_dupe_count FROM (
        SELECT public_code FROM public.shipments GROUP BY public_code HAVING count(*) > 1
    ) d;
    IF v_dupe_count > 0 THEN
        RAISE EXCEPTION 'Cannot apply UNIQUE constraint: % duplicate public_code values detected. Investigate before proceeding.', v_dupe_count;
    END IF;
END $$;

ALTER TABLE public.shipments
  ALTER COLUMN public_code SET NOT NULL;

ALTER TABLE public.shipments
  ADD CONSTRAINT shipments_public_code_unique UNIQUE (public_code);
