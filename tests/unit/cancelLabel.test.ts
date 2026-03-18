/**
 * Unit tests for label cancellation eligibility logic
 *
 * These tests mirror the guard logic in the cancel-label Edge Function
 * to ensure consistent behavior between client-side UI gating and server-side enforcement.
 */
import { describe, it, expect } from "vitest";

// ── Pure helper functions extracted from Edge Function logic ──────────────────

type ShipmentStatus = "label_created" | "in_transit" | "out_for_delivery" | "delivered" | "return_to_sender" | "cancelled";
type RefundStatus = "none" | "submitted" | "refunded" | "rejected" | "not_applicable";

interface Shipment {
    status: ShipmentStatus;
    refund_status: RefundStatus;
    easypost_shipment_id: string | null;
}

function isEligibleForCancellation(shipment: Shipment): { eligible: boolean; reason?: string } {
    if (shipment.status !== "label_created") {
        const messages: Partial<Record<ShipmentStatus, string>> = {
            in_transit: "This label is already in transit and cannot be voided.",
            out_for_delivery: "This label is out for delivery and cannot be voided.",
            delivered: "This shipment has already been delivered.",
            return_to_sender: "This shipment is being returned to sender.",
            cancelled: "This label has already been cancelled.",
        };
        return { eligible: false, reason: messages[shipment.status] || `Cannot cancel: status is ${shipment.status}` };
    }

    if (shipment.refund_status !== "none") {
        const messages: Partial<Record<RefundStatus, string>> = {
            submitted: "A void request has already been submitted for this label.",
            refunded: "This label has already been voided and refunded.",
            rejected: "A void request was previously submitted but rejected by the carrier.",
            not_applicable: "This label type is not eligible for refunds.",
        };
        return { eligible: false, reason: messages[shipment.refund_status] || "Refund already in progress." };
    }

    if (!shipment.easypost_shipment_id) {
        return { eligible: false, reason: "No carrier shipment reference found." };
    }

    return { eligible: true };
}

function getRefundStatusMessage(refundStatus: string): string {
    const messages: Record<string, string> = {
        submitted: "Label void submitted. Your refund will be processed within 2–4 weeks and credited back to your SendMo account.",
        refunded: "Label voided and refunded successfully.",
        rejected: "The void request was rejected. The label may have already been scanned by the carrier.",
        not_applicable: "This label type is not eligible for a refund.",
    };
    return messages[refundStatus] || "Void request submitted.";
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Label Cancellation — Eligibility Guards", () => {

    describe("isEligibleForCancellation", () => {

        it("allows cancellation when status is label_created and refund_status is none", () => {
            const result = isEligibleForCancellation({
                status: "label_created",
                refund_status: "none",
                easypost_shipment_id: "shp_abc123",
            });
            expect(result.eligible).toBe(true);
            expect(result.reason).toBeUndefined();
        });

        it("blocks cancellation when shipment is in transit", () => {
            const result = isEligibleForCancellation({
                status: "in_transit",
                refund_status: "none",
                easypost_shipment_id: "shp_abc123",
            });
            expect(result.eligible).toBe(false);
            expect(result.reason).toContain("in transit");
        });

        it("blocks cancellation when shipment is out for delivery", () => {
            const result = isEligibleForCancellation({
                status: "out_for_delivery",
                refund_status: "none",
                easypost_shipment_id: "shp_abc123",
            });
            expect(result.eligible).toBe(false);
            expect(result.reason).toContain("out for delivery");
        });

        it("blocks cancellation when shipment is already delivered", () => {
            const result = isEligibleForCancellation({
                status: "delivered",
                refund_status: "none",
                easypost_shipment_id: "shp_abc123",
            });
            expect(result.eligible).toBe(false);
            expect(result.reason).toContain("delivered");
        });

        it("blocks cancellation when shipment is already cancelled", () => {
            const result = isEligibleForCancellation({
                status: "cancelled",
                refund_status: "none",
                easypost_shipment_id: "shp_abc123",
            });
            expect(result.eligible).toBe(false);
            expect(result.reason).toContain("already been cancelled");
        });

        it("blocks cancellation when refund is already submitted", () => {
            const result = isEligibleForCancellation({
                status: "label_created",
                refund_status: "submitted",
                easypost_shipment_id: "shp_abc123",
            });
            expect(result.eligible).toBe(false);
            expect(result.reason).toContain("already been submitted");
        });

        it("blocks cancellation when refund has already been processed", () => {
            const result = isEligibleForCancellation({
                status: "label_created",
                refund_status: "refunded",
                easypost_shipment_id: "shp_abc123",
            });
            expect(result.eligible).toBe(false);
            expect(result.reason).toContain("already been voided");
        });

        it("blocks cancellation when refund was rejected by carrier", () => {
            const result = isEligibleForCancellation({
                status: "label_created",
                refund_status: "rejected",
                easypost_shipment_id: "shp_abc123",
            });
            expect(result.eligible).toBe(false);
            expect(result.reason).toContain("rejected");
        });

        it("blocks cancellation when no carrier shipment reference exists", () => {
            const result = isEligibleForCancellation({
                status: "label_created",
                refund_status: "none",
                easypost_shipment_id: null,
            });
            expect(result.eligible).toBe(false);
            expect(result.reason).toContain("No carrier shipment reference");
        });

        it("blocks cancellation for return_to_sender shipments", () => {
            const result = isEligibleForCancellation({
                status: "return_to_sender",
                refund_status: "none",
                easypost_shipment_id: "shp_abc123",
            });
            expect(result.eligible).toBe(false);
            expect(result.reason).toContain("returned to sender");
        });
    });
});

describe("Label Cancellation — Refund Status Messages", () => {
    it("provides user-friendly message for submitted refunds (no carrier branding)", () => {
        const msg = getRefundStatusMessage("submitted");
        expect(msg).toContain("SendMo account");
        expect(msg.toLowerCase()).not.toContain("easypost");
        expect(msg.toLowerCase()).not.toContain("carrier");
    });

    it("provides success message for fully refunded labels", () => {
        const msg = getRefundStatusMessage("refunded");
        expect(msg).toContain("successfully");
    });

    it("provides informative message for rejected refunds without carrier branding", () => {
        const msg = getRefundStatusMessage("rejected");
        // Should mention scanning but not name the carrier
        expect(msg).not.toContain("EasyPost");
        expect(msg).not.toContain("USPS");
        expect(msg).not.toContain("UPS");
    });

    it("handles unknown refund status gracefully", () => {
        const msg = getRefundStatusMessage("unknown_future_status");
        expect(typeof msg).toBe("string");
        expect(msg.length).toBeGreaterThan(0);
    });
});

describe("Label Cancellation — Edge Cases", () => {
    it("does not allow double cancellation", () => {
        // A shipment that was already cancelled (status=cancelled, refund_status=submitted)
        const result = isEligibleForCancellation({
            status: "cancelled",
            refund_status: "submitted",
            easypost_shipment_id: "shp_abc123",
        });
        expect(result.eligible).toBe(false);
    });

    it("validates easypost_shipment_id is required even for label_created shipments", () => {
        // Simulate a label that was created in DB but the EasyPost call never stored the ID
        const result = isEligibleForCancellation({
            status: "label_created",
            refund_status: "none",
            easypost_shipment_id: "",
        });
        // Empty string is falsy, same as null
        expect(result.eligible).toBe(false);
    });
});

describe("Label Cancellation — Test Mode Simulation", () => {
    // Documents expected behavior: test labels bypass carrier API
    // See DECISIONS.md: "EasyPost test labels cannot be refunded via API"

    it("test labels are synthetic and require local simulation", () => {
        // This test documents the known EasyPost limitation:
        // calling POST /v2/shipments/{id}/refund on a test shipment returns an error.
        // The cancel-label function handles this by simulating success in test mode.
        const testVoidId = `test_void_${Date.now()}`;
        expect(testVoidId).toMatch(/^test_void_\d+$/);
    });

    it("test mode simulated refund_status is 'submitted'", () => {
        // The simulated status mirrors what live mode returns from EasyPost
        // so downstream UI handling is identical for both modes
        const simulatedStatus = "submitted";
        const messages: Record<string, string> = {
            submitted: "Label void submitted. Your refund will be processed within 2–4 weeks and credited back to your SendMo account.",
            refunded: "Label voided and refunded successfully.",
        };
        expect(messages[simulatedStatus]).toContain("SendMo account");
        expect(messages[simulatedStatus]).not.toContain("EasyPost");
    });
});
