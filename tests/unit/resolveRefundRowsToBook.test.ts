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
 *
 * Also pins the D3 ledger-key cutover guard (approve-with-changes REQUIRED-1):
 * refunds created before the new-key deploy were already booked under the
 * legacy `stripe.<eventId>:refund` scheme and must be SKIPPED so they don't
 * re-book (double-count) under the new key.
 */

import { describe, it, expect } from "vitest";
import { resolveRefundRowsToBook } from "../../supabase/functions/_shared/stripe.ts";

// A cutover of 0 means "book everything created at/after epoch" — the D3 guard
// is a no-op for the money-shape tests. The D3-specific tests pass an explicit
// cutover.
const NO_CUTOVER = 0;

const refund = (
  id: string,
  amount: number,
  status: "pending" | "succeeded" | "failed" | "canceled" = "succeeded",
  reason: string | null = null,
  created = 2_000_000_000, // well after any cutover used in these tests
) => ({ id, object: "refund" as const, amount, status, payment_intent: "pi_1", reason, created });

describe("resolveRefundRowsToBook", () => {
  it("single full refund → one row with the full amount and the real rfnd_ id", () => {
    const rows = resolveRefundRowsToBook([refund("re_full", 1234)], NO_CUTOVER);
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
    ], NO_CUTOVER);
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
    const first = resolveRefundRowsToBook(list, NO_CUTOVER);
    const replay = resolveRefundRowsToBook(list, NO_CUTOVER);
    expect(replay.map((r) => r.idempotencyKey)).toEqual(first.map((r) => r.idempotencyKey));
    expect(replay).toEqual(first);
  });

  it("pending / failed / canceled refunds are excluded — only succeeded money moves book (REQUIRED-2)", () => {
    const rows = resolveRefundRowsToBook([
      refund("re_pending", 100, "pending"),
      refund("re_ok", 200, "succeeded"),
      refund("re_failed", 300, "failed"),
      refund("re_canceled", 400, "canceled"),
    ], NO_CUTOVER);
    expect(rows).toHaveLength(1);
    expect(rows[0].stripeRefundId).toBe("re_ok");
  });

  it("a single failed refund in the list is NOT booked (REQUIRED-2 explicit)", () => {
    expect(resolveRefundRowsToBook([refund("re_failed", 999, "failed")], NO_CUTOVER)).toEqual([]);
  });

  it("empty list → no rows (defensive: event raced ahead of the refund list)", () => {
    expect(resolveRefundRowsToBook([], NO_CUTOVER)).toEqual([]);
  });

  it("amounts are normalized positive — the caller applies the ledger sign", () => {
    // Stripe refund amounts are positive; guard against a hostile/odd payload.
    const rows = resolveRefundRowsToBook([refund("re_neg", -250)], NO_CUTOVER);
    expect(rows[0].amountCents).toBe(250);
  });

  // ── D3 ledger-key cutover guard (REQUIRED-1) ──────────────────────────────
  describe("ledger-key cutover (D3 double-book guard)", () => {
    const CUTOVER = 1_751_760_000; // 2025-07-06T00:00:00Z, the fallback floor

    it("a refund created BEFORE cutover is excluded — already booked under the legacy key", () => {
      const legacy = refund("re_legacy", 500, "succeeded", null, CUTOVER - 1);
      expect(resolveRefundRowsToBook([legacy], CUTOVER)).toEqual([]);
    });

    it("a refund created AT/AFTER cutover is included — new-key era", () => {
      const atCutover = refund("re_at", 500, "succeeded", null, CUTOVER);
      const afterCutover = refund("re_after", 600, "succeeded", null, CUTOVER + 1);
      expect(resolveRefundRowsToBook([atCutover], CUTOVER).map((r) => r.stripeRefundId)).toEqual(["re_at"]);
      expect(resolveRefundRowsToBook([afterCutover], CUTOVER).map((r) => r.stripeRefundId)).toEqual(["re_after"]);
    });

    it("mixed list → books only the refunds created at/after cutover", () => {
      const rows = resolveRefundRowsToBook([
        refund("re_new", 400, "succeeded", null, CUTOVER + 10),
        refund("re_old", 500, "succeeded", null, CUTOVER - 10),
      ], CUTOVER);
      expect(rows.map((r) => r.stripeRefundId)).toEqual(["re_new"]);
    });

    it("cutover and succeeded filters compose: an old succeeded + new failed → nothing books", () => {
      const rows = resolveRefundRowsToBook([
        refund("re_old_ok", 500, "succeeded", null, CUTOVER - 10),
        refund("re_new_failed", 600, "failed", null, CUTOVER + 10),
      ], CUTOVER);
      expect(rows).toEqual([]);
    });
  });
});
