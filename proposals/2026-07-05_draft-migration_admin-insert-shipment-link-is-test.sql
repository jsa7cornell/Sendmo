-- Migration: 036_admin_insert_shipment_link_is_test.sql
--
-- Sets is_test on the per-shipment viewer link that admin_insert_shipment mints.
--
-- WHY: admin_insert_shipment (canonical form in migration 025) mints a
-- 'full_label' viewer link in public.sendmo_links (for the /t/ tracking page +
-- cancel token) but never sets is_test in that INSERT. The column defaults to
-- TRUE (migration 017: `is_test BOOLEAN NOT NULL DEFAULT TRUE`, a fail-safe),
-- so a LIVE shipment's auto-created viewer link is stamped is_test=true — its
-- mode disagrees with the shipment it belongs to.
--
-- This has been cosmetic/inert to date: nothing consumes the viewer link's
-- is_test for money decisions. cancel-label, tracking, and refunds all read
-- shipment.is_test (which admin_insert_shipment sets correctly to NOT p_is_live
-- in the shipments INSERT). The bug predates the T1-1 live-mode flip and was
-- deliberately deferred from the 2026-07-05 flex-PI-stitch fix to avoid
-- rushing a 100+-line SECURITY DEFINER function mid-launch (see LOG.md that
-- date). This migration is the follow-up hygiene fix.
--
-- THE ONE CHANGE: the `INSERT INTO public.sendmo_links (...)` gains an is_test
-- column set to `NOT p_is_live`, mirroring how the shipments INSERT already
-- derives is_test. Everything else in the function body is byte-identical to
-- migration 025 (the current live definition — migrations 027/028/029 after it
-- do NOT redefine the body: 027 lists admin_insert_shipment as explicitly out
-- of scope, 028 only REVOKEs EXECUTE grants, 029 touches set_admin_active_mode).
--
-- WHY CREATE OR REPLACE (not DROP + CREATE): the 31-param signature is
-- unchanged, so CREATE OR REPLACE matches the single existing overload with no
-- risk of the overload collision migration 018/025 guarded against. Crucially,
-- CREATE OR REPLACE PRESERVES the existing function ACL — so the anon +
-- authenticated EXECUTE revokes from migration 028 stay in force. This
-- migration intentionally adds NO GRANT statements; re-granting would silently
-- undo 028. Grants are left exactly as 028 left them (service_role/postgres
-- only, which is how the labels Edge Function calls it).
--
-- Reversible: re-apply migration 025's body to drop the is_test column from the
-- INSERT. No data is touched; only future viewer links are affected.

BEGIN;

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
                --
                -- is_test = NOT p_is_live (migration 036) — stamp the viewer
                -- link with the same mode as the shipment it belongs to.
                -- Without this the column fell back to its DEFAULT TRUE, so a
                -- live shipment's viewer link read is_test=true.
                INSERT INTO public.sendmo_links (
                    user_id, short_code, link_type, status,
                    recipient_address_id, sender_name, max_price_cents, is_test
                ) VALUES (
                    p_user_id, v_short_code, 'full_label', 'in_use',
                    v_to_address_id, p_from_name, p_display_price_cents, NOT p_is_live
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
  'Canonical 31-param admin_insert_shipment. Migration 025 appended p_from_phone + p_to_phone (DEFAULT NULL, FedEx/UPS phone requirement). Migration 036 sets the viewer link''s is_test = NOT p_is_live so its mode matches the shipment. Returns (out_id, out_public_code, out_short_code).';

COMMIT;

-- ── Post-migration verification (run separately) ─────────────────────────
--
-- Exactly one overload still exists (CREATE OR REPLACE matched, no collision):
--   SELECT proname, pronargs FROM pg_proc WHERE proname='admin_insert_shipment';
--   -- Expect exactly 1 row, pronargs = 31.
--
-- Grants unchanged by CREATE OR REPLACE — anon/authenticated still revoked (028):
--   SELECT has_function_privilege('anon',          'public.admin_insert_shipment(uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,integer,integer,numeric,numeric,numeric,numeric,boolean,date,text,text)', 'EXECUTE') AS anon,
--          has_function_privilege('authenticated', 'public.admin_insert_shipment(uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,integer,integer,numeric,numeric,numeric,numeric,boolean,date,text,text)', 'EXECUTE') AS authenticated;
--   -- Expect both false.
--
-- Behaviour — link mode now matches shipment mode:
--   -- A live insert (p_is_live=true) → viewer link is_test=false:
--   --   SELECT l.is_test AS link_is_test, s.is_test AS shipment_is_test
--   --   FROM shipments s JOIN sendmo_links l ON l.id = s.link_id
--   --   WHERE s.id = <out_id from a p_is_live=true call>;
--   --   -- Expect link_is_test=false, shipment_is_test=false.
--   -- A test insert (p_is_live=false) → viewer link is_test=true (both true).
