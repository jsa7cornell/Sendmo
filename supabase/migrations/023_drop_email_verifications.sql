-- Migration: 023_drop_email_verifications.sql
-- Drop the bespoke email OTP table. The flex onboarding flow (step 21) was
-- migrated to supabase.auth.signInWithOtp / verifyOtp in 2026-05-15.
-- The email Edge Function that wrote to this table has been deleted.
-- See: proposals/2026-05-15_flex-otp-supabase-migration-handoff.md

DROP TABLE IF EXISTS public.email_verifications;
