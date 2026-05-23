-- =============================================================
-- Migration 032 — Carrier Adjustments Amendments + Ledger Extensions
--
-- Decided proposal:
--   proposals/2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_decided-2026-05-22.md
-- Package H1 of the pre-launch P1 build.
-- Handoff plan:
--   proposals/2026-05-23_pre-launch-handoff-plan.md
--
-- What this migration does (all non-destructive ALTERs):
--   1. carrier_adjustments: add three columns (claimed_weight_oz,
--      captured_weight_oz, expected_credit_cents) for ShipmentInvoice
--      payload data and dispute-tracking.
--   2. carrier_adjustments: swap recovery_status CHECK to admit 'rejected'
--      (the fifth terminal state — carrier refused the dispute / adjustment).
--   3. carrier_adjustments: add partial UNIQUE index on source_event_id
--      (WHERE source_event_id IS NOT NULL) — the dedup key for dual-path
--      detection (webhook push + reconciliation sweep). Load-bearing for H2.
--   4. transactions: swap type CHECK to admit 'label_cost' and
--      'easypost_refund' — the two new bidirectional ledger types.
--      Without this, any INSERT of those types fails at the DB layer
--      (CHECK violation, not a Rule 16 trigger — see B3 from the review).
--
-- Constraint names verified against live DB before writing:
--   carrier_adjustments_recovery_status_check
--   transactions_type_check
-- =============================================================

-- ── Part 1: carrier_adjustments — add weight + dispute columns ──────────────

ALTER TABLE public.carrier_adjustments
  ADD COLUMN IF NOT EXISTS claimed_weight_oz     INTEGER,
  ADD COLUMN IF NOT EXISTS captured_weight_oz    INTEGER,
  ADD COLUMN IF NOT EXISTS expected_credit_cents INTEGER;

COMMENT ON COLUMN public.carrier_adjustments.claimed_weight_oz IS
  'Weight the carrier claimed to have weighed (oz). From ShipmentInvoice payload. '
  'Evidence for disputes via USPS VerifyPostageHelp@usps.gov or UPS dispute form.';
COMMENT ON COLUMN public.carrier_adjustments.captured_weight_oz IS
  'Weight SendMo declared at label time (oz). Combined with claimed_weight_oz, '
  'provides the before/after pair needed for a carrier dispute.';
COMMENT ON COLUMN public.carrier_adjustments.expected_credit_cents IS
  'When recovery_status=''disputed'', the credit amount we expect the carrier to '
  'return. Used by the reconciliation sweep to pattern-match an incoming '
  '+wallet credit as the resolution of this dispute (N4 fix from review).';


-- ── Part 2: carrier_adjustments — swap recovery_status CHECK ────────────────
-- Adds 'rejected' as the fifth terminal value (carrier refused the dispute
-- or the void). Must DROP and re-ADD because PostgreSQL does not support
-- ALTER ... CHECK directly.

ALTER TABLE public.carrier_adjustments
  DROP CONSTRAINT carrier_adjustments_recovery_status_check;

ALTER TABLE public.carrier_adjustments
  ADD CONSTRAINT carrier_adjustments_recovery_status_check
  CHECK (recovery_status IN (
    'pending',    -- awaiting recovery decision
    'recovered',  -- money recovered (auto-recharge succeeded)
    'absorbed',   -- SendMo ate the cost (≤$1 floor, negative delta, or comp)
    'disputed',   -- sent to carrier for formal dispute
    'rejected'    -- carrier refused; terminal loss
  ));


-- ── Part 3: carrier_adjustments — partial UNIQUE on source_event_id ─────────
-- Partial because source_event_id is nullable (manual/sweep-inserted rows
-- may not have an EP event id). NULLs are excluded to avoid the PostgreSQL
-- "each NULL is distinct" behavior that would defeat the dedup goal.
-- This is the load-bearing dedup key for H2's webhook + sweep dual-path
-- detection (B2 + B4 from the review, §2.3 Architecture).

CREATE UNIQUE INDEX IF NOT EXISTS carrier_adjustments_source_event_id_uidx
  ON public.carrier_adjustments (source_event_id)
  WHERE source_event_id IS NOT NULL;

COMMENT ON INDEX public.carrier_adjustments_source_event_id_uidx IS
  'Partial UNIQUE on source_event_id (WHERE NOT NULL). Deduplicates '
  'shipment.invoice.created/updated events across the webhook push path and '
  'the reconciliation sweep pull path. A shipment.invoice.updated that reuses '
  'the same id triggers an UPSERT (UPDATE the existing row) rather than a '
  'second INSERT. Load-bearing for H2.';


-- ── Part 4: transactions — swap type CHECK to admit new ledger types ─────────
-- Adds 'label_cost' and 'easypost_refund' to the admitted set.
-- Without this, the labels/tracking/webhooks writers added in H1 will hit
-- a CHECK violation on their first INSERT (Predicted Pitfall 1 from the review).
-- Constraint name confirmed: transactions_type_check (same as migration 017).

ALTER TABLE public.transactions
  DROP CONSTRAINT transactions_type_check;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_type_check
  CHECK (type IN (
    'charge',              -- customer paid (stripe-webhook sole writer)
    'fee_stripe',          -- Stripe processing fee (stripe-webhook)
    'refund',              -- money back to customer (stripe-webhook)
    'refund_fee_recovered',-- Stripe app-fee returned on refund (stripe-webhook)
    'comp_grant',          -- comp label — SendMo absorbs EasyPost cost (labels)
    'balance_topup',       -- prepay wallet (Phase 2/H)
    'balance_topup_bonus', -- topup discount/incentive (§3.6)
    'balance_redeem',      -- spend from wallet
    'carrier_adjustment',  -- post-pickup reweigh etc. (§3.7, H2)
    'chargeback',          -- dispute lost (stripe-webhook)
    'adjustment',          -- manual admin correction (rare)
    'label_cost',          -- SendMo paid EasyPost for the label (labels, H1 NEW)
    'easypost_refund'      -- EasyPost credited SendMo on confirmed void (webhooks+tracking, H1 NEW)
  ));

COMMENT ON COLUMN public.transactions.type IS
  'Transaction type discriminator. Sole-writer map (PLAYBOOK Rule 16, amended migration 032): '
  'charge/fee_stripe/refund/refund_fee_recovered/chargeback → stripe-webhook; '
  'comp_grant → labels; '
  'label_cost → labels (added migration 032); '
  'easypost_refund → webhooks (push) + tracking (poll), idempotency keyed on EasyPost Refund object id; '
  'carrier_adjustment → webhooks ShipmentInvoice handler + reconciliation-sweep (reserved H2); '
  'adjustment → admin manual correction.';
