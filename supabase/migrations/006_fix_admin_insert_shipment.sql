-- =============================================================
-- SendMo — Enable pgcrypto for gen_random_bytes
-- Migration: 006_fix_admin_insert_shipment.sql
-- =============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
