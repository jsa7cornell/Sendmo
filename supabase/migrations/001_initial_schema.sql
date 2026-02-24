-- =============================================================
-- SendMo — Initial Database Schema
-- Migration: 001_initial_schema.sql
-- Tables: profiles, addresses, sendmo_links, shipments,
--         payments, balances, webhook_events
-- =============================================================


-- =============================================================
-- 1. PROFILES
-- Stores basic user info; auto-created on sign-up via trigger.
-- =============================================================
CREATE TABLE public.profiles (
    id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    full_name   TEXT,
    phone       TEXT,
    avatar_url  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.profiles IS 'User profile data, one row per auth.users entry.';

-- 2. ADDRESSES
-- Verified mailing addresses (EasyPost).
-- =============================================================
CREATE TABLE public.addresses (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    label        TEXT,                          -- e.g. "Home", "Office"
    name         TEXT NOT NULL,                 -- recipient / sender name
    street1      TEXT NOT NULL,
    street2      TEXT,
    city         TEXT NOT NULL,
    state        TEXT NOT NULL,
    zip          TEXT NOT NULL,
    country      TEXT NOT NULL DEFAULT 'US',
    phone        TEXT,
    is_verified  BOOLEAN NOT NULL DEFAULT FALSE,
    easypost_id  TEXT,                          -- EasyPost address id
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.addresses IS 'Mailing addresses owned by users, optionally verified via EasyPost.';

-- =============================================================
-- 3. SENDMO_LINKS
-- Each link is either a full_label or flexible link.
-- =============================================================
CREATE TABLE public.sendmo_links (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    short_code           TEXT NOT NULL UNIQUE,
    link_type            TEXT NOT NULL CHECK (link_type IN ('full_label', 'flexible')),
    status               TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'active', 'used', 'expired', 'cancelled')),
    recipient_address_id UUID NOT NULL REFERENCES public.addresses(id),
    sender_name          TEXT,
    max_price_cents      INTEGER NOT NULL DEFAULT 10000,  -- default $100
    preferred_speed      TEXT,
    preferred_carrier    TEXT,
    size_hint            TEXT,
    weight_hint_oz       NUMERIC,
    notes                TEXT,
    expires_at           TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.sendmo_links IS 'Shipping links created by recipients; full_label or flexible.';

-- =============================================================
-- 4. SHIPMENTS
-- One shipment per label purchase (tied to a link).
-- =============================================================
CREATE TABLE public.shipments (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    link_id                UUID NOT NULL REFERENCES public.sendmo_links(id) ON DELETE CASCADE,
    sender_address_id      UUID REFERENCES public.addresses(id),
    recipient_address_id   UUID NOT NULL REFERENCES public.addresses(id),
    easypost_shipment_id   TEXT,
    easypost_tracker_id    TEXT,
    carrier                TEXT NOT NULL,
    service                TEXT NOT NULL,
    tracking_number        TEXT,
    label_url              TEXT,
    rate_cents             INTEGER NOT NULL,    -- raw EasyPost rate
    display_price_cents    INTEGER NOT NULL,    -- price shown to user (with margin)
    status                 TEXT NOT NULL DEFAULT 'label_created'
                           CHECK (status IN (
                               'label_created','in_transit','out_for_delivery',
                               'delivered','return_to_sender','cancelled'
                           )),
    weight_oz              NUMERIC NOT NULL,
    length_in              NUMERIC NOT NULL,
    width_in               NUMERIC NOT NULL,
    height_in              NUMERIC NOT NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.shipments IS 'Shipment records with EasyPost label/tracking data.';

-- =============================================================
-- 5. PAYMENTS
-- Stripe payment intents linked to shipments.
-- =============================================================
CREATE TABLE public.payments (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id              UUID NOT NULL REFERENCES public.shipments(id) ON DELETE CASCADE,
    user_id                  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    stripe_payment_intent_id TEXT NOT NULL,
    amount_cents             INTEGER NOT NULL,
    capture_method           TEXT NOT NULL CHECK (capture_method IN ('automatic', 'manual')),
    status                   TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','authorized','captured','refunded','failed')),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.payments IS 'Stripe payments; automatic capture for full labels, manual for flexible links.';

-- =============================================================
-- 6. BALANCES
-- SendMo wallet balance per user (post-MVP).
-- =============================================================
CREATE TABLE public.balances (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.balances IS 'SendMo wallet balance per user (post-MVP feature).';

-- =============================================================
-- 7. WEBHOOK_EVENTS
-- Idempotent log of all inbound webhook events.
-- =============================================================
CREATE TABLE public.webhook_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source      TEXT NOT NULL CHECK (source IN ('stripe', 'easypost')),
    event_type  TEXT NOT NULL,
    event_id    TEXT NOT NULL UNIQUE,   -- external event id for idempotency
    payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
    processed   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.webhook_events IS 'Idempotent log of Stripe and EasyPost webhook events.';


-- =============================================================
-- PERFORMANCE INDEXES
-- =============================================================

-- Addresses
CREATE INDEX idx_addresses_user_id   ON public.addresses(user_id);

-- Sendmo Links
CREATE INDEX idx_links_user_id       ON public.sendmo_links(user_id);
CREATE INDEX idx_links_short_code    ON public.sendmo_links(short_code);
CREATE INDEX idx_links_status        ON public.sendmo_links(status);
CREATE INDEX idx_links_created_at    ON public.sendmo_links(created_at);

-- Shipments
CREATE INDEX idx_shipments_link_id      ON public.shipments(link_id);
CREATE INDEX idx_shipments_status       ON public.shipments(status);
CREATE INDEX idx_shipments_created_at   ON public.shipments(created_at);

-- Payments
CREATE INDEX idx_payments_user_id       ON public.payments(user_id);
CREATE INDEX idx_payments_shipment_id   ON public.payments(shipment_id);
CREATE INDEX idx_payments_status        ON public.payments(status);
CREATE INDEX idx_payments_created_at    ON public.payments(created_at);

-- Webhook Events
CREATE INDEX idx_webhook_source      ON public.webhook_events(source);
CREATE INDEX idx_webhook_processed   ON public.webhook_events(processed);
CREATE INDEX idx_webhook_created_at  ON public.webhook_events(created_at);


-- =============================================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================================

-- Enable RLS on all tables
ALTER TABLE public.profiles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.addresses      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sendmo_links   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.balances       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

-- ── Profiles ─────────────────────────────────────────────────
CREATE POLICY "Users can view own profile"
    ON public.profiles FOR SELECT
    USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
    ON public.profiles FOR UPDATE
    USING (auth.uid() = id);

-- ── Addresses ────────────────────────────────────────────────
CREATE POLICY "Users can view own addresses"
    ON public.addresses FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own addresses"
    ON public.addresses FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own addresses"
    ON public.addresses FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own addresses"
    ON public.addresses FOR DELETE
    USING (auth.uid() = user_id);

-- ── Sendmo Links ─────────────────────────────────────────────
-- Owners have full access; anyone can read active links (senders need them)
CREATE POLICY "Users can manage own links"
    ON public.sendmo_links FOR ALL
    USING (auth.uid() = user_id);

CREATE POLICY "Active links are publicly readable"
    ON public.sendmo_links FOR SELECT
    USING (status = 'active');

-- ── Shipments ────────────────────────────────────────────────
CREATE POLICY "Users can view shipments for own links"
    ON public.shipments FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.sendmo_links
            WHERE sendmo_links.id = shipments.link_id
              AND sendmo_links.user_id = auth.uid()
        )
    );

CREATE POLICY "Shipments insertable via service role only"
    ON public.shipments FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.sendmo_links
            WHERE sendmo_links.id = shipments.link_id
              AND sendmo_links.user_id = auth.uid()
        )
    );

-- ── Payments ─────────────────────────────────────────────────
CREATE POLICY "Users can view own payments"
    ON public.payments FOR SELECT
    USING (auth.uid() = user_id);

-- ── Balances ─────────────────────────────────────────────────
CREATE POLICY "Users can view own balance"
    ON public.balances FOR SELECT
    USING (auth.uid() = user_id);

-- ── Webhook Events ───────────────────────────────────────────
-- No direct user access; service role only
CREATE POLICY "No user access to webhook events"
    ON public.webhook_events FOR SELECT
    USING (false);


-- =============================================================
-- TRIGGER: Auto-create profile on auth.users insert
-- =============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.profiles (id, email)
    VALUES (NEW.id, NEW.email);
    RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();
