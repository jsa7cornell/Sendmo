-- =============================================================
-- SendMo — Cancel-flow Phase A: cancel_token + link lifecycle rename
-- Migration: 020_cancel_token_and_link_lifecycle.sql
--
-- Decided proposal:
-- proposals/2026-05-11_label-cancel-and-change_reviewed-2026-05-12_decided-2026-05-12.md
--
-- Three coordinated changes, all-or-nothing in one transaction:
--   1. shipments.cancel_token TEXT — random hex set at label-buy time,
--      authorizes anonymous just-shipped or post-email Cancel calls.
--   2. sendmo_links.status enum: rename 'used' → 'in_use', add 'completed'.
--      'used' was past-tense ambiguous; 'in_use' is present-tense honest.
--      'completed' is the new terminal-success state for shipments that
--      reached delivered / return_to_sender.
--   3. admin_insert_shipment RPC body update: literal 'used' → 'in_use'.
--      The RPC is the only code path that wrote the old value; everything
--      else either reads (in which case we add the new state) or writes
--      from this proposal's new code paths (which write the new values).
--
-- Apply via Supabase dashboard SQL editor on project fkxykvzsqdjzhurntgah,
-- per Rule 0.5. Migrations don't auto-apply.
--
-- Deploy order:
--   1. Run this migration in the dashboard SQL editor.
--   2. Verify with the post-migration queries at the bottom of this file.
--   3. Deploy the updated Edge Functions (labels, cancel-label, webhooks,
--      stripe-webhook, tracking) — each requires `--no-verify-jwt` per
--      the long-standing gotcha.
-- =============================================================

BEGIN;

-- ── 1. shipments.cancel_token ──────────────────────────────────────────
ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS cancel_token TEXT;

COMMENT ON COLUMN public.shipments.cancel_token IS
  'Random hex token set at label purchase; authorizes anonymous just-shipped or post-email Cancel via X-Cancel-Token header or /t/<code>?cancel=<token> URL. Constant-time compared. NULLed on consumption.';

CREATE INDEX IF NOT EXISTS idx_shipments_cancel_token
  ON public.shipments(cancel_token) WHERE cancel_token IS NOT NULL;

-- ── 2. sendmo_links.status enum: rename + add 'completed' ──────────────
-- Drop the existing CHECK constraint (Postgres doesn't let us extend an
-- enum-via-CHECK in place), rewrite the rows, then add the new constraint.
ALTER TABLE public.sendmo_links DROP CONSTRAINT IF EXISTS sendmo_links_status_check;

UPDATE public.sendmo_links SET status = 'in_use' WHERE status = 'used';

ALTER TABLE public.sendmo_links
  ADD CONSTRAINT sendmo_links_status_check
  CHECK (status IN ('draft', 'active', 'in_use', 'completed', 'expired', 'cancelled'));

COMMENT ON COLUMN public.sendmo_links.status IS
  'Link lifecycle: draft (unpublished) → active (claimable) → in_use (shipment in flight) → completed (shipment delivered/returned). Terminal-by-policy: completed, expired, cancelled. Migration 020 renamed used→in_use and added completed.';

-- ── 3. admin_insert_shipment RPC: 'used' → 'in_use' literal ────────────
-- Drop + recreate (single canonical signature post-018/019). Only the
-- INSERT INTO sendmo_links VALUES tuple changes; everything else is
-- preserved from migration 019.
DROP FUNCTION IF EXISTS public.admin_insert_shipment(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    INTEGER, INTEGER, NUMERIC, NUMERIC, NUMERIC, NUMERIC,
    BOOLEAN, DATE
);

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
        user_id, name, street1, street2, city, state, zip, country, is_verified
    ) VALUES (
        p_user_id, p_from_name, p_from_street1, p_from_street2,
        p_from_city, p_from_state, p_from_zip,
        COALESCE(p_from_country, 'US'), TRUE
    )
    RETURNING addresses.id INTO v_from_address_id;

    INSERT INTO public.addresses (
        user_id, name, street1, street2, city, state, zip, country, is_verified
    ) VALUES (
        p_user_id, p_to_name, p_to_street1, p_to_street2,
        p_to_city, p_to_state, p_to_zip,
        COALESCE(p_to_country, 'US'), TRUE
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
  'Canonical 29-param admin_insert_shipment. Returns (out_id, out_public_code, out_short_code). Migration 020 changed the link status literal from used → in_use as part of the link-lifecycle rename.';

GRANT EXECUTE ON FUNCTION public.admin_insert_shipment(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    INTEGER, INTEGER, NUMERIC, NUMERIC, NUMERIC, NUMERIC,
    BOOLEAN, DATE
) TO anon, authenticated;

COMMIT;

-- ── Post-migration verification queries (run separately, not inside the
--    transaction; these are SELECTs, no mutations) ───────────────────────
--
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name='shipments' AND column_name='cancel_token';
-- -- Expect 1 row.
--
-- SELECT status, count(*) FROM sendmo_links GROUP BY 1 ORDER BY 1;
-- -- Expect: zero 'used' rows; same total count as pre-migration.
--
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conrelid='public.sendmo_links'::regclass AND conname='sendmo_links_status_check';
-- -- Expect: CHECK with in_use + completed in the allowed set.
