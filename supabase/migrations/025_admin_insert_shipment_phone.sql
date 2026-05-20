-- Migration: 025_admin_insert_shipment_phone.sql
--
-- Adds phone numbers to the addresses created by admin_insert_shipment.
--
-- Why: FedEx and UPS reject EasyPost label purchases without a phone number
-- on both shipper and recipient addresses (PHONENUMBEREMPTY). As of 2026-05-19
-- every SendMo address-entry form collects a phone, but admin_insert_shipment
-- (the RPC the labels Edge Function uses to persist full-label + flex-link
-- shipments) had no p_from_phone / p_to_phone parameters, so the phone was
-- silently dropped on the way into the addresses table.
--
-- DEPLOY-ORDERING SAFETY: the two new params are appended at the END of the
-- signature with DEFAULT NULL. Combined with the fact that the labels Edge
-- Function calls this RPC with NAMED parameters, this makes the change
-- zero-downtime regardless of whether the migration or the Edge Function
-- deploys first:
--   * old labels fn (29 named params) → matches the 31-param function; the
--     two phone params fall back to their DEFAULT NULL. Works.
--   * new labels fn (31 named params) → matches directly. Works.
-- There is no window where label buys break. (Postgres requires that once a
-- parameter has a default, every parameter after it also has one — appending
-- at the end satisfies that; inserting mid-signature would not.)
--
-- OVERLOAD-COLLISION SAFETY (per migration 018/019 history): we DROP the
-- exact existing 29-param signature FIRST, then CREATE the 31-param version.
-- CREATE OR REPLACE only matches an identical signature, so without the
-- explicit DROP we'd end up with two overloads and the PostgREST "could not
-- choose the best candidate function" error that migration 018 fixed.
--
-- Function body is otherwise byte-identical to migration 020 (the prior
-- canonical definition) — only the two new trailing params + two new INSERT
-- columns change.

BEGIN;

-- ── 1. Drop the exact 29-param signature from migration 020 ──────────────
DROP FUNCTION IF EXISTS public.admin_insert_shipment(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    INTEGER, INTEGER, NUMERIC, NUMERIC, NUMERIC, NUMERIC,
    BOOLEAN, DATE
);

-- ── 2. Recreate with p_from_phone + p_to_phone appended (31 params) ──────
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
    p_promised_delivery_date DATE DEFAULT NULL,
    p_from_phone             TEXT DEFAULT NULL,
    p_to_phone               TEXT DEFAULT NULL
)
RETURNS TABLE(out_id UUID, out_public_code TEXT, out_short_code TEXT)
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
    INSERT INTO public.addresses (
        user_id, name, street1, street2, city, state, zip, country, phone, is_verified
    ) VALUES (
        p_user_id, p_from_name, p_from_street1, p_from_street2,
        p_from_city, p_from_state, p_from_zip,
        COALESCE(p_from_country, 'US'), p_from_phone, TRUE
    )
    RETURNING addresses.id INTO v_from_address_id;

    INSERT INTO public.addresses (
        user_id, name, street1, street2, city, state, zip, country, phone, is_verified
    ) VALUES (
        p_user_id, p_to_name, p_to_street1, p_to_street2,
        p_to_city, p_to_state, p_to_zip,
        COALESCE(p_to_country, 'US'), p_to_phone, TRUE
    )
    RETURNING addresses.id INTO v_to_address_id;

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
                -- 'in_use' (was 'used' pre-migration 020) — full-label links
                -- are minted at in_use because the label is bought in the
                -- same sitting as link creation.
                INSERT INTO public.sendmo_links (
                    user_id, short_code, link_type, status,
                    recipient_address_id, sender_name, max_price_cents
                ) VALUES (
                    p_user_id, v_short_code, 'full_label', 'in_use',
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

    v_attempt := 0;
    LOOP
        v_public_code := public._gen_crockford_base32(7);
        IF NOT EXISTS (SELECT 1 FROM public.shipments s WHERE s.public_code = v_public_code) THEN
            EXIT;
        END IF;
        v_attempt := v_attempt + 1;
        IF v_attempt >= 5 THEN
            RAISE EXCEPTION 'Could not generate unique public_code after 5 attempts';
        END IF;
    END LOOP;

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

    out_id := v_shipment_id;
    out_public_code := v_public_code;
    out_short_code := v_short_code;
    RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.admin_insert_shipment IS
  'Canonical 31-param admin_insert_shipment (migration 025 appended p_from_phone + p_to_phone, DEFAULT NULL, for the FedEx/UPS phone requirement). Returns (out_id, out_public_code, out_short_code).';

GRANT EXECUTE ON FUNCTION public.admin_insert_shipment(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    INTEGER, INTEGER, NUMERIC, NUMERIC, NUMERIC, NUMERIC,
    BOOLEAN, DATE, TEXT, TEXT
) TO anon, authenticated;

COMMIT;

-- ── Post-migration verification (run separately) ─────────────────────────
--
-- SELECT proname, pronargs FROM pg_proc WHERE proname='admin_insert_shipment';
-- -- Expect exactly 1 row, pronargs = 31. If 2 rows, the DROP didn't match —
-- -- the overload collision is back; investigate before any label buy.
