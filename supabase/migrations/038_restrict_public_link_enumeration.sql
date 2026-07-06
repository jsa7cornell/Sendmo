-- Migration: 038_restrict_public_link_enumeration.sql
--
-- SECURITY FIX (pre-launch review 2026-07-06, finding M5).
-- Drops the RLS policy that lets ANY anonymous caller enumerate every active
-- shipping link via the PostgREST auto-API.
--
-- ── The exposure ────────────────────────────────────────────────────────────
-- Migration 001:223 created:
--     CREATE POLICY "Active links are publicly readable"
--       ON public.sendmo_links FOR SELECT USING (status = 'active');
-- Role is `public` (includes anon), so:
--     GET /rest/v1/sendmo_links?status=eq.active&select=*
-- returns EVERY active link's short_code, user_id, and max_price_cents to an
-- unauthenticated caller (verified against prod 2026-07-06). That leaks the
-- owner user_id + price cap of every open link and hands an attacker the full
-- set of short_codes to drive abusive flex charges against (bounded by cap /
-- Account Budget / Radar, and labels ship to the recipient's own address — so
-- it's card-abuse/griefing + SendMo-cost burn, not theft, but it should not be
-- anonymously enumerable).
--
-- ── Why dropping it is safe (verified) ──────────────────────────────────────
-- Nothing anonymous depends on this policy:
--   • The anonymous sender flow reads a link by short_code through the `links`
--     Edge Function (GET /functions/v1/links?code=…), which uses the SERVICE
--     ROLE client (links/index.ts:23-24) and bypasses RLS entirely.
--   • The only direct client reads of sendmo_links (Dashboard.tsx:230/243,
--     LinksEdit.tsx:43) are authenticated OWNER reads, already covered by the
--     "Users can manage own links" policy (USING auth.uid() = user_id).
-- So after this drop, owners still see their own links, the sender flow still
-- resolves links server-side, and anon can no longer enumerate the table.
--
-- If a future anonymous PostgREST read-by-short_code is ever wanted, replace
-- this with a policy that requires an exact short_code match rather than a
-- blanket status filter — never re-open the whole active set.
--
-- ── Apply status ────────────────────────────────────────────────────────────
-- Applied to prod fkxykvzsqdjzhurntgah on 2026-07-06 via the Supabase MCP
-- (DROP POLICY — tightening + reversible; John authorized). Verified: only the
-- owner-scoped "Users can manage own links" policy remains. This file is the
-- durable record; re-running is safe (DROP ... IF EXISTS).
-- Post-apply check (expect 0 rows):
--   SELECT policyname FROM pg_policies
--    WHERE schemaname='public' AND tablename='sendmo_links'
--      AND policyname='Active links are publicly readable';
-- Regression: as an anon client, GET /rest/v1/sendmo_links?status=eq.active
-- returns [] (was: all active links). Sign in as a link owner → Dashboard
-- still lists their links. Open a sender link /s/<short_code> → still resolves.

BEGIN;

DROP POLICY IF EXISTS "Active links are publicly readable" ON public.sendmo_links;

COMMIT;
