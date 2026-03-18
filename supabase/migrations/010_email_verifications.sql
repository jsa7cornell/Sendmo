-- =============================================================
-- SendMo — Email Verifications Table
-- Migration: 010_email_verifications.sql
-- Stores hashed OTP codes for email verification flow.
-- =============================================================

CREATE TABLE public.email_verifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT NOT NULL,
    code_hash   TEXT NOT NULL,          -- SHA-256 hash of the 6-digit OTP
    expires_at  TIMESTAMPTZ NOT NULL,   -- 10 minutes from creation
    attempts    INT NOT NULL DEFAULT 0, -- verify attempts (max 5)
    verified    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_verifications IS 'OTP codes for email verification during onboarding. Codes are SHA-256 hashed.';

-- Index for fast lookups by email + not-yet-verified + not-yet-expired
CREATE INDEX idx_email_verifications_lookup
    ON public.email_verifications (email, verified, expires_at DESC);

-- Cleanup: auto-delete expired rows older than 24 hours (pg_cron job)
-- Run: SELECT cron.schedule('cleanup-email-verifications', '0 * * * *',
--   $$DELETE FROM public.email_verifications WHERE expires_at < now() - INTERVAL '24 hours'$$);

-- RLS: email_verifications is only accessed via service role in Edge Functions
ALTER TABLE public.email_verifications ENABLE ROW LEVEL SECURITY;
-- No policies needed — all access is via service role client
