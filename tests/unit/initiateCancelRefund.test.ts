/**
 * Unit tests for _shared/refunds.ts initiateCancelRefund.
 *
 * Regression pinned (Rule 12): tracking/index.ts and webhooks/index.ts used
 * to pass `amount_cents: balance > 0 ? balance : undefined` to createRefund.
 * `undefined` tells Stripe "refund ALL remaining", so a ledger that (wrongly)
 * said 0 refundable triggered an UNBOUNDED refund instead of a skip. The
 * helper must NEVER call createRefund when balance <= 0.
 *
 * Uses the injectable-deps pattern established by getRefundableBalanceForPI
 * (direct Vitest import of _shared/refunds.ts, typed fakes).
 */

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { initiateCancelRefund } from "../../supabase/functions/_shared/refunds.ts";

// The supabase client is only passed through to getBalanceFn — a bare object
// cast is enough since every test injects getBalanceFn.
const fakeSupabase = {} as unknown as SupabaseClient;

const baseParams = {
  supabase: fakeSupabase,
  stripePaymentIntentId: "pi_test_abc123",
  easypostShipmentId: "shp_test_xyz",
  shipmentId: "00000000-0000-0000-0000-000000000042",
  publicCode: "H7K2P9",
  trigger: "unit_test",
  liveMode: false,
};

function fakeRefundFn(id = "re_test_1") {
  return vi.fn().mockResolvedValue({
    id,
    object: "refund",
    amount: 0,
    status: "pending",
    payment_intent: baseParams.stripePaymentIntentId,
  });
}

describe("initiateCancelRefund", () => {
  it("balance > 0 — calls createRefund with the EXACT balance, never undefined", async () => {
    const createRefundFn = fakeRefundFn("re_test_exact");
    const result = await initiateCancelRefund({
      ...baseParams,
      getBalanceFn: vi.fn().mockResolvedValue(1595),
      createRefundFn,
    });

    expect(createRefundFn).toHaveBeenCalledTimes(1);
    expect(createRefundFn).toHaveBeenCalledWith({
      payment_intent_id: "pi_test_abc123",
      amount_cents: 1595,
      reason: "requested_by_customer",
      metadata: {
        shipment_id: baseParams.shipmentId,
        public_code: "H7K2P9",
        trigger: "unit_test",
      },
      idempotency_key: "refund_shp_test_xyz_user_cancel",
      liveMode: false,
    });
    expect(result).toEqual({
      skipped: false,
      stripeRefundId: "re_test_exact",
      amountCents: 1595,
    });
  });

  it("balance 0 — SKIPS, createRefund never called (the unbounded-refund regression)", async () => {
    const createRefundFn = fakeRefundFn();
    const result = await initiateCancelRefund({
      ...baseParams,
      getBalanceFn: vi.fn().mockResolvedValue(0),
      createRefundFn,
    });

    expect(createRefundFn).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true, reason: "no_refundable_balance" });
  });

  it("balance negative (over-refunded ledger) — SKIPS, createRefund never called", async () => {
    const createRefundFn = fakeRefundFn();
    const result = await initiateCancelRefund({
      ...baseParams,
      getBalanceFn: vi.fn().mockResolvedValue(-800),
      createRefundFn,
    });

    expect(createRefundFn).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true, reason: "no_refundable_balance" });
  });

  it("idempotency key is the UNCHANGED shared cancel key (Stripe dedup across all three triggers)", async () => {
    const createRefundFn = fakeRefundFn();
    await initiateCancelRefund({
      ...baseParams,
      easypostShipmentId: "shp_live_777",
      getBalanceFn: vi.fn().mockResolvedValue(100),
      createRefundFn,
    });
    expect(createRefundFn.mock.calls[0][0].idempotency_key).toBe(
      "refund_shp_live_777_user_cancel",
    );
  });

  it("liveMode is passed through to createRefund", async () => {
    const createRefundFn = fakeRefundFn();
    await initiateCancelRefund({
      ...baseParams,
      liveMode: true,
      getBalanceFn: vi.fn().mockResolvedValue(250),
      createRefundFn,
    });
    expect(createRefundFn.mock.calls[0][0].liveMode).toBe(true);
  });

  it("createRefund throw propagates (callers keep their catch/log/retry semantics)", async () => {
    const createRefundFn = vi.fn().mockRejectedValue(new Error("stripe 500"));
    await expect(
      initiateCancelRefund({
        ...baseParams,
        getBalanceFn: vi.fn().mockResolvedValue(500),
        createRefundFn,
      }),
    ).rejects.toThrow("stripe 500");
  });

  it("balance lookup throw propagates (never silently treated as 0)", async () => {
    const createRefundFn = fakeRefundFn();
    await expect(
      initiateCancelRefund({
        ...baseParams,
        getBalanceFn: vi
          .fn()
          .mockRejectedValue(new Error("refundable-balance lookup failed: connection refused")),
        createRefundFn,
      }),
    ).rejects.toThrow("refundable-balance lookup failed");
    expect(createRefundFn).not.toHaveBeenCalled();
  });
});
