/**
 * Unit tests for _shared/refunds.ts resolveRefundStatus.
 *
 * Regression guard for the 2026-07-05 flex-cancel money bug: a paid flex
 * (Pattern D) shipment had `stripe_payment_intent_id = NULL` (the off-session
 * PI was never stitched onto the shipment row), so the cancel path read it as
 * a comp label — `refund_status='not_applicable'` — and NEVER refunded the
 * customer's real charge. The labels forward-stitch fix ensures flex shipments
 * carry their PI; this pins the decision that consumes it: **PI present ⇒
 * refundable ('submitted'); no PI ⇒ 'not_applicable' (comp)**, with a carrier
 * 'rejected' void overriding both.
 */

import { describe, it, expect } from "vitest";
import {
  resolveRefundStatus,
  shouldAdvanceRefundStatusOnChargeRefunded,
} from "../../supabase/functions/_shared/refunds.ts";

describe("resolveRefundStatus", () => {
  it("paid shipment (PI present) → 'submitted' — the flex regression case", () => {
    expect(resolveRefundStatus("submitted", true)).toBe("submitted");
    // EasyPost may report the void as 'refunded' immediately (test mode) —
    // still a real charge, still refundable.
    expect(resolveRefundStatus("refunded", true)).toBe("submitted");
  });

  it("comp shipment (no PI) → 'not_applicable' — no money to move", () => {
    expect(resolveRefundStatus("submitted", false)).toBe("not_applicable");
    expect(resolveRefundStatus("refunded", false)).toBe("not_applicable");
  });

  it("carrier rejected the void → 'rejected', regardless of PI presence", () => {
    expect(resolveRefundStatus("rejected", true)).toBe("rejected");
    expect(resolveRefundStatus("rejected", false)).toBe("rejected");
  });

  it("the bug it guards: a paid flex label must NOT resolve to 'not_applicable'", () => {
    // Before the fix, a flex shipment reached here with hasPaymentIntent=false
    // (null PI column) and got 'not_applicable' → refund skipped. With the
    // stitch, hasPaymentIntent=true and it correctly resolves 'submitted'.
    expect(resolveRefundStatus("submitted", true)).not.toBe("not_applicable");
  });
});

/**
 * D4 guard (approve-with-changes REQUIRED-3): on charge.refunded, only advance
 * refund_status → 'refunded' for a genuine customer cancel flow. 'submitted'
 * always qualifies; 'rejected' is overloaded (timeout-healed cancel vs
 * carrier-REFUSED void) and only the EP-refunded variant may advance —
 * otherwise an admin goodwill partial refund on a carrier-refused shipment
 * would flip it to 'refunded' and fire a false Email B.
 */
describe("shouldAdvanceRefundStatusOnChargeRefunded", () => {
  it("'submitted' → advance, regardless of easypost_refund_status", () => {
    expect(shouldAdvanceRefundStatusOnChargeRefunded("submitted", "refunded")).toBe(true);
    expect(shouldAdvanceRefundStatusOnChargeRefunded("submitted", "rejected")).toBe(true);
    expect(shouldAdvanceRefundStatusOnChargeRefunded("submitted", null)).toBe(true);
  });

  it("'rejected' + easypost_refund_status='refunded' → advance (timeout-healed cancel)", () => {
    expect(shouldAdvanceRefundStatusOnChargeRefunded("rejected", "refunded")).toBe(true);
  });

  it("'rejected' + carrier-refused (EP not refunded) → do NOT advance — the false-Email-B bug it guards", () => {
    expect(shouldAdvanceRefundStatusOnChargeRefunded("rejected", "rejected")).toBe(false);
    expect(shouldAdvanceRefundStatusOnChargeRefunded("rejected", null)).toBe(false);
    expect(shouldAdvanceRefundStatusOnChargeRefunded("rejected", "submitted")).toBe(false);
  });

  it("already 'refunded' / 'not_applicable' / null → do NOT advance (no cancel flow to close)", () => {
    expect(shouldAdvanceRefundStatusOnChargeRefunded("refunded", "refunded")).toBe(false);
    expect(shouldAdvanceRefundStatusOnChargeRefunded("not_applicable", "refunded")).toBe(false);
    expect(shouldAdvanceRefundStatusOnChargeRefunded(null, "refunded")).toBe(false);
    expect(shouldAdvanceRefundStatusOnChargeRefunded(undefined, undefined)).toBe(false);
  });
});
