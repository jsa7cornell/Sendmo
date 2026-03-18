-- =============================================================
-- SendMo — Fix admin_insert_shipment gen_random_bytes schema
-- Migration: 007_fix_admin_insert_shipment_schema.sql
-- =============================================================

CREATE OR REPLACE FUNCTION public.admin_insert_shipment(
    p_user_id              UUID,
    -- from address
    p_from_name            TEXT,
    p_from_street1         TEXT,
    p_from_street2         TEXT,
    p_from_city            TEXT,
    p_from_state           TEXT,
    p_from_zip             TEXT,
    p_from_country         TEXT,
    -- to address
    p_to_name              TEXT,
    p_to_street1           TEXT,
    p_to_street2           TEXT,
    p_to_city              TEXT,
    p_to_state             TEXT,
    p_to_zip               TEXT,
    p_to_country           TEXT,
    -- shipment details
    p_carrier              TEXT,
    p_service              TEXT,
    p_tracking_number      TEXT,
    p_label_url            TEXT,
    p_easypost_shipment_id TEXT,
    p_easypost_tracker_id  TEXT,
    p_rate_cents           INTEGER,
    p_display_price_cents  INTEGER,
    p_weight_oz            NUMERIC,
    p_length_in            NUMERIC,
    p_width_in             NUMERIC,
    p_height_in            NUMERIC,
    p_is_live              BOOLEAN
)
RETURNS UUID
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
BEGIN
    -- ── Step 1: Insert FROM address ──────────────────────────────────────────
    INSERT INTO public.addresses (
        user_id, name, street1, street2, city, state, zip, country, is_verified
    ) VALUES (
        p_user_id,
        p_from_name,
        p_from_street1,
        p_from_street2,
        p_from_city,
        p_from_state,
        p_from_zip,
        COALESCE(p_from_country, 'US'),
        TRUE
    )
    RETURNING id INTO v_from_address_id;

    -- ── Step 2: Insert TO address ────────────────────────────────────────────
    INSERT INTO public.addresses (
        user_id, name, street1, street2, city, state, zip, country, is_verified
    ) VALUES (
        p_user_id,
        p_to_name,
        p_to_street1,
        p_to_street2,
        p_to_city,
        p_to_state,
        p_to_zip,
        COALESCE(p_to_country, 'US'),
        TRUE
    )
    RETURNING id INTO v_to_address_id;

    -- ── Step 3: Generate unique short_code + insert sendmo_link ─────────────
    -- Generate a short code with retry on collision (max 5 attempts)
    DECLARE
        v_attempt INTEGER := 0;
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
                    p_user_id,
                    v_short_code,
                    'full_label',
                    'used',
                    v_to_address_id,
                    p_from_name,
                    p_display_price_cents
                )
                RETURNING id INTO v_link_id;
                EXIT;  -- success, break out of loop
            EXCEPTION WHEN unique_violation THEN
                v_attempt := v_attempt + 1;
                IF v_attempt >= 5 THEN
                    RAISE EXCEPTION 'Could not generate unique short_code after 5 attempts';
                END IF;
            END;
        END LOOP;
    END;

    -- ── Step 4: Insert shipment ──────────────────────────────────────────────
    INSERT INTO public.shipments (
        link_id,
        sender_address_id,
        recipient_address_id,
        easypost_shipment_id,
        easypost_tracker_id,
        carrier,
        service,
        tracking_number,
        label_url,
        rate_cents,
        display_price_cents,
        status,
        weight_oz,
        length_in,
        width_in,
        height_in,
        is_live
    ) VALUES (
        v_link_id,
        v_from_address_id,
        v_to_address_id,
        p_easypost_shipment_id,
        p_easypost_tracker_id,
        p_carrier,
        p_service,
        p_tracking_number,
        p_label_url,
        p_rate_cents,
        p_display_price_cents,
        'label_created',
        p_weight_oz,
        p_length_in,
        p_width_in,
        p_height_in,
        p_is_live
    )
    RETURNING id INTO v_shipment_id;

    RETURN v_shipment_id;
END;
$$;
