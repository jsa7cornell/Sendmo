-- =============================================================
-- SendMo — Stripe Phase A: Transactions Ledger
-- Migration: 017_stripe_phase_a_transactions_ledger.sql
--
-- Decided proposal:
--   proposals/2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md
--   §3.1 schema, §3.2 RLS, §3.3 user_wallet_balance view, §6 Phase A gating.
--
-- WHAT THIS DOES (atomic — Postgres wraps migrations in a single transaction;
-- if any statement fails the whole file rolls back and the DB is at 016):
--
--   1. ALTER profiles      → add stripe_customer_id_test, stripe_customer_id_live
--   2. ALTER sendmo_links  → add is_test (NOT NULL DEFAULT TRUE; fail-safe)
--   3. ALTER shipments     → add payment_method (CHECK constraint),
--                            stripe_payment_intent_id (Phase 3 slot),
--                            escrow_id (Phase 3 slot)
--   4. Backfill shipments.payment_method from legacy payments rows
--   5. CREATE transactions (append-only ledger — Rule 16 enforcement)
--   6. CREATE stripe_intents (Stripe state mirror, NOT the ledger)
--   7. CREATE payment_methods (saved cards / ACH for Phase B+)
--   8. CREATE holds (flex-link authorizations for Phase E)
--   9. CREATE refunds (Phase F refund mirror)
--  10. CREATE carrier_adjustments (Phase G post-pickup recovery)
--  11. Backfill transactions from legacy payments rows
--  12. DROP TABLE payments  (point of no return — backfill must complete first)
--  13. CREATE VIEW user_wallet_balance (derived from transactions)
--  14. RLS policies on all new tables
--  15. Idempotent system-profile bootstrap for the comp-mode placeholder UUID
--
-- ROLLBACK STORY: There is none beyond Postgres' implicit transaction. Either
-- the migration fully lands (we're at 017) or fully reverts (we're at 016).
-- There is no partial state. If 017 errors on production, fix the failing
-- statement in this file and re-apply — the DB is unchanged.
--
-- RULE 16 ENFORCEMENT: transactions is append-only. Two belt-and-suspenders
-- mechanisms:
--   (a) REVOKE UPDATE, DELETE from all roles (incl. service_role)
--   (b) BEFORE UPDATE/DELETE trigger that raises an exception
-- Either layer alone would suffice; both are present so future migrations
-- accidentally granting UPDATE don't silently weaken the invariant.
-- =============================================================


-- =============================================================
-- 1. profiles — Stripe Customer pointers (test + live separation)
-- =============================================================
ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS stripe_customer_id_test TEXT,
    ADD COLUMN IF NOT EXISTS stripe_customer_id_live TEXT;

COMMENT ON COLUMN public.profiles.stripe_customer_id_test IS
    'Stripe Customer ID created against test-mode keys. Lazily populated on '
    'first PaymentIntent/SetupIntent in test mode (Phase B+). NULL until then.';
COMMENT ON COLUMN public.profiles.stripe_customer_id_live IS
    'Stripe Customer ID created against live-mode keys. Lazily populated on '
    'first PaymentIntent/SetupIntent in live mode (Phase B+). NULL until then.';


-- =============================================================
-- 2. sendmo_links — Server-derived test/live flag (round-1 B3 fail-safe)
-- =============================================================
ALTER TABLE public.sendmo_links
    ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.sendmo_links.is_test IS
    'Server-derived: TRUE for test-mode links (synthetic Stripe + EasyPost), '
    'FALSE for live links (real money). Default TRUE is fail-safe: any link '
    'predating this column is treated as test until proven live by an admin '
    'path. Per proposal §4.4 mode resolution chain — NEVER trust the client '
    'for this value; the link create endpoint derives it from admin role + '
    'admin_toolbar_mode server-side. Phase B+ reads this column to pick the '
    'test vs live Stripe secret key.';


-- =============================================================
-- 3. shipments — payment_method discriminator + Phase 3 slots
-- =============================================================
ALTER TABLE public.shipments
    ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'card'
        CHECK (payment_method IN ('card','balance','split','comp','us_bank_account')),
    ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT,
    ADD COLUMN IF NOT EXISTS escrow_id UUID;

COMMENT ON COLUMN public.shipments.payment_method IS
    'How this shipment was paid for. Moved off the legacy payments table '
    '(dropped in this migration) so it survives the DROP. ''comp'' is the '
    'discriminator the labels function uses to gate the no-Stripe path. '
    '''split'' covers Phase 2 balance-partial + card-rest. ''us_bank_account'' '
    'is reserved for Phase H ACH topup → balance → redeem flows. Per Rule 14, '
    'set server-side at shipment creation; never trust the client.';
COMMENT ON COLUMN public.shipments.stripe_payment_intent_id IS
    'Single PaymentIntent per shipment. NULL for comp shipments. Phase 3 escrow '
    'reuses this same column — escrow is single-PI + separate transfer per '
    '§3.8, not a separate PI per role.';
COMMENT ON COLUMN public.shipments.escrow_id IS
    'Phase 3 forward-compat slot. FK constraint to escrows(id) is added when '
    'that table ships. NULL for every shipment in MVP scope.';

-- Backfill payment_method from existing payments rows BEFORE DROP TABLE.
-- In current production this is almost entirely comp test data.
UPDATE public.shipments s
   SET payment_method = COALESCE(
       (SELECT payment_method FROM public.payments
         WHERE shipment_id = s.id
         ORDER BY created_at DESC
         LIMIT 1),
       'card'
   );


-- =============================================================
-- 5. transactions — THE LEDGER (append-only, never UPDATE, never DELETE)
--
-- Signed amount_cents: positive = SendMo gains, negative = SendMo loses.
-- This is the single source of truth for "what money moved." The Stripe
-- intent/charge IDs are mirrored from stripe_intents but the ledger row is
-- the canonical record. Reconciliation reads this table, not stripe_intents.
-- =============================================================
CREATE TABLE IF NOT EXISTS public.transactions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES public.profiles(id),
    shipment_id      UUID REFERENCES public.shipments(id),
    link_id          UUID REFERENCES public.sendmo_links(id),
    stripe_intent_id TEXT,
    stripe_charge_id TEXT,
    type             TEXT NOT NULL CHECK (type IN (
                         'charge',                -- customer paid
                         'fee_stripe',            -- Stripe processing fee
                         'refund',                -- money back to customer
                         'refund_fee_recovered',  -- Stripe app-fee returned on refund
                         'comp_grant',            -- comp label, no payment (negative)
                         'balance_topup',         -- prepay wallet (Phase 2/H)
                         'balance_topup_bonus',   -- topup discount/incentive (§3.6)
                         'balance_redeem',        -- spend from wallet
                         'carrier_adjustment',    -- post-pickup reweigh etc. (§3.7)
                         'chargeback',            -- dispute lost
                         'adjustment'             -- manual admin correction (rare)
                     )),
    funding_source   TEXT CHECK (funding_source IN
                         ('card','balance','split','us_bank_account','comp')),
    amount_cents     INTEGER NOT NULL,
    description      TEXT,
    mode             TEXT NOT NULL CHECK (mode IN ('test','live')),
    idempotency_key  TEXT NOT NULL UNIQUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.transactions IS
    'Append-only money-movement ledger (Rule 16). REVOKE UPDATE/DELETE + trigger '
    'enforce immutability. Signed amount_cents (+ = SendMo gains, − = SendMo '
    'loses). idempotency_key UNIQUE deduplicates webhook retries. Per proposal '
    '§4.3 the stripe-webhook function is the sole writer for charge/refund/'
    'chargeback rows; the labels function writes only comp_grant rows. Read by '
    'the admin reconciliation report (filter by mode=''live'' for the default '
    'view) and by user_wallet_balance view.';
COMMENT ON COLUMN public.transactions.amount_cents IS
    'Signed integer cents. Positive = SendMo gains (charge, refund_fee_recovered, '
    'balance_topup, balance_topup_bonus). Negative = SendMo loses (refund, '
    'comp_grant, balance_redeem, chargeback, fee_stripe). The signed convention '
    'lets the wallet view sum without case statements.';
COMMENT ON COLUMN public.transactions.idempotency_key IS
    'UNIQUE — dedups webhook retries and replayed events. Patterns: '
    '''stripe.<event.id>:charge'', ''stripe.<event.id>:refund'', '
    '''label.<easypost_shipment_id>.comp'', ''backfill.<payments.id>.charge''.';
COMMENT ON COLUMN public.transactions.mode IS
    'Implicit from which Stripe webhook secret verified the event. Every '
    'reconciliation query MUST filter by mode to keep test data from polluting '
    'live margin.';

-- Rule 16 enforcement layer 1: REVOKE write privileges from every role.
-- service_role retains SELECT + INSERT only.
REVOKE UPDATE, DELETE ON public.transactions FROM PUBLIC;
REVOKE UPDATE, DELETE ON public.transactions FROM anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.transactions TO service_role;

-- Rule 16 enforcement layer 2: trigger that raises on UPDATE/DELETE. This
-- catches the case where a future migration accidentally re-grants UPDATE.
CREATE OR REPLACE FUNCTION public.block_transaction_mutations()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'transactions is append-only (Rule 16). UPDATE/DELETE blocked. '
                    'Record a compensating row instead (type=adjustment).';
END;
$$;

CREATE TRIGGER no_update_transactions
    BEFORE UPDATE ON public.transactions
    FOR EACH ROW EXECUTE FUNCTION public.block_transaction_mutations();
CREATE TRIGGER no_delete_transactions
    BEFORE DELETE ON public.transactions
    FOR EACH ROW EXECUTE FUNCTION public.block_transaction_mutations();

-- Performance indexes per §3.1.
CREATE INDEX IF NOT EXISTS idx_tx_user_created    ON public.transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_shipment        ON public.transactions (shipment_id);
CREATE INDEX IF NOT EXISTS idx_tx_intent          ON public.transactions (stripe_intent_id);
CREATE INDEX IF NOT EXISTS idx_tx_mode_created    ON public.transactions (mode, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_type            ON public.transactions (type);


-- =============================================================
-- 6. stripe_intents — Stripe state mirror (NOT the ledger)
--
-- One row per PaymentIntent or SetupIntent we create. Tracks Stripe state
-- separately from ledger movement. funding_source intentionally excludes
-- 'split' here: a single Stripe intent has exactly one funding source. The
-- 'split' case lives only in transactions (balance_redeem + charge rows).
-- =============================================================
CREATE TABLE IF NOT EXISTS public.stripe_intents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES public.profiles(id),
    link_id             UUID REFERENCES public.sendmo_links(id),
    shipment_id         UUID REFERENCES public.shipments(id),
    stripe_intent_id    TEXT NOT NULL UNIQUE,
    intent_kind         TEXT NOT NULL CHECK (intent_kind IN ('payment','setup')),
    intent_role         TEXT CHECK (intent_role IN ('shipment','topup','flex_hold')),
    capture_method      TEXT CHECK (capture_method IN ('automatic','manual')),
    funding_source      TEXT CHECK (funding_source IN
                            ('card','balance','us_bank_account')),
    amount_cents        INTEGER,
    captured_cents      INTEGER,
    status              TEXT NOT NULL,
    mode                TEXT NOT NULL CHECK (mode IN ('test','live')),
    transfer_group      TEXT,
    idempotency_key     TEXT NOT NULL UNIQUE,
    last_event_at       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.stripe_intents IS
    'Mirror of Stripe PaymentIntent / SetupIntent state. NOT the ledger — that''s '
    'transactions. UPSERT-by-stripe_intent_id by the stripe-webhook function as '
    'lifecycle events arrive. transfer_group is the Connect seam for Phase 3 '
    'escrow (sm_<shipment_id>).';

CREATE INDEX IF NOT EXISTS idx_intents_user     ON public.stripe_intents (user_id);
CREATE INDEX IF NOT EXISTS idx_intents_link     ON public.stripe_intents (link_id);
CREATE INDEX IF NOT EXISTS idx_intents_shipment ON public.stripe_intents (shipment_id);
CREATE INDEX IF NOT EXISTS idx_intents_xfergrp  ON public.stripe_intents (transfer_group);


-- =============================================================
-- 7. payment_methods — Saved cards / ACH (Phase B+)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.payment_methods (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    stripe_payment_method_id TEXT NOT NULL,
    mode                     TEXT NOT NULL CHECK (mode IN ('test','live')),
    funding_source           TEXT NOT NULL CHECK (funding_source IN
                                 ('card','us_bank_account')) DEFAULT 'card',
    brand                    TEXT,
    last4                    TEXT,
    exp_month                INTEGER,
    exp_year                 INTEGER,
    bank_name                TEXT,
    is_default               BOOLEAN NOT NULL DEFAULT FALSE,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at               TIMESTAMPTZ,
    UNIQUE (user_id, stripe_payment_method_id)
);

COMMENT ON TABLE public.payment_methods IS
    'Saved payment methods (cards in Phase B, ACH in Phase H). Soft-delete via '
    'deleted_at preserves audit trail. is_default is partial-unique per (user, '
    'mode) below.';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_default_pm_per_user_mode
    ON public.payment_methods (user_id, mode)
    WHERE is_default = TRUE AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pm_user_mode
    ON public.payment_methods (user_id, mode)
    WHERE deleted_at IS NULL;


-- =============================================================
-- 8. holds — Flex-link authorizations (Phase E)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.holds (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    link_id              UUID NOT NULL REFERENCES public.sendmo_links(id),
    stripe_intent_id     TEXT NOT NULL UNIQUE,
    amount_cents         INTEGER NOT NULL,
    capture_target_cents INTEGER,
    status               TEXT NOT NULL CHECK (status IN
                            ('authorized','captured','partially_captured',
                             'voided','expired','failed')),
    authorized_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    captured_at          TIMESTAMPTZ,
    voided_at            TIMESTAMPTZ,
    expires_at           TIMESTAMPTZ NOT NULL,
    mode                 TEXT NOT NULL CHECK (mode IN ('test','live'))
);

COMMENT ON TABLE public.holds IS
    'Flex-link manual-capture PaymentIntents (Phase E). amount_cents is the '
    'authorized cap (priceCap-clamped per §3.5). Stripe auto-voids cards at '
    'expires_at (7d typical); a nightly cron backs up missed webhooks.';

CREATE INDEX IF NOT EXISTS idx_holds_status ON public.holds (status, expires_at);


-- =============================================================
-- 9. refunds — Refund mirror (Phase F)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.refunds (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id              UUID NOT NULL REFERENCES public.shipments(id),
    stripe_refund_id         TEXT NOT NULL UNIQUE,
    stripe_payment_intent_id TEXT NOT NULL,
    amount_cents             INTEGER NOT NULL,
    reason                   TEXT,
    status                   TEXT NOT NULL,
    easypost_void_id         TEXT,
    mode                     TEXT NOT NULL CHECK (mode IN ('test','live')),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.refunds IS
    'Mirror of Stripe Refund objects (Phase F). amount_cents is positive (the '
    'transactions row for the same refund is negative — signed convention). '
    'easypost_void_id links to the carrier-side void if applicable.';

CREATE INDEX IF NOT EXISTS idx_refunds_shipment ON public.refunds (shipment_id);


-- =============================================================
-- 10. carrier_adjustments — Post-pickup recovery log (Phase G)
-- Must be created AFTER transactions because recovery_tx_id FKs there.
-- =============================================================
CREATE TABLE IF NOT EXISTS public.carrier_adjustments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id     UUID NOT NULL REFERENCES public.shipments(id),
    source          TEXT NOT NULL DEFAULT 'easypost',
    source_event_id TEXT,
    delta_cents     INTEGER NOT NULL,
    reason          TEXT,
    recovery_status TEXT NOT NULL CHECK (recovery_status IN
                       ('pending','recovered','absorbed','disputed')),
    recovery_tx_id  UUID REFERENCES public.transactions(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at     TIMESTAMPTZ
);

COMMENT ON TABLE public.carrier_adjustments IS
    'Post-pickup rate adjustments from EasyPost (USPS reweighs, UPS dim '
    'adjustments, address-correction surcharges). Recovery loop ships in '
    'Phase G (§3.7). delta_cents positive = carrier charged us more.';

CREATE INDEX IF NOT EXISTS idx_carrier_adj_status ON public.carrier_adjustments (recovery_status);


-- =============================================================
-- 11. Backfill transactions from legacy payments rows
--
-- Three passes for the three observable shapes of existing rows:
--   (a) comp rows           → type='comp_grant', amount NEGATIVE
--   (b) captured card rows  → type='charge',    amount POSITIVE
--   (c) refunded rows       → type='refund',    amount NEGATIVE
--
-- mode derives from shipments.is_live so test/live separation is preserved.
-- idempotency_key uses the legacy payments.id so re-running the backfill
-- would be a no-op (UNIQUE constraint catches duplicates).
-- =============================================================

-- (a) comp_grant backfill (negative — SendMo absorbs EasyPost cost)
INSERT INTO public.transactions
    (user_id, shipment_id, type, funding_source, amount_cents, mode,
     idempotency_key, description, created_at)
SELECT
    p.user_id,
    p.shipment_id,
    'comp_grant',
    'comp',
    -ABS(COALESCE(s.rate_cents, p.amount_cents)),
    CASE WHEN s.is_live THEN 'live' ELSE 'test' END,
    'backfill.' || p.id::text || '.comp_grant',
    'Backfilled from payments (comp) at migration 017',
    p.created_at
FROM public.payments p
JOIN public.shipments s ON s.id = p.shipment_id
WHERE p.payment_method = 'comp'
ON CONFLICT (idempotency_key) DO NOTHING;

-- (b) charge backfill (positive — card / balance captured)
INSERT INTO public.transactions
    (user_id, shipment_id, type, funding_source, amount_cents, stripe_intent_id,
     mode, idempotency_key, description, created_at)
SELECT
    p.user_id,
    p.shipment_id,
    'charge',
    p.payment_method,
    p.amount_cents,
    p.stripe_payment_intent_id,
    CASE WHEN s.is_live THEN 'live' ELSE 'test' END,
    'backfill.' || p.id::text || '.charge',
    'Backfilled from payments (charge) at migration 017',
    p.created_at
FROM public.payments p
JOIN public.shipments s ON s.id = p.shipment_id
WHERE p.payment_method IN ('card','balance')
  AND p.status = 'captured'
ON CONFLICT (idempotency_key) DO NOTHING;

-- (c) refund backfill (negative — money returned to customer)
-- Triggered by either payments.status='refunded' or shipments.refund_status='refunded'.
INSERT INTO public.transactions
    (user_id, shipment_id, type, funding_source, amount_cents, stripe_intent_id,
     mode, idempotency_key, description, created_at)
SELECT
    p.user_id,
    p.shipment_id,
    'refund',
    p.payment_method,
    -ABS(p.amount_cents),
    p.stripe_payment_intent_id,
    CASE WHEN s.is_live THEN 'live' ELSE 'test' END,
    'backfill.' || p.id::text || '.refund',
    'Backfilled from payments (refund) at migration 017',
    COALESCE(s.refund_submitted_at, p.updated_at, p.created_at)
FROM public.payments p
JOIN public.shipments s ON s.id = p.shipment_id
WHERE p.status = 'refunded' OR s.refund_status = 'refunded'
ON CONFLICT (idempotency_key) DO NOTHING;


-- =============================================================
-- 12. DROP TABLE payments — point of no return
--
-- Nothing else references this table. The labels function and stripe-webhook
-- function are rewritten in the same PR to use transactions instead. The
-- admin-report function is also rewritten. After this statement, the only
-- record of the legacy payments rows lives in the transactions backfill above.
-- =============================================================
DROP TABLE public.payments;


-- =============================================================
-- 13. user_wallet_balance — derived view (Rule 16)
--
-- View, not materialized. Keeps the "no balance to UPDATE" invariant honest:
-- the wallet is always re-derived from transactions. Cheap until the ledger
-- exceeds ~1M rows; can be materialized later without breaking the schema.
-- =============================================================
CREATE OR REPLACE VIEW public.user_wallet_balance AS
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

COMMENT ON VIEW public.user_wallet_balance IS
    'Derived wallet balance per (user, mode). Updates implicitly with every '
    'transactions INSERT. Never UPDATE this view directly — Phase 2 balance '
    'UI reads it; balance movement is via transactions rows of type '
    'balance_topup / balance_topup_bonus / balance_redeem.';


-- =============================================================
-- 14. Row Level Security
--
-- transactions: SELECT by user for own rows. INSERT service_role only (REVOKE
--    above prevents authenticated/anon from inserting; the policy gates SELECT).
-- stripe_intents, holds, refunds, carrier_adjustments: user SELECTs own rows
--    (via user_id or via shipments → sendmo_links → user_id chain).
-- payment_methods: user SELECTs own (where deleted_at IS NULL).
-- Admin role (profiles.role='admin') gets unrestricted SELECT — Phase A
--    relies on the existing _shared/auth.ts requireAdmin helper rather than
--    bypassing RLS; service-role queries from the admin-report function
--    bypass RLS by virtue of the service-role key.
-- =============================================================
ALTER TABLE public.transactions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_intents        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_methods       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.holds                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refunds               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.carrier_adjustments   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own transactions"
    ON public.transactions FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can view own stripe_intents"
    ON public.stripe_intents FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can view own payment_methods"
    ON public.payment_methods FOR SELECT
    USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can view holds on own links"
    ON public.holds FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM public.sendmo_links
        WHERE sendmo_links.id = holds.link_id
          AND sendmo_links.user_id = auth.uid()
    ));

CREATE POLICY "Users can view refunds on own shipments"
    ON public.refunds FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM public.shipments s
        JOIN public.sendmo_links l ON l.id = s.link_id
        WHERE s.id = refunds.shipment_id
          AND l.user_id = auth.uid()
    ));

CREATE POLICY "Users can view adjustments on own shipments"
    ON public.carrier_adjustments FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM public.shipments s
        JOIN public.sendmo_links l ON l.id = s.link_id
        WHERE s.id = carrier_adjustments.shipment_id
          AND l.user_id = auth.uid()
    ));


-- =============================================================
-- 15. System profile row (comp-mode placeholder)
--
-- The labels function falls back to this UUID when there's no resolved link
-- and no authenticated caller (admin comp full-label flow). Migration 004
-- already inserts this row; the INSERT below is idempotent (ON CONFLICT
-- DO NOTHING) and is kept here so a future fresh-DB rollout that runs 017
-- in isolation still has the row.
-- =============================================================
INSERT INTO public.profiles (id, email, full_name, created_at, updated_at)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'admin@sendmo.co',
    'SendMo Admin',
    now(),
    now()
)
ON CONFLICT (id) DO NOTHING;
