-- 016_add_profile_role.sql
--
-- Adds role-based admin auth to replace the hardcoded `2026` PIN gate on
-- /admin and the floating admin toolbar on /onboarding. Server-side checks
-- on admin-only Edge Functions (admin-report, cancel-label) read this column
-- via the requireAdmin helper in _shared/auth.ts.
--
-- This unblocks the Stripe proposal's Phase C "Live Charge" admin toolbar
-- mode, which must not ship behind a hardcoded PIN per decision #5
-- (2026-05-11). See LOG.md and
-- proposals/2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md
-- §11 #5.
--
-- Default = 'user' so every existing row is non-admin. Bootstrap John as
-- admin in the same migration so this lands without needing a follow-up
-- manual SQL run.

ALTER TABLE public.profiles
    ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
    CHECK (role IN ('user', 'admin'));

-- Partial index — `role = 'admin'` is rare; full index would be waste.
CREATE INDEX idx_profiles_role_admin
    ON public.profiles (role)
    WHERE role = 'admin';

COMMENT ON COLUMN public.profiles.role IS
    'Authorization role. Server-side admin checks read this column via _shared/auth.ts requireAdmin().';

-- Bootstrap John as admin.
-- Idempotent: if the row doesn''t exist yet (e.g. fresh local DB before John
-- signs in), the UPDATE matches zero rows and the migration still succeeds.
UPDATE public.profiles
    SET role = 'admin'
    WHERE email = 'jsa7cornell@gmail.com';
