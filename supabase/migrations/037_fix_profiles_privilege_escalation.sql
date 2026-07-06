-- Migration: 037_fix_profiles_privilege_escalation.sql
--
-- SECURITY FIX (pre-launch review 2026-07-06, Blocker 1).
-- Applied to prod fkxykvzsqdjzhurntgah on 2026-07-06 (see LOG.md).
-- Closes a privilege-escalation hole: ANY authenticated user could promote
-- themselves to admin (and force live_charge mode) with a single PostgREST
-- write.
--
-- ── The hole ────────────────────────────────────────────────────────────────
-- The profiles UPDATE policy (migration 001:196) is:
--     USING (auth.uid() = id)          -- and NO WITH CHECK
-- With no WITH CHECK, Postgres reuses the USING predicate as the check —
-- `auth.uid() = id` stays true no matter what OTHER columns change. Supabase's
-- default grants also give `authenticated` a TABLE-LEVEL UPDATE on profiles
-- (which covers every column). Net result, verified against prod 2026-07-06:
--     PATCH /rest/v1/profiles?id=eq.<my-uid>
--       { "role": "admin", "admin_active_mode": "live_charge" }
-- succeeds. The caller is now admin → comp labels (free real EasyPost labels
-- at SendMo's cost), admin-report / admin-user-detail (all-customer PII —
-- Rule 7), refunds, cancel-label. Exploitable today by anyone who can sign in.
--
-- ── The fix (table REVOKE + narrow column GRANT — NOT a column REVOKE) ───────
-- IMPORTANT gotcha: a column-level `REVOKE UPDATE (role) ...` does NOTHING
-- while a TABLE-level UPDATE grant exists — the table grant implies every
-- column, and has_column_privilege() keeps returning true. The only correct
-- fix is to revoke the table-level UPDATE, then grant UPDATE back on ONLY the
-- columns the browser client legitimately writes.
--
-- The client writes only `full_name` / `avatar_url` (src/contexts/AuthContext.tsx
-- :85-89). Everything else on profiles is written server-side (service_role via
-- edge functions, or the admin-gated set_admin_active_mode / set_account_budget
-- SECURITY DEFINER RPCs, which run as service_role and are unaffected by a
-- REVOKE on anon/authenticated). So:
--     REVOKE UPDATE ON public.profiles FROM anon, authenticated, public;
--     GRANT  UPDATE (full_name, avatar_url) ON public.profiles TO authenticated;
-- After this, PostgREST rejects any client statement that sets role /
-- admin_active_mode / stripe_customer_id_* / *_budget_cents with
-- "permission denied for column ..." — RLS is no longer the only gate.
--
-- INSERT is intentionally NOT touched: profiles has no INSERT RLS policy, so
-- authenticated INSERTs are already denied by RLS (row creation is the
-- handle_new_user SECURITY DEFINER trigger). The escalation vector was UPDATE.
--
-- Optional future hardening: a SECURITY DEFINER BEFORE-UPDATE trigger that
-- RAISEs if role/admin_active_mode changes outside service_role.
--
-- ── Apply instructions ──────────────────────────────────────────────────────
-- Already applied to prod 2026-07-06 via the Supabase MCP (execute_sql).
-- Re-running is safe (REVOKE/GRANT are idempotent). This file is the durable
-- record so the change survives a DB rebuild.
-- Post-apply checks (first three FALSE, last two TRUE):
--   SELECT has_column_privilege('authenticated','public.profiles','role','UPDATE');              -- f
--   SELECT has_column_privilege('authenticated','public.profiles','admin_active_mode','UPDATE'); -- f
--   SELECT has_column_privilege('authenticated','public.profiles','stripe_customer_id_live','UPDATE'); -- f
--   SELECT has_column_privilege('authenticated','public.profiles','full_name','UPDATE');          -- t
--   SELECT has_column_privilege('authenticated','public.profiles','avatar_url','UPDATE');         -- t

BEGIN;

REVOKE UPDATE ON public.profiles FROM anon, authenticated, public;

GRANT UPDATE (full_name, avatar_url) ON public.profiles TO authenticated;

COMMIT;
