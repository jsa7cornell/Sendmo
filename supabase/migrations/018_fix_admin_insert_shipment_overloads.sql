-- =============================================================
-- SendMo — Resolve admin_insert_shipment overload collision
-- Migration: 018_fix_admin_insert_shipment_overloads.sql
--
-- Background (2026-05-12 LOG entry "Stripe Phase A"):
-- Production has TWO admin_insert_shipment overloads sitting alongside
-- each other. Migration 014's DROP FUNCTION IF EXISTS targeted the
-- 29-param signature it expected from migration 012, but the historical
-- apply order on prod left a 28-param sibling from migration 008
-- surviving alongside the new TABLE-returning version from 014.
-- PostgREST's function-lookup picks the wrong overload (or fails to
-- resolve at all), and no label has been persisted to the shipments
-- table since 2026-03-18.
--
-- This migration:
--   1. Enumerates every existing admin_insert_shipment overload via
--      pg_proc and DROPs each one explicitly (works regardless of
--      which signatures actually landed in prod).
--   2. Recreates the canonical version — 29 params (migration 014's
--      shape including p_promised_delivery_date) and returns
--      TABLE(id, public_code, short_code). Adding short_code lets the
--      labels Edge Function surface a real Share Link on the
--      Full Label "Label & Link" step, closing the third launch
--      blocker filed 2026-05-12.
--
-- Per Rule 0.5 the agent writes the migration; John runs it against
-- project fkxykvzsqdjzhurntgah via the Supabase dashboard SQL editor.
-- Postgres wraps migration files in a transaction — if any statement
-- errors, the whole thing rolls back to 017.
-- =============================================================

-- ── 1. Drop every existing admin_insert_shipment overload ────────────────
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT oid::regprocedure::text AS sig
        FROM pg_proc
        WHERE proname = 'admin_insert_shipment'
          AND pronamespace = 'public'::regnamespace
    LOOP
        EXECUTE 'DROP FUNCTION ' || r.sig;
    END LOOP;
END $$;

-- ── 2. Recreate canonical admin_insert_shipment ──────────────────────────
CREATE FUNCTION public.admin_insert_shipment(
    p_user_id                UUID,
    p_from_name              TEXT,
    p_from_street1           TEXT,
    p_from_street2           TEXT,
    p_from_city              TEXT,
    p_from_state             TEXT,
    p_from_zip               TEXT,
    p_from_country           TEXT,
    p_to_name                TEXT,
    p_to_street1             TEXT,
    p_to_street2             TEXT,
    p_to_city                TEXT,
    p_to_state               TEXT,
    p_to_zip                 TEXT,
    p_to_country             TEXT,
    p_carrier                TEXT,
    p_service                TEXT,
    p_tracking_number        TEXT,
    p_label_url              TEXT,
    p_easypost_shipment_id   TEXT,
    p_easypost_tracker_id    TEXT,
    p_rate_cents             INTEGER,
    p_display_price_cents    INTEGER,
    p_weight_oz              NUMERIC,
    p_length_in              NUMERIC,
    p_width_in               NUMERIC,
    p_height_in              NUMERIC,
    p_is_live                BOOLEAN,
    p_promised_delivery_date DATE DEFAULT NULL
)
RETURNS TABLE(id UUID, public_code TEXT, short_code TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_from_address_id UUID;
    v_to_address_id   UUID;
    v_link_id         UUID;
    v_shipment_id     UUID;
    v_short_code      TEXT;
    v_public_code     TEXT;
    v_attempt         INTEGER;
BEGIN
    -- ── Step 1: Insert FROM address ──────────────────────────────────────
    INSERT INTO public.addresses (
        user_id, name, street1, street2, city, state, zip, country, is_verified
    ) VALUES (
        p_user_id, p_from_name, p_from_street1, p_from_street2,
        p_from_city, p_from_state, p_from_zip,
        COALESCE(p_from_country, 'US'), TRUE
    )
    RETURNING addresses.id INTO v_from_address_id;

    -- ── Step 2: Insert TO address ────────────────────────────────────────
    INSERT INTO public.addresses (
        user_id, name, street1, street2, city, state, zip, country, is_verified
    ) VALUES (
        p_user_id, p_to_name, p_to_street1, p_to_street2,
        p_to_city, p_to_state, p_to_zip,
        COALESCE(p_to_country, 'US'), TRUE
    )
    RETURNING addresses.id INTO v_to_address_id;

    -- ── Step 3: Generate unique sendmo_link short_code + insert link ─────
    DECLARE
        v_link_attempt INTEGER := 0;
    BEGIN
        LOOP
            v_short_code := LEFT(
                REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                    encode(extensions.gen_random_bytes(8), 'base64'),
                    '+', 'A'), '/', 'B'), '=', ''), 'O', 'C'), 'l', 'D'),
                10
            );
            BEGIN
                INSERT INTO public.sendmo_links (
                    user_id, short_code, link_type, status,
                    recipient_address_id, sender_name, max_price_cents
                ) VALUES (
                    p_user_id, v_short_code, 'full_label', 'used',
                    v_to_address_id, p_from_name, p_display_price_cents
                )
                RETURNING sendmo_links.id INTO v_link_id;
                EXIT;
            EXCEPTION WHEN unique_violation THEN
                v_link_attempt := v_link_attempt + 1;
                IF v_link_attempt >= 5 THEN
                    RAISE EXCEPTION 'Could not generate unique short_code after 5 attempts';
                END IF;
            END;
        END LOOP;
    END;

    -- ── Step 4: Generate unique public_code (retry on collision) ─────────
    v_attempt := 0;
    LOOP
        v_public_code := public._gen_crockford_base32(7);
        IF NOT EXISTS (SELECT 1 FROM public.shipments WHERE public_code = v_public_code) THEN
            EXIT;
        END IF;
        v_attempt := v_attempt + 1;
        IF v_attempt >= 5 THEN
            RAISE EXCEPTION 'Could not generate unique public_code after 5 attempts';
        END IF;
    END LOOP;

    -- ── Step 5: Insert shipment ──────────────────────────────────────────
    INSERT INTO public.shipments (
        link_id, sender_address_id, recipient_address_id,
        easypost_shipment_id, easypost_tracker_id,
        carrier, service, tracking_number, label_url,
        rate_cents, display_price_cents, status,
        weight_oz, length_in, width_in, height_in,
        is_live, is_test, promised_delivery_date,
        public_code
    ) VALUES (
        v_link_id, v_from_address_id, v_to_address_id,
        p_easypost_shipment_id, p_easypost_tracker_id,
        p_carrier, p_service, p_tracking_number, p_label_url,
        p_rate_cents, p_display_price_cents, 'label_created',
        p_weight_oz, p_length_in, p_width_in, p_height_in,
        p_is_live, NOT p_is_live, p_promised_delivery_date,
        v_public_code
    )
    RETURNING shipments.id INTO v_shipment_id;

    id := v_shipment_id;
    public_code := v_public_code;
    short_code := v_short_code;
    RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.admin_insert_shipment IS
  'Canonical 29-param admin_insert_shipment. Returns (id, public_code, short_code). Migration 018 consolidates prior overloads (008/012/014 lineage) into one definition.';

GRANT EXECUTE ON FUNCTION public.admin_insert_shipment(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    INTEGER, INTEGER, NUMERIC, NUMERIC, NUMERIC, NUMERIC,
    BOOLEAN, DATE
) TO anon, authenticated;
