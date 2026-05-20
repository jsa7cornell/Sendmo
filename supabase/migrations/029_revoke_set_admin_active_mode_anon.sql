-- Migration: 029_revoke_set_admin_active_mode_anon.sql
--
-- Revokes the EXECUTE grant on set_admin_active_mode from the `anon` role,
-- clearing the Supabase security-advisor WARNING
-- (0028_anon_security_definer_function_executable).
--
-- ── Context ─────────────────────────────────────────────────────────────────
-- set_admin_active_mode(text) is a SECURITY DEFINER function. Its ACL,
-- verified 2026-05-20 via pg_proc.proacl, is:
--   {postgres=X, anon=X, authenticated=X, service_role=X}
-- — i.e. EXPLICIT per-role grants, NOT a PUBLIC grant. (Migration 028's
-- comment claimed "no anon grant exists" for this function — that was wrong:
-- anon holds an explicit EXECUTE grant. There is no PUBLIC grant here, so
-- unlike admin_insert_shipment this needs no `FROM public`.)
--
-- ── Why revoke only `anon` ──────────────────────────────────────────────────
-- The function is called from the browser (src/contexts/AuthContext.tsx) via
-- the anon-key Supabase client authenticated with the signed-in user's JWT —
-- so the Postgres role is `authenticated`. The `authenticated` grant is
-- LOAD-BEARING (the admin toolbar) and is KEPT. `anon` (a caller with no
-- session) has no legitimate reason to set an admin mode, so its grant is
-- revoked. `postgres` / `service_role` are untouched.
--
-- The advisor's `authenticated`-variant WARN for this function will REMAIN
-- after this migration — intentional and accepted. The function is only
-- consequential for real admins: everything downstream gates on `isAdmin`
-- (independent of the mode this function sets), so a non-admin `authenticated`
-- caller cannot escalate.
--
-- ── Apply instructions (John-only — agents must NOT apply) ──────────────────
-- Run in the Supabase SQL Editor for the production project.
-- Post-apply check:
--   SELECT has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_exec,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec
--   FROM   pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE  n.nspname = 'public' AND p.proname = 'set_admin_active_mode';
-- Expect: anon_exec = false, authenticated_exec = true.

BEGIN;

REVOKE EXECUTE ON FUNCTION public.set_admin_active_mode(TEXT) FROM anon;

COMMIT;
