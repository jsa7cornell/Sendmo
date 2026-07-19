// Unit tests for the label-created admin-notice row builder
// (supabase/functions/_shared/label-notice.ts).
//
// The builder is a pure function precisely so the SendMo cost/margin math is
// tested here rather than only observed in an email. Pure module — no Deno /
// resend deps to mock (it type-only-imports AdminAlertRow).

import { describe, it, expect } from "vitest";
import {
    buildLabelCreatedNoticeRows,
    type LabelNoticeFacts,
} from "../../supabase/functions/_shared/label-notice.ts";

// A live full-prepaid label mirroring the real first package
// ($12.14 charged / $9.69 EasyPost cost — KMDCNEW).
const LIVE: LabelNoticeFacts = {
    mode: "live",
    flow: "full prepaid",
    carrier: "USPS",
    service: "GroundAdvantage",
    eta: "2026-07-21",
    itemDescription: "Birthday gift",
    weightOz: 32,
    lengthIn: 12,
    widthIn: 9,
    heightIn: 4,
    publicCode: "KMDCNEW",
    trackingNumber: "9434636208303451485486",
    senderName: "John Sender",
    senderEmail: "sender@example.com",
    senderPhone: "+16505551212",
    senderIp: "203.0.113.7",
    recipientName: "Jane Recipient",
    recipientEmail: "jane@example.com",
    recipientPhone: "+19135554321",
    payerEmail: "payer@example.com",
    fromAddress: {
        name: "John Sender",
        street1: "1 Alpine Rd",
        street2: null,
        city: "Portola Valley",
        state: "CA",
        zip: "94028",
        country: "US",
        phone: "+16505551212",
    },
    toAddress: {
        name: "Jane Recipient",
        street1: "5 Mission Rd",
        street2: "Apt 2",
        city: "Prairie Village",
        state: "KS",
        zip: "66208",
        country: "US",
        phone: "+19135554321",
    },
    isComp: false,
    chargedCents: 1214,
    easypostCents: 969,
    stripeFeePct: 0.029,
    stripeFeeFlatCents: 30,
    priceCapCents: null,
    paymentMethod: "card",
    paymentIntentId: "pi_live_123",
    paymentStatus: "succeeded",
    easypostShipmentId: "shp_abc",
    easypostTrackerId: "trk_def",
    shipmentId: "11111111-2222-3333-4444-555555555555",
    linkShortCode: null,
    sessionId: "sess_xyz",
};

// Helper: find the value rendered for a given label.
function valueOf(rows: ReturnType<typeof buildLabelCreatedNoticeRows>, label: string) {
    return rows.find((r) => r.label === label && !r.heading)?.value;
}

describe("buildLabelCreatedNoticeRows", () => {
    it("emits the four section headers", () => {
        const rows = buildLabelCreatedNoticeRows(LIVE);
        const headings = rows.filter((r) => r.heading).map((r) => r.label);
        expect(headings).toEqual(["Shipment", "Parties", "Money", "IDs"]);
    });

    it("computes Stripe fee = charged × pct + flat (rounded)", () => {
        const rows = buildLabelCreatedNoticeRows(LIVE);
        // 1214 * 0.029 + 30 = 65.206 → 65¢
        expect(valueOf(rows, "Stripe fee (est)")).toBe("$0.65");
    });

    it("computes net margin = charged − EasyPost − Stripe fee", () => {
        const rows = buildLabelCreatedNoticeRows(LIVE);
        // 1214 − 969 − 65 = 180¢
        expect(valueOf(rows, "Net margin (est)")).toBe("$1.80");
        expect(valueOf(rows, "Charged")).toBe("$12.14");
        expect(valueOf(rows, "EasyPost cost")).toBe("$9.69");
    });

    it("surfaces every party email for the fraud check", () => {
        const rows = buildLabelCreatedNoticeRows(LIVE);
        expect(valueOf(rows, "Sender email")).toBe("sender@example.com");
        expect(valueOf(rows, "Recipient email")).toBe("jane@example.com");
        expect(valueOf(rows, "Payer (account)")).toBe("payer@example.com");
        expect(valueOf(rows, "Sender IP")).toBe("203.0.113.7");
    });

    it("renders full addresses (incl. street2) as a single readable line", () => {
        const rows = buildLabelCreatedNoticeRows(LIVE);
        expect(valueOf(rows, "From")).toContain("1 Alpine Rd");
        expect(valueOf(rows, "From")).toContain("Portola Valley, CA 94028");
        const to = valueOf(rows, "To");
        expect(to).toContain("5 Mission Rd");
        expect(to).toContain("Apt 2"); // street2 not dropped
        expect(to).toContain("Prairie Village, KS 66208");
    });

    it("renders parcel weight + dims and the item description", () => {
        const rows = buildLabelCreatedNoticeRows(LIVE);
        expect(valueOf(rows, "Parcel")).toBe("32 oz · 12×9×4 in");
        expect(valueOf(rows, "Item")).toBe("Birthday gift");
    });

    it("carries Stripe payment intent + status through for reconciliation", () => {
        const rows = buildLabelCreatedNoticeRows(LIVE);
        expect(valueOf(rows, "Payment intent")).toBe("pi_live_123");
        expect(valueOf(rows, "Payment status")).toBe("succeeded");
    });

    it('comp: Charged is "$0.00 (comp)", Stripe fee "—", margin = −EasyPost cost', () => {
        const rows = buildLabelCreatedNoticeRows({
            ...LIVE,
            mode: "comp",
            isComp: true,
            chargedCents: 0,
            paymentMethod: "comp (no charge)",
            paymentIntentId: null,
            paymentStatus: null,
        });
        expect(valueOf(rows, "Charged")).toBe("$0.00 (comp)");
        expect(valueOf(rows, "Stripe fee (est)")).toBe("—");
        // SendMo eats the EasyPost cost → margin is exactly −$9.69.
        expect(valueOf(rows, "Net margin (est)")).toBe("-$9.69");
        expect(valueOf(rows, "Payment intent")).toBe("—");
    });

    it("flex: shows the price cap and link code", () => {
        const rows = buildLabelCreatedNoticeRows({
            ...LIVE,
            flow: "flexible link",
            priceCapCents: 10000,
            linkShortCode: "AB12CD34",
        });
        expect(valueOf(rows, "Mode")).toBe("live · flexible link");
        expect(valueOf(rows, "Price cap")).toBe("$100.00");
        expect(valueOf(rows, "Link code")).toBe("AB12CD34");
    });

    it('renders "—" for everything we did NOT capture (visible gaps, not silent drops)', () => {
        const sparse: LabelNoticeFacts = {
            mode: "test",
            flow: "full prepaid",
            carrier: "USPS",
            service: "",
            isComp: false,
            chargedCents: 500,
            easypostCents: 400,
            stripeFeePct: 0.029,
            stripeFeeFlatCents: 30,
        };
        const rows = buildLabelCreatedNoticeRows(sparse);
        expect(valueOf(rows, "Sender email")).toBe("—");
        expect(valueOf(rows, "Recipient email")).toBe("—");
        expect(valueOf(rows, "From")).toBe("—");
        expect(valueOf(rows, "Item")).toBe("—");
        expect(valueOf(rows, "Price cap")).toBe("—");
        // Carrier with empty service still renders the carrier alone.
        expect(valueOf(rows, "Carrier")).toBe("USPS");
    });
});
