-- Migration: 026_drop_legacy_prisma_tables.sql
--
-- Drops 7 dead PascalCase tables left over from the pre-Supabase Prisma /
-- NextAuth backend: User, Account, Session, Address, Request, Event,
-- Notification.
--
-- Why: the Supabase security linter flags all 7 (ERROR `rls_disabled_in_public`)
-- — they sit in the `public` schema with RLS disabled, so anyone with the
-- project's anon key can read/write them. `Account` additionally trips
-- `sensitive_columns_exposed` because it carries NextAuth `access_token` /
-- `refresh_token` columns. (They're empty today, so nothing is actually
-- leaking — but the table existing + RLS-off means any future write would.)
--
-- Investigation (2026-05-19):
--   * Row counts: User/Account/Session/Request/Event/Notification = 0;
--     "Address" = 4 rows — all Feb-2026 Prisma-era test data (cuid IDs,
--     "231 Canyon Dr" EasyPost test verifications, userId=null orphans).
--   * No foreign keys from any live table reference these 7.
--   * No views or other DB objects depend on them.
--   * Zero codebase references — no `@prisma` imports, no `.from("User")`
--     etc. The app exclusively uses the snake_case tables (profiles,
--     addresses, sendmo_links, shipments, …). SendMo migrated to Supabase
--     Auth long ago; these are pure dead weight.
--
-- CASCADE: the only dependencies are NextAuth's intra-set FKs (Account.userId
-- → User.id, Session.userId → User.id). CASCADE clears those as the set is
-- dropped together; nothing external is affected (verified above).
--
-- Not reversible — but the dropped data is 4 rows of stale test addresses
-- and 6 empty tables. No production data is lost.

BEGIN;

DROP TABLE IF EXISTS public."Account"      CASCADE;  -- NextAuth OAuth tokens (empty)
DROP TABLE IF EXISTS public."Session"      CASCADE;  -- NextAuth sessions (empty)
DROP TABLE IF EXISTS public."Notification" CASCADE;  -- (empty)
DROP TABLE IF EXISTS public."Event"        CASCADE;  -- (empty)
DROP TABLE IF EXISTS public."Request"      CASCADE;  -- (empty)
DROP TABLE IF EXISTS public."Address"      CASCADE;  -- 4 Prisma-era test rows
DROP TABLE IF EXISTS public."User"         CASCADE;  -- NextAuth users (empty)

COMMIT;

-- ── Post-migration verification (run separately) ─────────────────────────
--
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema='public'
--   AND table_name IN ('User','Account','Session','Address','Request','Event','Notification');
-- -- Expect 0 rows.
--
-- Then re-run the Supabase security advisor — the 7 rls_disabled_in_public
-- ERRORs and the Account sensitive_columns_exposed ERROR should be gone.
