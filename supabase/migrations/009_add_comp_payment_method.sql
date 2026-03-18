-- =============================================================
-- Migration: 009_add_comp_payment_method.sql
-- Purpose: Support comp (complimentary) labels in the payments ledger.
--          Adds payment_method column ('card' | 'balance' | 'comp')
--          and makes stripe_payment_intent_id nullable for comp entries.
-- =============================================================

-- 1. Add payment_method column
ALTER TABLE public.payments
    ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'card'
    CHECK (payment_method IN ('card', 'balance', 'comp'));

-- 2. Make stripe_payment_intent_id nullable (comp labels have no Stripe intent)
ALTER TABLE public.payments
    ALTER COLUMN stripe_payment_intent_id DROP NOT NULL;

-- 3. Index for filtering by payment method
CREATE INDEX IF NOT EXISTS idx_payments_payment_method ON public.payments(payment_method);
