/**
 * Unit tests for _shared/stripe.ts resolveRefundRowsToBook.
 *
 * Regression guard for the 2026-07-06 cumulative-refund ledger bug: the
 * charge.refunded arm fell back to `charge.amount_refunded` when
 * `charge.refunds.data` was absent — and under the pinned 2026-04-22.dahlia
 * API version it is ALWAYS absent from webhook payloads, so the fallback was
 * the common path. `amount_refunded` is CUMULATIVE: the second partial refund
 * booked the running total as a second ledger row (over-refund in the ledger),
 * and the synthetic `<charge_id>_refund` id collapsed distinct refunds in the
 * `refunds` mirror table.
 *
 * The fix retrieves the authoritative refund list from Stripe and books each
 * succeeded refund individually, keyed on its real rfnd_ id with
 * idempotency_key `stripe.refund.<rfnd_id>` — the UNIQUE collision on that key
 * is the convergence mechanism across partial refunds, replays, and event
 * races. This pins the pure booking decision (Rule 12).
 */

import { describe, it, expect } from "vitest";
import { resolveRefundRowsToBook } from "../../supabase/functions/_shared/stripe.ts";

const refund = (
  id: string,
  amount: number,
  status: "pending" | "succeeded" | "failed" | "canceled" = "succeeded",
  reason: string | null = null,
) => ({ id, object: "refund" as const, amount, status, payment_intent: "pi_1", reason });

describe("resolveRefundRowsToBook", () => {
  it("single full refund → one row with the full amount and the real rfnd_ id", () => {
    const rows = resolveRefundRowsToBook([refund("re_full", 1234)]);
    expect(rows).toEqual([
      {
        stripeRefundId: "re_full",
        amountCents: 1234,
        reason: null,
        idempotencyKey: "stripe.refund.re_full",
      },
    ]);
  });

  it("two partial refunds → two rows with the INDIVIDUAL amounts, not the cumulative total", () => {
    // Stripe lists refunds newest-first. amount_refunded on the charge would
    // read 900 at the second event — the bug booked 900, not 400.
    const rows = resolveRefundRowsToBook([
      refund("re_second", 400, "succeeded", "requested_by_customer"),
      refund("re_first", 500),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      stripeRefundId: "re_second",
      amountCents: 400,
      reason: "requested_by_customer",
      idempotencyKey: "stripe.refund.re_second",
    });
    expect(rows[1]).toEqual({
      stripeRefundId: "re_first",
      amountCents: 500,
      reason: null,
      idempotencyKey: "stripe.refund.re_first",
    });
  });

  it("replay of the same list → identical keys (idempotent under the UNIQUE constraint)", () => {
    const list = [refund("re_b", 300), refund("re_a", 700)];
    const first = resolveRefundRowsToBook(list);
    const replay = resolveRefundRowsToBook(list);
    expect(replay.map((r) => r.idempotencyKey)).toEqual(first.map((r) => r.idempotencyKey));
    expect(replay).toEqual(first);
  });

  it("pending / failed / canceled refunds are excluded — only succeeded money moves book", () => {
    const rows = resolveRefundRowsToBook([
      refund("re_pending", 100, "pending"),
      refund("re_ok", 200, "succeeded"),
      refund("re_failed", 300, "failed"),
      refund("re_canceled", 400, "canceled"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].stripeRefundId).toBe("re_ok");
  });

  it("empty list → no rows (defensive: event raced ahead of the refund list)", () => {
    expect(resolveRefundRowsToBook([])).toEqual([]);
  });

  it("amounts are normalized positive — the caller applies the ledger sign", () => {
    // Stripe refund amounts are positive; guard against a hostile/odd payload.
    const rows = resolveRefundRowsToBook([refund("re_neg", -250)]);
    expect(rows[0].amountCents).toBe(250);
  });
});
