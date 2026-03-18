-- =============================================================
-- SendMo — System User, is_live Column & admin_insert_shipment RPC
-- Migration: 004_system_user_and_helpers.sql
--
-- What this does:
--   1. Inserts a well-known system/admin user into auth.users and profiles.
--      UUID: 00000000-0000-0000-0000-000000000001
--      All label-test records (no real auth yet) are owned by this identity.
--      When real Supabase Auth ships, you only change p_user_id — all other
--      code stays the same.
--
--   2. Adds is_live BOOLEAN to shipments so we can distinguish EasyPost test
--      labels (is_live = false) from production labels (is_live = true).
--
--   3. Creates admin_insert_shipment() — a SECURITY DEFINER RPC that handles
--      the full FK-ordered insert chain (addresses → sendmo_links → shipments)
--      in a single atomic call, eliminating round-trip race conditions and
--      FK ordering errors in the calling Edge Function.
--
-- Idempotency: every INSERT uses ON CONFLICT DO NOTHING; ADD COLUMN uses
--   IF NOT EXISTS; CREATE OR REPLACE for the function. Safe to re-run.
-- =============================================================


-- =============================================================
-- 1. SYSTEM / ADMIN USER
--    UUID is a fixed, well-known sentinel distinct from real user UUIDs.
--    Migrating as service_role so direct auth.users INSERT is permitted.
-- =============================================================

-- Insert into auth.users (minimal required fields for GoTrue compatibility)
INSERT INTO auth.users (
    id,
    instance_id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    confirmation_token,
    recovery_token,
    email_change_token_new,
    email_change
)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000000',   -- default instance_id
    'authenticated',
    'authenticated',
    'admin@sendmo.co',
    '',                                        -- no password (service account)
    now(),                                     -- email confirmed
    '{"provider": "email", "providers": ["email"]}'::jsonb,
    '{"full_name": "SendMo Admin"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
)
ON CONFLICT (id) DO NOTHING;

-- Insert the corresponding profile row.
-- The handle_new_user trigger also fires on auth.users INSERT, so the profile
-- may already exist if the trigger ran first — ON CONFLICT DO NOTHING handles that.
INSERT INTO public.profiles (id, email, full_name, created_at, updated_at)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'admin@sendmo.co',
    'SendMo Admin',
    now(),
    now()
)
ON CONFLICT (id) DO NOTHING;


-- =============================================================
-- 2. ADD is_live TO SHIPMENTS
--    Distinguishes EasyPost test-mode labels (false) from live labels (true).
-- =============================================================

ALTER TABLE public.shipments
    ADD COLUMN IF NOT EXISTS is_live BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.shipments.is_live IS
    'True if the label was purchased against the EasyPost live API (real money). '
    'False for test-mode labels (EZTKxxxx key). Set at insert time, never mutated.';

-- Index for admin reporting: "show me all live shipments"
CREATE INDEX IF NOT EXISTS idx_shipments_is_live
    ON public.shipments (is_live);


-- =============================================================
-- 3. admin_insert_shipment() RPC
--    SECURITY DEFINER so it runs with the permissions of its owner (service
--    role), bypassing RLS on all tables. The calling Edge Function uses the
--    anon client — RLS would block it — but calling this RPC is fine.
--
--    Insert order: addresses (from) → addresses (to) → sendmo_links → shipments
--    Returns the new shipments.id so the caller can store it.
--
--    Parameters:
--      p_user_id            UUID   — system user now; real user after auth ships
--      p_from_name          TEXT   — sender full name
--      p_from_street1       TEXT
--      p_from_street2       TEXT   — nullable
--      p_from_city          TEXT
--      p_from_state         TEXT
--      p_from_zip           TEXT
--      p_from_country       TEXT   — default 'US'
--      p_to_name            TEXT   — recipient full name
--      p_to_street1         TEXT
--      p_to_street2         TEXT   — nullable
--      p_to_city            TEXT
--      p_to_state           TEXT
--      p_to_zip             TEXT
--      p_to_country         TEXT   — default 'US'
--      p_carrier            TEXT
--      p_service            TEXT
--      p_tracking_number    TEXT   — nullable until label purchased
--      p_label_url          TEXT   — nullable until label purchased
--      p_easypost_shipment_id TEXT — nullable
--      p_easypost_tracker_id  TEXT — nullable
--      p_rate_cents         INTEGER
--      p_display_price_cents INTEGER
--      p_weight_oz          NUMERIC
--      p_length_in          NUMERIC
--      p_width_in           NUMERIC
--      p_height_in          NUMERIC
--      p_is_live            BOOLEAN
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
SET search_path = public
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
                    encode(gen_random_bytes(8), 'base64'),
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

COMMENT ON FUNCTION public.admin_insert_shipment IS
    'SECURITY DEFINER RPC that inserts a complete shipment record in FK order: '
    'addresses (from + to) → sendmo_links → shipments. '
    'Accepts p_user_id so it works for the system user (migration 004) now '
    'and real Supabase Auth users after login ships. '
    'Called by the labels Edge Function via the anon client — SECURITY DEFINER '
    'bypasses RLS so the function owner (service role) performs all writes. '
    'Returns the new shipments.id.';

-- Grant EXECUTE to the anon and authenticated roles so Edge Functions using
-- the anon key can call this RPC (the function body runs as the definer).
GRANT EXECUTE ON FUNCTION public.admin_insert_shipment TO anon, authenticated;
