// tests/unit/reconciliation-math.test.ts
//
// Net-margin identity tests for the reconciliation dashboard.
// Covers every combination of charge / fee / refund / chargeback /
// label_cost / easypost_refund / carrier_adjustment.
//
// Net-margin identity (from the decided proposal §2.5 + dashboard mockup ~line 450):
//   Paid − Stripe fee − Refund to customer + Adjustment collected − Chargeback
//   − Label cost + Refund from EasyPost − Adjustment charged = Net margin
//
// This file is a PURE logic test — no DB, no Supabase, no Stripe.
// All math is done via the same formula the reconciliation-report Edge Function uses.

import { describe, it, expect } from "vitest";

// ─── The identity function (matches reconciliation-report/index.ts logic) ─────

interface LedgerRow {
  type: string;
  amount_cents: number;
}

function computeNetMargin(transactions: LedgerRow[]): {
  paid_cents: number;
  stripe_fee_cents: number;
  refunded_to_customer_cents: number;
  adj_collected_cents: number;
  chargeback_cents: number;
  label_cost_cents: number;
  easypost_refund_cents: number;
  adj_charged_cents: number;
  net_margin_cents: number;
} {
  const sumByType = (type: string) =>
    transactions.filter((t) => t.type === type).reduce((s, t) => s + t.amount_cents, 0);

  const paid = sumByType("charge");
  const stripeFee = Math.abs(sumByType("fee_stripe"));
  const refundedToCustomer = Math.abs(sumByType("refund"));
  const adjCollected = transactions
    .filter((t) => t.type === "carrier_adjustment" && t.amount_cents > 0)
    .reduce((s, t) => s + t.amount_cents, 0);
  const chargebackSum = Math.abs(sumByType("chargeback"));
  const labelCost = Math.abs(sumByType("label_cost"));
  const easypostRefund = sumByType("easypost_refund");
  const adjCharged = Math.abs(
    transactions
      .filter((t) => t.type === "carrier_adjustment" && t.amount_cents < 0)
      .reduce((s, t) => s + t.amount_cents, 0)
  );

  const netMargin =
    paid - stripeFee - refundedToCustomer + adjCollected
    - chargebackSum - labelCost + easypostRefund - adjCharged;

  return {
    paid_cents: paid,
    stripe_fee_cents: -stripeFee,
    refunded_to_customer_cents: -refundedToCustomer,
    adj_collected_cents: adjCollected,
    chargeback_cents: -chargebackSum,
    label_cost_cents: -labelCost,
    easypost_refund_cents: easypostRefund,
    adj_charged_cents: -adjCharged,
    net_margin_cents: netMargin,
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

describe("reconciliation-math — Net-margin identity", () => {
  // ── Basic charge + cost ────────────────────────────────────────────────────

  it("simple paid shipment with label cost — basic margin", () => {
    const txs: LedgerRow[] = [
      { type: "charge", amount_cents: 910 },         // $9.10 paid
      { type: "fee_stripe", amount_cents: -56 },     // -$0.56 Stripe fee
      { type: "label_cost", amount_cents: -710 },    // -$7.10 EasyPost label
    ];
    const result = computeNetMargin(txs);
    // $9.10 - $0.56 - $7.10 = $1.44
    expect(result.net_margin_cents).toBe(144);
    expect(result.paid_cents).toBe(910);
    expect(result.label_cost_cents).toBe(-710);
    expect(result.stripe_fee_cents).toBe(-56);
  });

  it("zero transactions → zero margin", () => {
    const result = computeNetMargin([]);
    expect(result.net_margin_cents).toBe(0);
    expect(result.paid_cents).toBe(0);
  });

  // ── With refund to customer ────────────────────────────────────────────────

  it("shipment with admin partial refund to customer", () => {
    const txs: LedgerRow[] = [
      { type: "charge", amount_cents: 1425 },
      { type: "fee_stripe", amount_cents: -71 },
      { type: "label_cost", amount_cents: -1140 },
      { type: "refund", amount_cents: -500 },        // $5 admin refund
    ];
    const result = computeNetMargin(txs);
    // $14.25 - $0.71 - $11.40 - $5.00 = -$2.86
    expect(result.net_margin_cents).toBe(-286);
    expect(result.refunded_to_customer_cents).toBe(-500);
  });

  it("fully refunded shipment", () => {
    const txs: LedgerRow[] = [
      { type: "charge", amount_cents: 760 },
      { type: "fee_stripe", amount_cents: -52 },
      { type: "label_cost", amount_cents: -590 },
      { type: "refund", amount_cents: -760 },        // full refund
    ];
    const result = computeNetMargin(txs);
    // $7.60 - $0.52 - $5.90 - $7.60 = -$6.42
    expect(result.net_margin_cents).toBe(-642);
  });

  // ── With chargeback ────────────────────────────────────────────────────────

  it("shipment with chargeback (dispute + $15 fee)", () => {
    const txs: LedgerRow[] = [
      { type: "charge", amount_cents: 1140 },
      { type: "fee_stripe", amount_cents: -63 },
      { type: "label_cost", amount_cents: -910 },
      { type: "chargeback", amount_cents: -2640 },   // $11.40 + $15 Stripe dispute fee
    ];
    const result = computeNetMargin(txs);
    // $11.40 - $0.63 - $9.10 - $26.40 = -$24.73
    expect(result.net_margin_cents).toBe(-2473);
    expect(result.chargeback_cents).toBe(-2640);
  });

  // ── With carrier adjustment (auto-recharged) ───────────────────────────────

  it("carrier adjustment auto-recharged ($2.40 + $1 fee) — full pipeline", () => {
    const txs: LedgerRow[] = [
      { type: "charge", amount_cents: 1280 },        // initial charge
      { type: "fee_stripe", amount_cents: -77 },     // on the $12.80
      { type: "label_cost", amount_cents: -1020 },   // label cost
      { type: "carrier_adjustment", amount_cents: -240 },  // EP billed the wallet
      { type: "carrier_adjustment", amount_cents: 340 },   // customer recharged $2.40 + $1.00 fee
      { type: "fee_stripe", amount_cents: -40 },     // fee on the $3.40 recharge
    ];
    const result = computeNetMargin(txs);
    // $12.80 - $0.77 - 0 + $3.40 - 0 - $10.20 + 0 - $2.40 = $2.83... let's compute:
    // paid=1280, fee=117(both fees), adjCollected=340, adjCharged=240, labelCost=1020
    // 1280 - 117 - 0 + 340 - 0 - 1020 + 0 - 240 = 243
    expect(result.paid_cents).toBe(1280);
    expect(result.adj_collected_cents).toBe(340);
    expect(result.adj_charged_cents).toBe(-240);
    expect(result.net_margin_cents).toBe(243);
  });

  it("carrier adjustment absorbed (≤$1) — no recharge", () => {
    const txs: LedgerRow[] = [
      { type: "charge", amount_cents: 805 },
      { type: "fee_stripe", amount_cents: -53 },
      { type: "label_cost", amount_cents: -630 },
      { type: "carrier_adjustment", amount_cents: -74 }, // $0.74 absorbed
    ];
    const result = computeNetMargin(txs);
    // $8.05 - $0.53 - $6.30 - $0.74 = $0.48
    expect(result.net_margin_cents).toBe(48);
    expect(result.adj_collected_cents).toBe(0);  // no recharge
    expect(result.adj_charged_cents).toBe(-74);
  });

  it("carrier adjustment flagged (>$10) — no recharge, pending review", () => {
    const txs: LedgerRow[] = [
      { type: "charge", amount_cents: 940 },
      { type: "fee_stripe", amount_cents: -57 },
      { type: "label_cost", amount_cents: -730 },
      { type: "carrier_adjustment", amount_cents: -1420 }, // $14.20 flagged
    ];
    const result = computeNetMargin(txs);
    // $9.40 - $0.57 + 0 - 0 - $7.30 + 0 - $14.20 = -$12.67
    expect(result.net_margin_cents).toBe(-1267);
    expect(result.adj_collected_cents).toBe(0); // not recharged yet
  });

  // ── With EasyPost refund (cancelled label) ──────────────────────────────────

  it("comp label cancelled — EasyPost refund credited back", () => {
    // COMP label: SendMo paid; label later cancelled; EasyPost credited back.
    const txs: LedgerRow[] = [
      { type: "label_cost", amount_cents: -1300 },   // -$13.00
      { type: "easypost_refund", amount_cents: 1400 }, // +$14.00 (credit)
    ];
    const result = computeNetMargin(txs);
    // 0 - 0 - 0 + 0 - 0 - $13.00 + $14.00 - 0 = +$1.00
    expect(result.net_margin_cents).toBe(100);
    expect(result.easypost_refund_cents).toBe(1400);
  });

  it("paid label cancelled — EasyPost refund + Stripe refund", () => {
    const txs: LedgerRow[] = [
      { type: "charge", amount_cents: 760 },
      { type: "fee_stripe", amount_cents: -52 },
      { type: "label_cost", amount_cents: -590 },
      { type: "refund", amount_cents: -760 },         // Stripe refund to customer
      { type: "easypost_refund", amount_cents: 590 }, // EasyPost credited back
    ];
    const result = computeNetMargin(txs);
    // $7.60 - $0.52 - $7.60 + 0 - 0 - $5.90 + $5.90 - 0 = -$0.52
    expect(result.net_margin_cents).toBe(-52);
  });

  // ── COMP shipments (no customer side) ─────────────────────────────────────

  it("comp shipment delivered — only EasyPost cost", () => {
    const txs: LedgerRow[] = [
      { type: "label_cost", amount_cents: -1129 },   // -$11.29
    ];
    const result = computeNetMargin(txs);
    expect(result.paid_cents).toBe(0);
    expect(result.label_cost_cents).toBe(-1129);
    expect(result.net_margin_cents).toBe(-1129);
  });

  it("comp shipment with carrier adjustment — absorbed (no PM to charge)", () => {
    const txs: LedgerRow[] = [
      { type: "label_cost", amount_cents: -600 },
      { type: "carrier_adjustment", amount_cents: -50 }, // absorb — comp shipment
    ];
    const result = computeNetMargin(txs);
    expect(result.net_margin_cents).toBe(-650);
  });

  // ── Full kitchen-sink — all 8 term types ──────────────────────────────────

  it("all 8 term types present — identity holds", () => {
    // Paid − Stripe fee − Refund to customer + Adjustment collected − Chargeback
    // − Label cost + Refund from EasyPost − Adjustment charged = Net margin
    const txs: LedgerRow[] = [
      { type: "charge", amount_cents: 1500 },          // Paid = +$15.00
      { type: "fee_stripe", amount_cents: -75 },       // Stripe fee = -$0.75
      { type: "refund", amount_cents: -300 },          // Refund to customer = -$3.00
      { type: "carrier_adjustment", amount_cents: 240 }, // Adjustment collected = +$2.40
      { type: "chargeback", amount_cents: -2640 },     // Chargeback = -$26.40
      { type: "label_cost", amount_cents: -1000 },     // Label cost = -$10.00
      { type: "easypost_refund", amount_cents: 800 },  // Refund from EasyPost = +$8.00
      { type: "carrier_adjustment", amount_cents: -200 }, // Adjustment charged = -$2.00
    ];
    const result = computeNetMargin(txs);
    // 1500 - 75 - 300 + 240 - 2640 - 1000 + 800 - 200 = -1675
    expect(result.paid_cents).toBe(1500);
    expect(result.stripe_fee_cents).toBe(-75);
    expect(result.refunded_to_customer_cents).toBe(-300);
    expect(result.adj_collected_cents).toBe(240);
    expect(result.chargeback_cents).toBe(-2640);
    expect(result.label_cost_cents).toBe(-1000);
    expect(result.easypost_refund_cents).toBe(800);
    expect(result.adj_charged_cents).toBe(-200);
    expect(result.net_margin_cents).toBe(-1675);
  });

  // ── Multiple transactions of the same type ─────────────────────────────────

  it("multiple charge rows (e.g. initial + adjustment recharge) sum correctly", () => {
    const txs: LedgerRow[] = [
      { type: "charge", amount_cents: 1000 },
      { type: "carrier_adjustment", amount_cents: 340 }, // recharge row
      { type: "fee_stripe", amount_cents: -60 },
      { type: "fee_stripe", amount_cents: -17 },         // second fee on recharge
      { type: "label_cost", amount_cents: -800 },
      { type: "carrier_adjustment", amount_cents: -240 },
    ];
    const result = computeNetMargin(txs);
    // 1000 - 77 - 0 + 340 - 0 - 800 + 0 - 240 = 223
    expect(result.stripe_fee_cents).toBe(-77);
    expect(result.net_margin_cents).toBe(223);
  });

  it("multiple refund rows (partial + further partial) sum correctly", () => {
    const txs: LedgerRow[] = [
      { type: "charge", amount_cents: 2000 },
      { type: "fee_stripe", amount_cents: -100 },
      { type: "label_cost", amount_cents: -1500 },
      { type: "refund", amount_cents: -500 },   // first partial refund
      { type: "refund", amount_cents: -500 },   // second partial refund
    ];
    const result = computeNetMargin(txs);
    // 2000 - 100 - 1000 - 1500 = -600
    expect(result.refunded_to_customer_cents).toBe(-1000);
    expect(result.net_margin_cents).toBe(-600);
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it("refund_fee_recovered type does not affect net margin formula", () => {
    // refund_fee_recovered is a Stripe-side row but not part of the 8-term identity.
    // It should not appear in the standard reconciliation columns.
    const txs: LedgerRow[] = [
      { type: "charge", amount_cents: 1000 },
      { type: "fee_stripe", amount_cents: -50 },
      { type: "label_cost", amount_cents: -800 },
      { type: "refund_fee_recovered", amount_cents: 30 }, // not in identity
    ];
    const result = computeNetMargin(txs);
    // Identity: 1000 - 50 - 0 + 0 - 0 - 800 + 0 - 0 = 150
    // refund_fee_recovered is not summed in any of the 8 terms
    expect(result.net_margin_cents).toBe(150);
  });

  it("positive carrier_adjustment (carrier credit) flows through easypost refund path", () => {
    // When the carrier adjusts DOWN (credits the wallet), delta_cents is negative,
    // and the ep side gets a credit. This is handled as easypost_refund, not carrier_adjustment.
    // So a positive carrier_adjustment tx would only come from a customer recharge.
    const txs: LedgerRow[] = [
      { type: "charge", amount_cents: 500 },
      { type: "fee_stripe", amount_cents: -25 },
      { type: "label_cost", amount_cents: -400 },
      // Only positive carrier_adjustment = customer recharged
      { type: "carrier_adjustment", amount_cents: 150 }, // recharged
      { type: "carrier_adjustment", amount_cents: -100 }, // EP charged wallet
      { type: "fee_stripe", amount_cents: -8 }, // fee on recharge
    ];
    const result = computeNetMargin(txs);
    // 500 - 33 - 0 + 150 - 0 - 400 + 0 - 100 = 117
    expect(result.adj_collected_cents).toBe(150);
    expect(result.adj_charged_cents).toBe(-100);
    expect(result.net_margin_cents).toBe(117);
  });

  it("dispute window countdown math is correct for USPS (60 days)", () => {
    // This tests the date math used in the Needs-Attention panel.
    function getDisputeWindowDays(carrier: string): number {
      const upper = (carrier || "").toUpperCase();
      if (upper.includes("USPS") || upper.includes("USGA")) return 60;
      if (upper.includes("UPS")) return 120;
      if (upper.includes("FEDEX")) return 90;
      return 60;
    }

    function daysUntilDeadline(createdAt: string, carrier: string): number {
      const daysElapsed = Math.floor(
        (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24)
      );
      return getDisputeWindowDays(carrier) - daysElapsed;
    }

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const fiftyDaysAgo = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000).toISOString();
    const sixtyOneDaysAgo = new Date(Date.now() - 61 * 24 * 60 * 60 * 1000).toISOString();

    expect(daysUntilDeadline(yesterday, "USPS")).toBe(59); // 60 - 1
    expect(daysUntilDeadline(fiftyDaysAgo, "USPS")).toBe(10);
    expect(daysUntilDeadline(sixtyOneDaysAgo, "USPS")).toBe(-1); // past deadline
    expect(daysUntilDeadline(yesterday, "UPS")).toBe(119); // 120 - 1
    expect(daysUntilDeadline(yesterday, "FedEx")).toBe(89); // 90 - 1
    expect(daysUntilDeadline(yesterday, "USPS Ground Advantage")).toBe(59);
  });
});
