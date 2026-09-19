import { describe, it, expect } from "vitest";
import { decideBuyReplay } from "../../supabase/functions/_shared/buy-idempotency";

// Truth table for the PR1 buy-idempotency decision (seller-link launch
// proposal, review B4 + the code-review revision): an existing shipments row
// is returned only on a proven payment binding; a mismatched PAID request is
// refunded (its charge bought nothing — Stripe idempotency keys expire after
// 24h, so a stale resubmit can carry a fresh capture); a mismatched unpaid
// request fails closed. cancel_token is a credential — mismatches never leak
// the row.

const paidRow = { rowExists: true, rowIsComp: false } as const;
const compRow = { rowExists: true, rowIsComp: true } as const;

describe("decideBuyReplay", () => {
    it("proceeds when no row exists (the normal first buy)", () => {
        expect(
            decideBuyReplay({ rowExists: false, rowIsComp: false, existingPiId: null, verifiedPiId: "pi_1", isComp: false }),
        ).toBe("proceed");
        expect(
            decideBuyReplay({ rowExists: false, rowIsComp: false, existingPiId: null, verifiedPiId: null, isComp: true }),
        ).toBe("proceed");
    });

    it("returns the existing row on an exact PI match (full-label / flex / seller replay)", () => {
        expect(
            decideBuyReplay({ ...paidRow, existingPiId: "pi_1", verifiedPiId: "pi_1", isComp: false }),
        ).toBe("return_existing");
    });

    it("REFUNDS the request's PI when the row is bound to a DIFFERENT PI (expired idempotency key → fresh second capture)", () => {
        expect(
            decideBuyReplay({ ...paidRow, existingPiId: "pi_original", verifiedPiId: "pi_fresh_capture", isComp: false }),
        ).toBe("refund_mismatch");
    });

    it("returns + repairs when a PAID row lost its stitch (NULL PI) and the request's PI binds to this shipment", () => {
        // All three legs verify the PI↔shipment binding before this decision,
        // so a verified PI IS this shipment's payment — same party, same
        // purchase. Refusing here permanently locked out paying customers.
        expect(
            decideBuyReplay({ ...paidRow, existingPiId: null, verifiedPiId: "pi_1", isComp: false }),
        ).toBe("return_existing_repair");
    });

    it("REFUNDS a paid request replaying a COMP row (the payment bought nothing)", () => {
        expect(
            decideBuyReplay({ ...compRow, existingPiId: null, verifiedPiId: "pi_1", isComp: false }),
        ).toBe("refund_mismatch");
    });

    it("returns the existing row on a comp replay of a comp row", () => {
        expect(
            decideBuyReplay({ ...compRow, existingPiId: null, verifiedPiId: null, isComp: true }),
        ).toBe("return_existing");
    });

    it("refuses a comp request against a PAID row — even a stitch-failed one (credential rule: never leak another payer's token)", () => {
        expect(
            decideBuyReplay({ ...paidRow, existingPiId: "pi_1", verifiedPiId: null, isComp: true }),
        ).toBe("refuse_mismatch");
        // NULL PI on a non-comp-marked row is the failed-stitch state, not a
        // comp row — the comp path must not fail open into it (review A5).
        expect(
            decideBuyReplay({ ...paidRow, existingPiId: null, verifiedPiId: null, isComp: true }),
        ).toBe("refuse_mismatch");
    });

    it("refuses when neither PI nor comp flag is present (should be unreachable, fails closed)", () => {
        expect(
            decideBuyReplay({ ...paidRow, existingPiId: null, verifiedPiId: null, isComp: false }),
        ).toBe("refuse_mismatch");
    });
});
