-- Migration: 027_security_advisor_cleanup.sql
--
-- Clears the remaining safely-fixable Supabase security-advisor findings left
-- after migration 026 (which dropped the 7 dead Prisma/NextAuth tables and
-- cleared the 8 critical rls_disabled_in_public / sensitive_columns ERRORs).
--
-- This migration fixes 1 ERROR + 4 WARNs with three changes. None of them
-- alter application behaviour — they only tighten how existing objects run.
--
-- ── Fix 1: security_definer_view ERROR — public.user_wallet_balance ──────
--
-- The user_wallet_balance view (migration 017) is currently SECURITY DEFINER
-- (Postgres's default for views). It runs with the *creator's* privileges and
-- bypasses the querying user's RLS — so any caller who can SELECT the view
-- sees EVERY user's wallet balance, not just their own.
--
-- Fix: recreate it WITH (security_invoker = on) so it runs as the *querying*
-- user. The query itself is byte-identical to migration 017 — only the
-- security property changes.
--
-- Safety verified (2026-05-19):
--   * Underlying table public.transactions has RLS ENABLED with the policy
--     "Users can view own transactions" (SELECT, USING auth.uid() = user_id).
--   * Table-level grants: anon AND authenticated both hold SELECT on
--     public.transactions, so security_invoker callers clear the privilege
--     check; RLS then scopes rows to the caller.
--   * Net effect after the switch:
--       - authenticated user → sees only their own (user, mode) balance ✓
--       - anon → auth.uid() is NULL, RLS matches no rows → sees nothing
--         (STRICTER than today, where SECURITY DEFINER leaked all balances)
--       - service_role (Edge Functions) → bypasses RLS regardless → unaffected
--   * Codebase + Edge Function grep for "user_wallet_balance": the view has
--     ZERO readers today — only migration 017 defines it. 017's own comment
--     notes the "Phase 2 balance UI" will read it; security_invoker is exactly
--     the correct posture for that future per-user read. No reader breaks.
--
-- ── Fix 2: function_search_path_mutable WARN ×2 ─────────────────────────
--
-- public._gen_crockford_base32(integer) and public.block_transaction_mutations()
-- have no search_path pinned, so the value is inherited from the caller's
-- session — a search_path-injection vector for plpgsql functions. Standard
-- hardening: pin search_path on the function, with pg_temp last.
--
--   * _gen_crockford_base32 — body calls extensions.gen_random_bytes (the
--     reference is already schema-qualified, but per the advisor remediation
--     we still pin the path). extensions IS included so the function stays
--     resolvable if the qualification is ever dropped. The remaining builtins
--     (get_byte, substr) live in pg_catalog, which is always implicitly first.
--       → SET search_path = public, extensions, pg_temp
--   * block_transaction_mutations — body only RAISEs an exception, references
--     no schema objects at all.
--       → SET search_path = public, pg_temp
--
-- ── Fix 3: anon/authenticated_security_definer_function_executable WARN ──
--
-- public.handle_new_user() is the SECURITY DEFINER trigger function that
-- fires on auth.users INSERT to create the matching public.profiles row
-- (migration 001). It is NOT meant to be an RPC, but it currently carries
-- EXECUTE for anon + authenticated, so it is callable via
-- /rest/v1/rpc/handle_new_user — flagged by BOTH the anon (0028) and the
-- authenticated (0029) variants of the advisor.
--
-- Fix: REVOKE EXECUTE from anon, authenticated, public. Triggers run as part
-- of the INSERT regardless of role EXECUTE grants, so the on_auth_user_created
-- trigger is unaffected — profile auto-creation keeps working.
--
-- Trigger-only confirmed (2026-05-19):
--   * pg_trigger: handle_new_user backs exactly one trigger,
--     on_auth_user_created on auth.users — nothing else.
--   * Codebase grep: no .rpc("handle_new_user") call anywhere; the only
--     references are migration 001 (defines fn + trigger), migration 004 and
--     AuthContext.tsx (comments). Nothing invokes it as an RPC.
--   Revoking EXECUTE therefore removes the API surface with zero behavioural
--   impact. Clears both the 0028 (anon) and 0029 (authenticated) WARNs.
--
-- ── Out of scope (intentionally NOT touched) ────────────────────────────
--
-- admin_insert_shipment and set_admin_active_mode are also flagged
-- anon/authenticated-executable SECURITY DEFINER, but revoking their grants
-- could break label creation / the admin toolbar — that needs confirming
-- whether the labels Edge Function calls them with the service-role key.
-- Tracked as a separate follow-up in the payments handoff.
--
-- The auth WARNs (leaked-password protection, MFA options) and the 3
-- rls_enabled_no_policy INFOs (event_logs, notification_contacts,
-- notifications_log) are dashboard config / a separate review — not a
-- migration concern.
--
-- Reversible: each change can be undone (recreate the view without the
-- option; ALTER FUNCTION ... RESET search_path; GRANT EXECUTE back). No data
-- is touched.

BEGIN;

-- ── Fix 1: user_wallet_balance → security_invoker ───────────────────────
-- Query body is identical to migration 017 (§13). Only the security property
-- changes. CREATE OR REPLACE keeps the column set identical, as required.
CREATE OR REPLACE VIEW public.user_wallet_balance
WITH (security_invoker = on) AS
SELECT
    user_id,
    mode,
    SUM(
        CASE
            WHEN type IN ('balance_topup','balance_topup_bonus') THEN amount_cents
            WHEN type = 'balance_redeem'                          THEN -amount_cents
            ELSE 0
        END
    ) AS balance_cents,
    MAX(created_at) AS last_movement_at
FROM public.transactions
GROUP BY user_id, mode;

-- ── Fix 2: pin search_path on the two flagged functions ─────────────────
ALTER FUNCTION public._gen_crockford_base32(integer)
    SET search_path = public, extensions, pg_temp;

ALTER FUNCTION public.block_transaction_mutations()
    SET search_path = public, pg_temp;

-- ── Fix 3: revoke the unintended RPC surface on handle_new_user ─────────
-- The on_auth_user_created trigger is unaffected — triggers fire regardless
-- of EXECUTE grants.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated, public;

COMMIT;

-- ── Post-migration verification (run separately) ─────────────────────────
--
-- Fix 1 — view is now security_invoker:
--   SELECT relname, reloptions
--   FROM pg_class
--   WHERE relname = 'user_wallet_balance' AND relnamespace = 'public'::regnamespace;
--   -- Expect reloptions to contain 'security_invoker=on'.
--
-- Fix 2 — both functions now have search_path pinned:
--   SELECT p.oid::regprocedure AS signature, p.proconfig
--   FROM pg_proc p
--   WHERE p.proname IN ('_gen_crockford_base32','block_transaction_mutations')
--     AND p.pronamespace = 'public'::regnamespace;
--   -- Expect proconfig to contain the search_path setting for each row.
--
-- Fix 3 — handle_new_user no longer EXECUTE-able by anon/authenticated/public:
--   SELECT has_function_privilege('anon',          'public.handle_new_user()', 'EXECUTE') AS anon,
--          has_function_privilege('authenticated', 'public.handle_new_user()', 'EXECUTE') AS authenticated;
--   -- Expect both false.
--   -- Then confirm the trigger still exists:
--   SELECT tgname, tgrelid::regclass FROM pg_trigger
--   WHERE tgfoid = 'public.handle_new_user'::regproc;
--   -- Expect on_auth_user_created on auth.users.
--
-- Then re-run the Supabase security advisor — the security_definer_view
-- ERROR, the 2 function_search_path_mutable WARNs, and the anon + authenticated
-- security_definer_function_executable WARNs for handle_new_user should all be
-- gone (1 ERROR + 4 WARNs cleared).
