-- =============================================================
-- SendMo — Public tracking code (decouple URL from carrier number)
-- Migration: 014_shipments_public_code.sql
--
-- Adds shipments.public_code — 7-char Crockford base32 string,
-- SendMo-minted, the new canonical identifier for the tracking page URL.
--
-- Why: today's `/track/<carrier_tracking_number>` URL has three failure
-- modes the public_code fixes: (1) EasyPost test-mode tracking numbers
-- are deterministic and can collide across shipments → the current
-- `.eq().single()` lookup returns an arbitrary matching row (wrong
-- shipment to wrong viewer, not a 404 as one might assume). (2) Void +
-- reissue breaks URL stability. (3) The URL slug advertises the
-- carrier, not SendMo.
--
-- This migration adds the column nullable + backfills existing rows.
-- Migration 015 flips it to NOT NULL + UNIQUE once backfill is verified.
-- Splitting reduces the blast radius if backfill ever fails partway.
--
-- See: proposals/2026-05-11_sendmo-public-tracking-code_reviewed-2026-05-11_decided-2026-05-11.md
-- =============================================================

-- ── 1. Column ────────────────────────────────────────────────────────────
ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS public_code TEXT;

COMMENT ON COLUMN public.shipments.public_code IS
  '7-char Crockford base32 SendMo-minted tracking code. Canonical URL slug at /t/<public_code>. Unique within shipments.';

-- ── 2. Crockford base32 generator ────────────────────────────────────────
-- Uses extensions.gen_random_bytes for cryptographic-quality randomness
-- (mirrors the sendmo_links.short_code generator pattern in migration 008).
-- Crockford alphabet excludes I, L, O, U to dodge ambiguity (I/1, L/1, O/0)
-- and accidental obscenities (U).
CREATE OR REPLACE FUNCTION public._gen_crockford_base32(p_length INTEGER)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    v_alphabet TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';  -- 32 chars, no I/L/O/U
    v_bytes BYTEA;
    v_out TEXT := '';
    v_i INTEGER;
    v_idx INTEGER;
BEGIN
    v_bytes := extensions.gen_random_bytes(p_length);
    FOR v_i IN 0..p_length - 1 LOOP
        v_idx := (get_byte(v_bytes, v_i) % 32) + 1;
        v_out := v_out || substr(v_alphabet, v_idx, 1);
    END LOOP;
    RETURN v_out;
END;
$$;

COMMENT ON FUNCTION public._gen_crockford_base32(INTEGER) IS
  'Generate a Crockford base32 string of N chars from cryptographic random bytes. Used for shipments.public_code minting.';

-- ── 3. Backfill existing rows ────────────────────────────────────────────
-- Retry on per-row collision; raise after 5 attempts (would indicate a
-- non-trivial RNG failure — worth surfacing loudly).
DO $$
DECLARE
    r RECORD;
    v_code TEXT;
    v_attempt INTEGER;
    v_existing INTEGER;
BEGIN
    FOR r IN SELECT id FROM public.shipments WHERE public_code IS NULL LOOP
        v_attempt := 0;
        LOOP
            v_code := public._gen_crockford_base32(7);
            -- Check collision against rows we may have already filled in this loop
            SELECT count(*) INTO v_existing FROM public.shipments WHERE public_code = v_code;
            IF v_existing = 0 THEN
                UPDATE public.shipments SET public_code = v_code WHERE id = r.id;
                EXIT;
            END IF;
            v_attempt := v_attempt + 1;
            IF v_attempt >= 5 THEN
                RAISE EXCEPTION 'Could not generate unique public_code for shipment % after 5 attempts', r.id;
            END IF;
        END LOOP;
    END LOOP;
END $$;

-- ── 4. Updated admin_insert_shipment — mints public_code internally, ─────
-- returns (id, public_code) so the labels Edge Function can route the
-- label-confirmation email send into the .then() callback with the
-- generated code already in hand.
--
-- CREATE OR REPLACE FUNCTION cannot change a function's return type, so
-- we DROP the existing UUID-returning signature and CREATE the new
-- TABLE-returning one. The old function had 28 params (migration 012);
-- list them precisely so the DROP matches.
DROP FUNCTION IF EXISTS public.admin_insert_shipment(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    INTEGER, INTEGER, NUMERIC, NUMERIC, NUMERIC, NUMERIC,
    BOOLEAN, DATE
);

CREATE OR REPLACE FUNCTION public.admin_insert_shipment(
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
RETURNS TABLE(id UUID, public_code TEXT)
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
        -- Probe for collision before INSERT so we don't need to handle
        -- partial INSERT failure (the INSERT below also has the UNIQUE
        -- constraint as a safety net once migration 015 ships).
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
    RETURN NEXT;
END;
$$;
