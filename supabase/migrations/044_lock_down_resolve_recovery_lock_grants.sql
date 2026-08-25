-- =============================================================
-- Migration 044 — revoke anon/authenticated EXECUTE on resolve_recovery_lock
--
-- Found immediately after applying 043, by checking the grants rather than
-- trusting them.
--
-- 033 and 043 both ended with:
--     REVOKE ALL ON FUNCTION ... FROM PUBLIC;
--     GRANT EXECUTE ON FUNCTION ... TO service_role;
-- and 033 commented "service_role can call; anon and authenticated cannot."
-- That was never true. Supabase's default privileges grant EXECUTE on new
-- public-schema functions to `anon` and `authenticated` DIRECTLY, and
-- REVOKE ... FROM PUBLIC does not touch a role-specific grant. Verified against
-- production: has_function_privilege('anon', ..., 'EXECUTE') = true.
--
-- Why it matters NOW: resolve_recovery_lock is SECURITY DEFINER, reads
-- `transactions` and `stripe_intents`, and has NO internal caller check — it
-- trusts its three arguments. Exposed through PostgREST as
-- POST /rest/v1/rpc/resolve_recovery_lock, callable with the anon key that
-- ships in the frontend bundle, it would let anyone:
--   • read adjustment spend sums for any shipment_id / payment_method_id /
--     user_id they can guess or enumerate, and
--   • take a FOR UPDATE lock on an arbitrary shipments row (lock contention).
--
-- It was inert only because the function threw 42703 on every call. Repairing
-- it in 043 turned a dormant grant into a live one — the fix created the
-- exposure. This closes it.
--
-- Also revokes anon on set_account_budget. That one is NOT vulnerable: it
-- checks auth.uid() and requires profiles.role='admin', so an anon caller
-- always hits "Not authenticated". The grant is simply meaningless and an anon
-- role should not hold EXECUTE on a SECURITY DEFINER writer. `authenticated`
-- keeps it — admins call it from the client.
--
-- Contract for future SECURITY DEFINER functions in this project: REVOKE FROM
-- PUBLIC is not sufficient. Name anon and authenticated explicitly, then verify
-- with has_function_privilege() rather than assuming the REVOKE did it.
-- =============================================================

REVOKE EXECUTE ON FUNCTION public.resolve_recovery_lock(UUID, TEXT, UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.resolve_recovery_lock(UUID, TEXT, UUID) FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.set_account_budget(UUID, INTEGER, INTEGER) FROM anon;

-- service_role retains EXECUTE (granted in 043); edge functions call it under
-- the service-role key.
