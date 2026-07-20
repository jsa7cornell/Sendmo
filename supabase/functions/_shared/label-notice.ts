// Row builder for the "New label created" admin notice (John's ask,
// 2026-07-18): surface EVERYTHING we know about a shipment so John can run a
// per-transaction fraud check and learn from each one — full addresses, every
// party email, parcel + item, and a full SendMo cost/margin breakdown.
//
// Extracted as a pure function (not inlined in labels/index.ts) for two
// reasons: (1) labels/index.ts calls `serve()` at import, so it can't be
// unit-tested directly — the money math below (Stripe fee + net margin) is
// exactly the kind of thing that must have a test; (2) it keeps the already
// ~1900-line label handler readable. Consumed only by labels/index.ts's
// label.created admin-notice block; rendered by sendAdminAlert (variant
// "notice"), which groups rows via the `heading` flag added alongside this.
//
// Type-only import so this module stays free of alert.ts's Deno/resend runtime
// deps and is trivially unit-testable under vitest.
import type { AdminAlertRow } from "./alert.ts";

export interface LabelNoticeAddress {
    name?: string | null;
    street1?: string | null;
    street2?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    country?: string | null;
    phone?: string | null;
}

export interface LabelNoticeFacts {
    // ── shipment ──────────────────────────────────────────────────────────
    mode: string;                       // "test" | "live" | "comp"
    flow: string;                       // "full prepaid" | "flexible link"
    carrier: string;
    service: string;
    eta?: string | null;                // promised delivery date or "N business days"
    itemDescription?: string | null;    // what the sender says is inside
    weightOz?: number | null;
    lengthIn?: number | null;
    widthIn?: number | null;
    heightIn?: number | null;
    publicCode?: string | null;         // SendMo canonical code (drives the URL)
    trackingNumber?: string | null;     // carrier's number

    // ── parties (the fraud-check surface) ─────────────────────────────────
    senderName?: string | null;
    senderEmail?: string | null;        // sender-entered (flex sender types this)
    senderPhone?: string | null;
    senderIp?: string | null;           // IP the confirm POST came from
    recipientName?: string | null;
    recipientEmail?: string | null;     // link owner (flex) or client-supplied (full)
    recipientPhone?: string | null;
    payerEmail?: string | null;         // authenticated account that paid, if any
    fromAddress?: LabelNoticeAddress | null;
    toAddress?: LabelNoticeAddress | null;

    // ── money (all cents) ─────────────────────────────────────────────────
    isComp: boolean;
    chargedCents: number;               // what the customer was charged (0 for comp)
    easypostCents: number;              // what SendMo pays the carrier via EasyPost
    stripeFeePct: number;               // e.g. 0.029
    stripeFeeFlatCents: number;         // e.g. 30
    priceCapCents?: number | null;      // flex link max the payer allowed
    paymentMethod?: string | null;      // "card" | "comp (no charge)" | …
    paymentIntentId?: string | null;    // Stripe pi_…
    paymentStatus?: string | null;      // Stripe PI status

    // ── ids / debug ───────────────────────────────────────────────────────
    easypostShipmentId?: string | null;
    easypostTrackerId?: string | null;
    shipmentId?: string | null;         // SendMo shipments.id (uuid)
    linkShortCode?: string | null;      // flex link code, if any
    sessionId?: string | null;
}

const fmt = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;

function fmtAddress(a?: LabelNoticeAddress | null): string {
    if (!a) return "—";
    const cityLine = [a.city, a.state].filter(Boolean).join(", ");
    const cityZip = [cityLine, a.zip].filter(Boolean).join(" ");
    return (
        [a.name, a.street1, a.street2, cityZip, a.country]
            .map((s) => (s ?? "").toString().trim())
            .filter(Boolean)
            .join(" · ") || "—"
    );
}

/**
 * Build the label/value rows for the label-created admin notice. Missing
 * fields render as "—" (deliberate — John wants to see what we DIDN'T capture,
 * not have it silently dropped). Money rows compute the Stripe fee and net
 * margin from the passed cents + fee constants so the arithmetic is tested.
 */
export function buildLabelCreatedNoticeRows(f: LabelNoticeFacts): AdminAlertRow[] {
    const dash = (v?: string | null) => (v && v.toString().trim() ? v.toString().trim() : "—");

    const stripeFeeCents = f.chargedCents > 0
        ? Math.round(f.chargedCents * f.stripeFeePct + f.stripeFeeFlatCents)
        : 0;
    // Net to SendMo = charged − carrier cost − Stripe fee. Comp has no charge,
    // so margin is exactly the negative EasyPost cost (SendMo eats it).
    const marginCents = f.chargedCents - f.easypostCents - stripeFeeCents;

    const parcelDims = [f.lengthIn, f.widthIn, f.heightIn].every((n) => typeof n === "number")
        ? `${f.lengthIn}×${f.widthIn}×${f.heightIn} in`
        : null;
    const parcelStr = [
        typeof f.weightOz === "number" ? `${f.weightOz} oz` : null,
        parcelDims,
    ].filter(Boolean).join(" · ") || "—";

    const rows: AdminAlertRow[] = [
        { label: "Shipment", heading: true },
        { label: "Mode", value: `${f.mode} · ${f.flow}` },
        { label: "Item", value: dash(f.itemDescription) },
        { label: "Carrier", value: `${f.carrier} ${f.service}`.trim() || "—" },
        { label: "ETA", value: dash(f.eta) },
        { label: "Parcel", value: parcelStr },
        { label: "Public code", value: dash(f.publicCode) },
        { label: "Tracking", value: dash(f.trackingNumber) },

        { label: "Parties", heading: true },
        { label: "Sender", value: dash(f.senderName) },
        { label: "Sender email", value: dash(f.senderEmail) },
        { label: "Sender phone", value: dash(f.senderPhone) },
        { label: "Sender IP", value: dash(f.senderIp) },
        { label: "Recipient", value: dash(f.recipientName) },
        { label: "Recipient email", value: dash(f.recipientEmail) },
        { label: "Recipient phone", value: dash(f.recipientPhone) },
        { label: "Payer (account)", value: dash(f.payerEmail) },
        { label: "From", value: fmtAddress(f.fromAddress) },
        { label: "To", value: fmtAddress(f.toAddress) },

        { label: "Money", heading: true },
        { label: "Charged", value: f.isComp ? "$0.00 (comp)" : fmt(f.chargedCents) },
        { label: "EasyPost cost", value: fmt(f.easypostCents) },
        { label: "Stripe fee (est)", value: f.isComp ? "—" : fmt(stripeFeeCents) },
        { label: "Net margin (est)", value: fmt(marginCents) },
        { label: "Price cap", value: typeof f.priceCapCents === "number" ? fmt(f.priceCapCents) : "—" },
        { label: "Payment method", value: dash(f.paymentMethod) },
        { label: "Payment intent", value: dash(f.paymentIntentId) },
        { label: "Payment status", value: dash(f.paymentStatus) },

        { label: "IDs", heading: true },
        { label: "EasyPost shipment", value: dash(f.easypostShipmentId) },
        { label: "EasyPost tracker", value: dash(f.easypostTrackerId) },
        { label: "SendMo shipment", value: dash(f.shipmentId) },
        { label: "Link code", value: dash(f.linkShortCode) },
        { label: "Session", value: dash(f.sessionId) },
    ];

    return rows;
}
