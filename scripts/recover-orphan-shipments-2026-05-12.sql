-- =============================================================
-- One-shot recovery: 4 orphan LIVE shipments from 2026-05-12
--
-- These labels were bought from EasyPost (live key — real charges) between
-- 22:48 and 23:48 UTC on 2026-05-12 but the matching `admin_insert_shipment`
-- RPC call failed (pre-migration-019 param-shape mismatch). The labels were
-- printed and exist on EasyPost; our DB has zero record of them. John holds
-- the printed PDFs locally — `label_url` is left NULL because we don't have
-- the URL captured anywhere (EasyPost API has it; not pulled here).
--
-- Apply via Supabase dashboard SQL editor on project fkxykvzsqdjzhurntgah,
-- per Rule 0.5 (agents don't write to prod even for additive INSERTs;
-- MCP is read-only).
--
-- Decided 2026-05-13 in dogfood follow-up to the cancel-flow proposal.
--
-- Run-once. Safe to abort mid-way: each row is its own SELECT, no global
-- transaction. If a row succeeds and you re-run, it'll fail on a UNIQUE
-- constraint (easypost_shipment_id is unique). Comment out completed rows
-- and re-run if needed.
--
-- Pricing per PLAYBOOK §Pricing — display_price_cents = round(rate*1.15 + 1.00 dollars, cents):
--   $13.00 → 1595c  ($15.95)
--   $5.28  → 707c   ($7.07)
--   $5.48  → 730c   ($7.30)
--   $5.24  → 703c   ($7.03)
-- =============================================================

-- ── 1. UPSDAP — Chuckey TN → Portola Valley CA ──
SELECT * FROM admin_insert_shipment(
    p_user_id := '00de2967-adc6-42ea-80c8-36645f1ad27c',
    p_from_name := 'Recipient', p_from_street1 := '629 Sugar Bowl Road', p_from_street2 := NULL,
    p_from_city := 'Chuckey', p_from_state := 'TN', p_from_zip := '37641', p_from_country := 'US',
    p_to_name := 'John Anderson', p_to_street1 := '231 Canyon Drive', p_to_street2 := NULL,
    p_to_city := 'Portola Valley', p_to_state := 'CA', p_to_zip := '94028', p_to_country := 'US',
    p_carrier := 'UPSDAP', p_service := 'Ground', p_tracking_number := '1Z13J52C0333598579',
    p_label_url := NULL,
    p_easypost_shipment_id := 'shp_292351a9ef95418da127178d95fd3721',
    p_easypost_tracker_id := NULL,
    p_rate_cents := 1300, p_display_price_cents := 1595,
    p_weight_oz := 40, p_length_in := 13, p_width_in := 10, p_height_in := 5.5,
    p_is_live := TRUE, p_promised_delivery_date := NULL
);

-- ── 2. USPS — Truckee CA → Portola Valley CA ──
SELECT * FROM admin_insert_shipment(
    p_user_id := '00de2967-adc6-42ea-80c8-36645f1ad27c',
    p_from_name := 'Recipient', p_from_street1 := '629 Sugar Bowl Road', p_from_street2 := NULL,
    p_from_city := 'Truckee', p_from_state := 'CA', p_from_zip := '96161', p_from_country := 'US',
    p_to_name := 'JOHN ANDERSON', p_to_street1 := '231 CANYON DR', p_to_street2 := NULL,
    p_to_city := 'PORTOLA VALLEY', p_to_state := 'CA', p_to_zip := '94028-7808', p_to_country := 'US',
    p_carrier := 'USPS', p_service := 'GroundAdvantage', p_tracking_number := '9400136208303506138525',
    p_label_url := NULL,
    p_easypost_shipment_id := 'shp_257ff00659ca4d0e94a9f59076fc1d20',
    p_easypost_tracker_id := NULL,
    p_rate_cents := 528, p_display_price_cents := 707,
    p_weight_oz := 3, p_length_in := 9, p_width_in := 6, p_height_in := 1,
    p_is_live := TRUE, p_promised_delivery_date := NULL
);

-- ── 3. USPS — Pocatello ID → Portola Valley CA ──
SELECT * FROM admin_insert_shipment(
    p_user_id := '00de2967-adc6-42ea-80c8-36645f1ad27c',
    p_from_name := 'john anderson', p_from_street1 := '231 Canyon Drive', p_from_street2 := NULL,
    p_from_city := 'Pocatello', p_from_state := 'ID', p_from_zip := '83204', p_from_country := 'US',
    p_to_name := 'JOHN ANDERSON', p_to_street1 := '231 CANYON DR', p_to_street2 := NULL,
    p_to_city := 'PORTOLA VALLEY', p_to_state := 'CA', p_to_zip := '94028-7808', p_to_country := 'US',
    p_carrier := 'USPS', p_service := 'GroundAdvantage', p_tracking_number := '9400136208303506127482',
    p_label_url := NULL,
    p_easypost_shipment_id := 'shp_936e62c670ce43d880edac1cbd940e4d',
    p_easypost_tracker_id := NULL,
    p_rate_cents := 548, p_display_price_cents := 730,
    p_weight_oz := 2, p_length_in := 10, p_width_in := 7.5, p_height_in := 1,
    p_is_live := TRUE, p_promised_delivery_date := NULL
);

-- ── 4. USPS — Felton CA → Portola Valley CA ──
SELECT * FROM admin_insert_shipment(
    p_user_id := '00de2967-adc6-42ea-80c8-36645f1ad27c',
    p_from_name := 'john anderson', p_from_street1 := '232 Canyon Road', p_from_street2 := NULL,
    p_from_city := 'Felton', p_from_state := 'CA', p_from_zip := '95018', p_from_country := 'US',
    p_to_name := 'JOHN ANDERSON', p_to_street1 := '231 CANYON DR', p_to_street2 := NULL,
    p_to_city := 'PORTOLA VALLEY', p_to_state := 'CA', p_to_zip := '94028-7808', p_to_country := 'US',
    p_carrier := 'USPS', p_service := 'GroundAdvantage', p_tracking_number := '9400136208303506126430',
    p_label_url := NULL,
    p_easypost_shipment_id := 'shp_158867134dff4c61a71b3cb204e9746e',
    p_easypost_tracker_id := NULL,
    p_rate_cents := 524, p_display_price_cents := 703,
    p_weight_oz := 2, p_length_in := 10, p_width_in := 7, p_height_in := 1,
    p_is_live := TRUE, p_promised_delivery_date := NULL
);

-- ── Post-run verification (read-only — paste as a separate query) ──
-- SELECT public_code, is_live, is_test, status, tracking_number, easypost_shipment_id
-- FROM shipments WHERE easypost_shipment_id IN (
--   'shp_292351a9ef95418da127178d95fd3721',
--   'shp_257ff00659ca4d0e94a9f59076fc1d20',
--   'shp_936e62c670ce43d880edac1cbd940e4d',
--   'shp_158867134dff4c61a71b3cb204e9746e'
-- ) ORDER BY created_at DESC;
-- Expect 4 rows, all is_live=true, is_test=false, status='label_created', refund_status='none'.
