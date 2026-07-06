/**
 * Unit tests for cancel-label post-void failure paths.
 *
 * These tests mirror the post-void decision logic in the cancel-label Edge
 * Function (same pattern as tests/unit/cancelLabel.test.ts — pure mirrors of
 * server logic, no DB/network) and pin two 2026-07-06 money-path fixes:
 *
 * 1. DB-update failure after a SUCCESSFUL carrier void must return
 *    HTTP 500 { success: false, retry_safe: true } — NOT the old
 *    HTTP 200 { success: true, warning } that stranded the refund
 *    (shipment stayed refund_status='none', so neither refund pull-path
 *    — tracking poll or cron sweep — ever armed the Stripe refund).
 *    An admin alert must fire with the shipment/PI details.
 *
 * 2. Concurrent-cancel race: the post-void UPDATE is guarded with
 *    .eq("refund_status", "none") + .select("id"); when the update
 *    succeeds but affects 0 rows (another cancel won), the function
 *    returns the existing 422 "already in progress" shape instead of
 *    proceeding to emails/link revival.
 */
import { describe, it, expect } from "vitest";

// ── Pure mirrors of the Edge Function's post-void decision logic ──────────────

interface PostVoidUpdateResult {
    error: { message: string } | null;
    /** Rows returned by .select("id") — empty when the guard matched 0 rows. */
    rows: Array<{ id: string }>;
}

type PostVoidOutcome =
    | { kind: "db_failure"; status: 500; body: { success: false; error: string; retry_safe: true } }
    | { kind: "lost_race"; status: 422; body: { error: string; refund_status: string } }
    | { kind: "proceed" };

function resolvePostVoidUpdateOutcome(result: PostVoidUpdateResult): PostVoidOutcome {
    if (result.error) {
        return {
            kind: "db_failure",
            status: 500,
            body: {
                success: false,
                error: "The label was voided with the carrier, but we couldn't record it. Please try cancelling again — it's safe to retry.",
                retry_safe: true,
            },
        };
    }
    if (result.rows.length === 0) {
        // Another concurrent cancel passed the read-guards and won the
        // refund_status='none' → write race. Same shape as the read-guard 422.
        return {
            kind: "lost_race",
            status: 422,
            body: {
                error: "A cancellation is already in progress for this label.",
                refund_status: "submitted",
            },
        };
    }
    return { kind: "proceed" };
}

// Mirror of the admin-alert rows built in the db_failure branch.
interface AlertShipment {
    id: string;
    public_code: string;
    stripe_payment_intent_id: string | null;
    is_test: boolean;
}

function buildDbFailureAlertRows(
    shipment: AlertShipment,
    intendedRefundStatus: string,
    dbErrorMessage: string,
): Array<{ label: string; value: string }> {
    return [
        { label: "Shipment", value: shipment.id },
        { label: "Public code", value: shipment.public_code },
        { label: "PaymentIntent", value: shipment.stripe_payment_intent_id ?? "none/comp" },
        { label: "Intended refund_status", value: intendedRefundStatus },
        { label: "DB error", value: dbErrorMessage },
        { label: "Mode", value: shipment.is_test ? "Test" : "LIVE" },
    ];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Cancel Label — post-void DB update failure", () => {
    it("returns HTTP 500 with success:false when the UPDATE errors after a carrier void", () => {
        const outcome = resolvePostVoidUpdateOutcome({
            error: { message: "connection reset" },
            rows: [],
        });
        expect(outcome.kind).toBe("db_failure");
        if (outcome.kind !== "db_failure") throw new Error("unreachable");
        expect(outcome.status).toBe(500);
        expect(outcome.body.success).toBe(false);
    });

    it("never returns success:true on a DB failure (the stranded-refund regression)", () => {
        // Before the fix: HTTP 200 { success: true, warning: "…please refresh." }
        // left the shipment at status='label_created', refund_status='none' —
        // both refund pull-paths key on refund_status='submitted', so the
        // customer's Stripe refund was never armed.
        const outcome = resolvePostVoidUpdateOutcome({
            error: { message: "timeout" },
            rows: [],
        });
        expect(outcome.kind).not.toBe("proceed");
        if (outcome.kind === "db_failure") {
            expect(outcome.body.success).not.toBe(true);
            expect(outcome.body).not.toHaveProperty("warning");
        }
    });

    it("marks the failure retry-safe (EasyPost /refund is idempotent for an already-voided shipment)", () => {
        const outcome = resolvePostVoidUpdateOutcome({
            error: { message: "timeout" },
            rows: [],
        });
        if (outcome.kind !== "db_failure") throw new Error("expected db_failure");
        expect(outcome.body.retry_safe).toBe(true);
        expect(outcome.body.error).toContain("safe to retry");
        expect(outcome.body.error).toContain("voided with the carrier");
    });

    it("builds admin-alert rows with the PI, intended refund_status, and mode", () => {
        const rows = buildDbFailureAlertRows(
            {
                id: "ship_123",
                public_code: "ABC1234",
                stripe_payment_intent_id: "pi_test_999",
                is_test: false,
            },
            "submitted",
            "connection reset",
        );
        const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
        expect(byLabel["Shipment"]).toBe("ship_123");
        expect(byLabel["Public code"]).toBe("ABC1234");
        expect(byLabel["PaymentIntent"]).toBe("pi_test_999");
        expect(byLabel["Intended refund_status"]).toBe("submitted");
        expect(byLabel["DB error"]).toBe("connection reset");
        expect(byLabel["Mode"]).toBe("LIVE");
    });

    it("renders comp shipments (no PI) as 'none/comp' and test mode as 'Test'", () => {
        const rows = buildDbFailureAlertRows(
            {
                id: "ship_456",
                public_code: "XYZ9876",
                stripe_payment_intent_id: null,
                is_test: true,
            },
            "not_applicable",
            "boom",
        );
        const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
        expect(byLabel["PaymentIntent"]).toBe("none/comp");
        expect(byLabel["Mode"]).toBe("Test");
    });
});

describe("Cancel Label — concurrent-cancel race guard", () => {
    it("returns the 422 'already in progress' shape when the guarded UPDATE affects 0 rows", () => {
        const outcome = resolvePostVoidUpdateOutcome({ error: null, rows: [] });
        expect(outcome.kind).toBe("lost_race");
        if (outcome.kind !== "lost_race") throw new Error("unreachable");
        expect(outcome.status).toBe(422);
        expect(outcome.body.error).toBe("A cancellation is already in progress for this label.");
        expect(outcome.body.refund_status).toBe("submitted");
    });

    it("proceeds to emails/link revival only when exactly this request's UPDATE wrote the row", () => {
        const outcome = resolvePostVoidUpdateOutcome({
            error: null,
            rows: [{ id: "ship_123" }],
        });
        expect(outcome.kind).toBe("proceed");
    });
});
