-- Migration: 028_revoke_admin_rpc_grants.sql
--
-- Revokes the EXECUTE grant on admin_insert_shipment from the anon and
-- authenticated Postgres roles, addressing the Supabase security advisor
-- WARNING (function_search_path_mutable / security_definer_exposed_to_public).
--
-- ── Why this is safe ────────────────────────────────────────────────────────
-- admin_insert_shipment is called by exactly ONE site in the codebase:
--   supabase/functions/labels/index.ts:849
-- That caller creates its Supabase client with SUPABASE_SERVICE_ROLE_KEY
-- (labels/index.ts lines 121–125), so the underlying Postgres role is
-- service_role. Service_role / postgres grants are NOT touched by this
-- migration — only the anon and authenticated grants are revoked. The labels
-- Edge Function will continue to work exactly as before.
--
-- CREATE FUNCTION grants EXECUTE to the PUBLIC pseudo-role by default, and
-- anon / authenticated INHERIT from PUBLIC — so revoking those two named
-- roles does nothing while PUBLIC still holds the grant. Migration 025 also
-- added explicit anon/authenticated GRANTs on top. This migration revokes
-- all three (anon, authenticated, PUBLIC). It was never intentionally needed
-- — no browser client or JWT-authenticated path ever called this RPC.
--
-- NOTE: the first apply (2026-05-20) revoked only `anon, authenticated` and
-- left PUBLIC, so the advisor stayed flagged. The `, public` below is the
-- correction; re-running is safe — REVOKE of an absent grant is a no-op.
--
-- ── Why set_admin_active_mode is NOT revoked here ───────────────────────────
-- set_admin_active_mode is called from the browser (src/contexts/AuthContext.tsx:174)
-- via the anon-key Supabase client authenticated with the user's JWT. That
-- means the Postgres role is `authenticated`. Migration 022 already has:
--   REVOKE EXECUTE ... FROM PUBLIC;
--   GRANT  EXECUTE ... TO authenticated;
-- (no anon grant exists). Revoking `authenticated` EXECUTE would break the
-- admin toolbar — the grant is load-bearing. No change is made here.
--
-- ── Impact ──────────────────────────────────────────────────────────────────
-- After this migration:
--   • Anyone who obtains the anon key (it is public) can no longer call
--     admin_insert_shipment via the PostgREST /rest/v1/rpc/ endpoint.
--   • The Supabase security advisor WARNING should clear.
--   • No production flow is affected.
--
-- ── Apply instructions (John-only — agents must NOT apply) ──────────────────
-- Run in the Supabase SQL Editor for the production project.
-- Post-apply check:
--   SELECT grantee, privilege_type
--   FROM   information_schema.routine_privileges
--   WHERE  routine_schema = 'public'
--     AND  routine_name   = 'admin_insert_shipment';
-- Expect: postgres + service_role only (no anon, no authenticated, no PUBLIC).

BEGIN;

REVOKE EXECUTE ON FUNCTION public.admin_insert_shipment(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    INTEGER, INTEGER, NUMERIC, NUMERIC, NUMERIC, NUMERIC,
    BOOLEAN, DATE, TEXT, TEXT
) FROM anon, authenticated, public;

COMMIT;
