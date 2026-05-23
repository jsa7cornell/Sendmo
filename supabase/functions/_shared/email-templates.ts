/**
 * SendMo email templates for Resend.
 * All templates use inline styles for maximum email client compatibility.
 */

const BRAND_BLUE = "#2563EB";
const GRAY_600 = "#4B5563";
const GRAY_400 = "#9CA3AF";

function layout(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;">
    <tr><td align="center" style="padding:40px 20px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#ffffff;border-radius:12px;overflow:hidden;">
        <!-- Header -->
        <tr><td style="background-color:${BRAND_BLUE};padding:24px 32px;text-align:center;">
          <img src="https://sendmo.co/icon-192.png" width="36" height="36" alt="" style="display:inline-block;vertical-align:middle;margin-right:10px;border-radius:8px;" />
          <span style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.5px;vertical-align:middle;">SendMo</span>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px;">
          ${content}
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:20px 32px;border-top:1px solid #e5e7eb;text-align:center;">
          <p style="margin:0;font-size:12px;color:${GRAY_400};">SendMo — Prepaid shipping made easy</p>
          <p style="margin:4px 0 0;font-size:12px;color:${GRAY_400};">You received this email because it was requested at sendmo.co</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── OTP Verification Email ────────────────────────────────

export function otpEmail(code: string): { subject: string; html: string } {
  return {
    subject: "Your SendMo verification code",
    html: layout(`
      <h2 style="margin:0 0 8px;font-size:20px;font-weight:600;color:#111827;">Verify your email</h2>
      <p style="margin:0 0 24px;font-size:14px;color:${GRAY_600};line-height:1.5;">
        Enter this code to verify your email address. It expires in 10 minutes.
      </p>
      <div style="text-align:center;margin:0 0 24px;">
        <span style="display:inline-block;font-size:32px;font-weight:700;letter-spacing:8px;color:${BRAND_BLUE};background-color:#eff6ff;padding:16px 24px;border-radius:8px;border:1px solid #bfdbfe;">
          ${code}
        </span>
      </div>
      <p style="margin:0;font-size:13px;color:${GRAY_400};text-align:center;">
        If you didn't request this code, you can safely ignore this email.
      </p>
    `),
  };
}

// ─── Label Confirmation Email ──────────────────────────────

export function labelConfirmationEmail(params: {
  publicCode: string;
  carrierTracking: string;
  carrier: string;
  eta: string;
  trackingUrl: string;
  senderName?: string | null;
  itemDescription?: string | null;
  displayPriceCents?: number | null;
}): { subject: string; html: string } {
  const {
    publicCode,
    carrierTracking,
    carrier,
    eta,
    trackingUrl,
    senderName,
    itemDescription,
    displayPriceCents,
  } = params;

  const trimmedSender = senderName?.trim();
  const trimmedItem = itemDescription?.trim();
  const itemDisplay = trimmedItem && trimmedItem.length > 40
    ? `${trimmedItem.slice(0, 40)}…`
    : trimmedItem;
  const priceDisplay = typeof displayPriceCents === "number" && displayPriceCents > 0
    ? `$${(displayPriceCents / 100).toFixed(2)}`
    : null;

  const summaryRow = (label: string, value: string) => `
    <tr>
      <td style="padding:12px 16px;border-bottom:1px solid #e5e7eb;">
        <span style="font-size:12px;color:${GRAY_400};text-transform:uppercase;letter-spacing:0.5px;">${label}</span><br/>
        <span style="font-size:14px;font-weight:500;color:#111827;">${value}</span>
      </td>
    </tr>`;

  const fromRow = trimmedSender ? summaryRow("From", trimmedSender) : "";
  const itemRow = itemDisplay ? summaryRow("Item", itemDisplay) : "";
  const amountRow = priceDisplay ? summaryRow("Amount", priceDisplay) : "";

  return {
    subject: "A label was printed using your prepaid link — SendMo",
    html: layout(`
      <h2 style="margin:0 0 8px;font-size:20px;font-weight:600;color:#111827;">Label created!</h2>
      <p style="margin:0 0 24px;font-size:14px;color:${GRAY_600};line-height:1.5;">
        A shipping label has been purchased for your SendMo link. Here are the details:
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;background-color:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;">
        <tr>
          <td style="padding:12px 16px;border-bottom:1px solid #e5e7eb;">
            <span style="font-size:12px;color:${GRAY_400};text-transform:uppercase;letter-spacing:0.5px;">SendMo Tracking</span><br/>
            <span style="font-size:22px;font-weight:700;color:${BRAND_BLUE};letter-spacing:1px;">${publicCode}</span><br/>
            <span style="font-size:11px;color:${GRAY_400};">${carrier} #${carrierTracking}</span>
          </td>
        </tr>
        ${fromRow}
        ${itemRow}
        ${amountRow}
        <tr>
          <td style="padding:12px 16px;border-bottom:1px solid #e5e7eb;">
            <span style="font-size:12px;color:${GRAY_400};text-transform:uppercase;letter-spacing:0.5px;">Carrier</span><br/>
            <span style="font-size:14px;font-weight:500;color:#111827;">${carrier}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 16px;">
            <span style="font-size:12px;color:${GRAY_400};text-transform:uppercase;letter-spacing:0.5px;">Estimated Delivery</span><br/>
            <span style="font-size:14px;font-weight:500;color:#111827;">${eta}</span>
          </td>
        </tr>
      </table>
      <div style="text-align:center;margin:0 0 16px;">
        <a href="${trackingUrl}" style="display:inline-block;background-color:${BRAND_BLUE};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 32px;border-radius:8px;">Track Package</a>
      </div>
      <p style="margin:0;font-size:13px;color:${GRAY_400};text-align:center;">
        You'll receive updates as your package moves through the shipping network.
      </p>
    `),
  };
}

// ─── Tracking Update Email ─────────────────────────────────

const STATUS_LABELS: Record<string, { label: string; emoji: string; color: string }> = {
  in_transit: { label: "In Transit", emoji: "📦", color: BRAND_BLUE },
  out_for_delivery: { label: "Out for Delivery", emoji: "🚚", color: "#059669" },
  delivered: { label: "Delivered", emoji: "✅", color: "#059669" },
};

export function trackingUpdateEmail(
  status: string,
  publicCode: string,
  carrierTracking: string,
  carrier?: string,
  estimatedDelivery?: string,
  trackingUrl?: string,
  role: "sender" | "recipient" = "recipient",
): { subject: string; html: string } {
  const info = STATUS_LABELS[status] || { label: status, emoji: "📦", color: BRAND_BLUE };
  const isSender = role === "sender";

  const statusMessage = (() => {
    if (status === "delivered") {
      return isSender
        ? "The package you sent has been delivered!"
        : "Your package has been delivered!";
    }
    if (status === "out_for_delivery") {
      return isSender
        ? "The package you sent is out for delivery and should arrive today."
        : "Your package is out for delivery and should arrive today.";
    }
    return isSender
      ? "The package you sent is on its way."
      : "Your package is on its way.";
  })();

  const etaRow = estimatedDelivery
    ? `<tr>
        <td style="padding:12px 16px;border-bottom:1px solid #e5e7eb;">
          <span style="font-size:12px;color:${GRAY_400};text-transform:uppercase;letter-spacing:0.5px;">Estimated Delivery</span><br/>
          <span style="font-size:14px;font-weight:500;color:#111827;">${estimatedDelivery}</span>
        </td>
      </tr>`
    : "";

  const carrierRow = carrier
    ? `<tr>
        <td style="padding:12px 16px;${!estimatedDelivery ? "" : "border-bottom:1px solid #e5e7eb;"}">
          <span style="font-size:12px;color:${GRAY_400};text-transform:uppercase;letter-spacing:0.5px;">Carrier</span><br/>
          <span style="font-size:14px;font-weight:500;color:#111827;">${carrier}</span>
        </td>
      </tr>`
    : "";

  const trackButton = trackingUrl
    ? `<div style="text-align:center;margin:24px 0 0;">
        <a href="${trackingUrl}" style="display:inline-block;background-color:${BRAND_BLUE};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 32px;border-radius:8px;">Track Package</a>
      </div>`
    : "";

  return {
    subject: isSender
      ? `${info.emoji} Package you sent is ${info.label} — SendMo`
      : `${info.emoji} Your package is ${info.label} — SendMo`,
    html: layout(`
      <div style="text-align:center;margin:0 0 24px;">
        <span style="font-size:48px;">${info.emoji}</span>
      </div>
      <h2 style="margin:0 0 8px;font-size:20px;font-weight:600;color:#111827;text-align:center;">${info.label}</h2>
      <p style="margin:0 0 24px;font-size:14px;color:${GRAY_600};line-height:1.5;text-align:center;">
        ${statusMessage}
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;background-color:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;">
        <tr>
          <td style="padding:12px 16px;${carrierRow || etaRow ? "border-bottom:1px solid #e5e7eb;" : ""}">
            <span style="font-size:12px;color:${GRAY_400};text-transform:uppercase;letter-spacing:0.5px;">SendMo Tracking</span><br/>
            <span style="font-size:22px;font-weight:700;color:${BRAND_BLUE};letter-spacing:1px;">${publicCode}</span><br/>
            <span style="font-size:11px;color:${GRAY_400};">${carrier || "Carrier"} #${carrierTracking}</span>
          </td>
        </tr>
        ${carrierRow}
        ${etaRow}
      </table>
      ${trackButton}
    `),
  };
}

// ─── Payment Declined — Reactivate Email (Pattern D, Phase F) ───
//
// Sent to the recipient of a flex link when an off_session shipment charge
// declines. Copy from proposal §2.1 (John's 2026-05-16 exact wording).
// Deep link sends them to /dashboard?reactivate=<link_id> which auto-opens
// AddCardModal so they can update payment and re-Activate the link.

export function paymentDeclinedReactivateEmail(params: {
  senderName: string | null;        // null → "a sender"
  linkId: string;
  shortCode: string;
  dashboardOrigin?: string;          // defaults to https://sendmo.co
}): { subject: string; html: string } {
  const senderLabel = params.senderName?.trim() || "a sender";
  const origin = (params.dashboardOrigin || "https://sendmo.co").replace(/\/$/, "");
  const reactivateUrl = `${origin}/dashboard?reactivate=${encodeURIComponent(params.linkId)}`;
  return {
    subject: "Action needed — your SendMo link needs payment update",
    html: layout(`
      <h2 style="margin:0 0 8px;font-size:20px;font-weight:600;color:#111827;">Your payment needs an update</h2>
      <p style="margin:0 0 16px;font-size:14px;color:${GRAY_600};line-height:1.5;">
        Your payment failed when ${senderLabel} was printing a shipping label using your link.
        We've temporarily deactivated the link. Click below to update your payment information and reactivate the link.
      </p>
      <div style="text-align:center;margin:24px 0;">
        <a href="${reactivateUrl}" style="display:inline-block;background-color:${BRAND_BLUE};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 32px;border-radius:8px;">Update payment</a>
      </div>
      <p style="margin:0;font-size:12px;color:${GRAY_400};text-align:center;">
        Link: sendmo.co/s/${params.shortCode}
      </p>
    `),
  };
}

// ─── B5: Account-Budget-reached (proposal 2026-05-21, decided 2026-05-22) ───
// Sent to the account holder when an attempted charge would breach their
// daily or weekly spending budget. Admin-raise only — no self-serve.
export function budgetReachedEmail(params: {
  window: "daily" | "weekly";
  limitCents: number;
  dashboardOrigin?: string;
}): { subject: string; html: string } {
  const origin = (params.dashboardOrigin || "https://sendmo.co").replace(/\/$/, "");
  const limitDollars = (params.limitCents / 100).toFixed(2);
  const periodLabel = params.window === "daily" ? "daily" : "weekly";
  return {
    subject: `Your SendMo account reached its ${periodLabel} spending limit`,
    html: layout(`
      <h2 style="margin:0 0 8px;font-size:20px;font-weight:600;color:#111827;">${periodLabel.charAt(0).toUpperCase()}${periodLabel.slice(1)} spending limit reached</h2>
      <p style="margin:0 0 16px;font-size:14px;color:${GRAY_600};line-height:1.5;">
        A recent charge to your SendMo account would have exceeded your ${periodLabel} spending limit of <strong>$${limitDollars}</strong>. The charge was not processed.
      </p>
      <p style="margin:0 0 16px;font-size:14px;color:${GRAY_600};line-height:1.5;">
        If you need a higher limit, reply to this email and we'll raise it for you. This guardrail protects your account from runaway charges; we tune it case by case rather than auto-raising.
      </p>
      <p style="margin:0;font-size:12px;color:${GRAY_400};text-align:center;">
        <a href="${origin}/dashboard" style="color:${BRAND_BLUE};text-decoration:none;">Open your dashboard</a>
      </p>
    `),
  };
}

// ─── H2: Carrier-adjustment notification (auto-recharge tier) ─────────
//
// Sent to the customer when an auto-recharge for a post-pickup carrier
// adjustment succeeds. The customer's card was billed for `amount_cents`
// (delta + $1 handling fee). Honest, factual tone — this is post-hoc
// billing and customer trust matters.
//
// Decided proposal: 2026-05-22_reconciliation-and-carrier-adjustments §2.4.

export function carrierAdjustmentEmail(params: {
  amount_cents: number;             // total billed = delta + fee
  fee_cents: number;                // handling fee component ($1)
  carrier: string;                  // 'UPS', 'USPS', 'FedEx', or 'the carrier'
  reason: string;                   // EasyPost adjustment_reason ('reweigh', etc.)
  public_code: string;              // /t/<code>
  tracking_url: string;             // full URL
}): { subject: string; html: string } {
  const totalDollars = (params.amount_cents / 100).toFixed(2);
  const feeDollars = (params.fee_cents / 100).toFixed(2);
  const deltaDollars = ((params.amount_cents - params.fee_cents) / 100).toFixed(2);
  const carrierLabel = params.carrier?.trim() || "the carrier";
  const reasonLabel = params.reason?.trim() || "weight adjustment";

  return {
    subject: `A small carrier adjustment of $${totalDollars} — SendMo`,
    html: layout(`
      <h2 style="margin:0 0 8px;font-size:20px;font-weight:600;color:#111827;">Carrier adjustment — $${totalDollars}</h2>
      <p style="margin:0 0 16px;font-size:14px;color:${GRAY_600};line-height:1.5;">
        Heads up — ${carrierLabel} re-rated your shipment after pickup (reason: <em>${reasonLabel}</em>) and billed us a bit more than the label price. We covered it and charged your saved card to balance it out.
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;background-color:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;">
        <tr>
          <td style="padding:12px 16px;border-bottom:1px solid #e5e7eb;">
            <span style="font-size:12px;color:${GRAY_400};text-transform:uppercase;letter-spacing:0.5px;">Carrier adjustment</span><br/>
            <span style="font-size:14px;font-weight:500;color:#111827;">$${deltaDollars}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 16px;border-bottom:1px solid #e5e7eb;">
            <span style="font-size:12px;color:${GRAY_400};text-transform:uppercase;letter-spacing:0.5px;">Handling fee</span><br/>
            <span style="font-size:14px;font-weight:500;color:#111827;">$${feeDollars}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 16px;">
            <span style="font-size:12px;color:${GRAY_400};text-transform:uppercase;letter-spacing:0.5px;">Total charged</span><br/>
            <span style="font-size:18px;font-weight:700;color:${BRAND_BLUE};">$${totalDollars}</span>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 16px;font-size:13px;color:${GRAY_600};line-height:1.5;">
        Carriers sometimes reweigh or remeasure packages on their own scales after pickup. If we get charged more than the label price, we pass through the difference plus a small handling fee.
      </p>
      <div style="text-align:center;margin:24px 0 0;">
        <a href="${params.tracking_url}" style="display:inline-block;background-color:${BRAND_BLUE};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 32px;border-radius:8px;">View shipment</a>
      </div>
      <p style="margin:24px 0 0;font-size:12px;color:${GRAY_400};text-align:center;">
        SendMo tracking: <strong>${params.public_code}</strong>
      </p>
    `),
  };
}

// ─── H5: Refund lifecycle emails ─────────────────────────────────────────────
//
// Three customer-facing emails at refund_status transitions.
// Decided proposal: 2026-05-21_refund-system-implementation_..._decided-2026-05-22.md
// Decision D5 — approved copy, carrier-aware, canceller-aware, soft hedge.
//
// Send-sites:
//   Email A — cancel-label/index.ts   (refund_status → submitted)
//   Email B — stripe-webhook/index.ts  (charge.refunded, submitted → refunded)
//   Email C — tracking/index.ts poll + cron-refund-sweep (refund_status → rejected)
//
// Dedup: notifications_log row with contact_id=NULL, provider_id = the keying id.
// Unique index: idx_notifications_log_refund_dedup (migration 035).

type Carrier = string;                // 'USPS' | 'UPS' | 'FedEx' | ...

/** Return the carrier-aware timeline copy for Email A. */
function carrierTimeline(carrier: Carrier): string {
  const upper = (carrier ?? "").toUpperCase();
  if (upper === "USPS") {
    return "USPS refunds typically take 2–4 weeks to process. Once confirmed, we'll issue your refund automatically to the original payment method.";
  }
  // UPS, FedEx, and other carriers are faster
  return "Most refunds are confirmed within 1–2 weeks. Once the carrier confirms, we'll issue your refund automatically to the original payment method.";
}

/** Dollars display — e.g. 1295 → "$12.95" */
function dollarStr(cents: number): string {
  return "$" + (cents / 100).toFixed(2);
}

// ─── Email A — Refund submitted ──────────────────────────────────────────────

export function refundSubmittedEmail(params: {
  amount_cents: number;
  carrier: string;
  public_code: string;
  tracking_url: string;
  /** true  → payer cancelled their own label (omit canceller line)
   *  false → someone else cancelled (add "by the person using your shared link") */
  canceller_is_payer: boolean;
  /** "admin" signals the admin cancelled — shows "by our team" instead of link-user copy */
  canceller_type?: "payer" | "link_user" | "admin";
}): { subject: string; html: string } {
  const {
    amount_cents,
    carrier,
    public_code,
    tracking_url,
    canceller_is_payer,
    canceller_type,
  } = params;
  const amount = dollarStr(amount_cents);

  const cancellationLine = canceller_is_payer
    ? ""
    : canceller_type === "admin"
    ? `<p style="margin:0 0 16px;font-size:14px;color:${GRAY_600};line-height:1.5;">
        Your label was cancelled by our team.
      </p>`
    : `<p style="margin:0 0 16px;font-size:14px;color:${GRAY_600};line-height:1.5;">
        Your label was cancelled by the person using your shared link.
      </p>`;

  const timeline = carrierTimeline(carrier);

  return {
    subject: `Your ${amount} refund is on its way — SendMo`,
    html: layout(`
      <h2 style="margin:0 0 8px;font-size:20px;font-weight:600;color:#111827;">Refund submitted</h2>
      ${cancellationLine}
      <p style="margin:0 0 16px;font-size:14px;color:${GRAY_600};line-height:1.5;">
        We submitted a refund request of <strong>${amount}</strong> to the carrier on your behalf.
        ${timeline}
      </p>
      <p style="margin:0 0 16px;font-size:13px;color:${GRAY_600};line-height:1.5;">
        Carriers sometimes take a bit longer during busy periods — we'll update you the moment it's confirmed.
      </p>
      <div style="text-align:center;margin:24px 0;">
        <a href="${tracking_url}" style="display:inline-block;background-color:${BRAND_BLUE};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 32px;border-radius:8px;">View shipment</a>
      </div>
      <p style="margin:0;font-size:12px;color:${GRAY_400};text-align:center;">
        SendMo tracking: <strong>${public_code}</strong>
      </p>
    `),
  };
}

// ─── Email B — Refund completed ──────────────────────────────────────────────

export function refundCompletedEmail(params: {
  amount_cents: number;
  public_code: string;
  tracking_url: string;
  /** Last 4 digits of the card the refund was issued to, if known */
  last4?: string | null;
}): { subject: string; html: string } {
  const { amount_cents, public_code, tracking_url, last4 } = params;
  const amount = dollarStr(amount_cents);
  const cardLine = last4
    ? `<p style="margin:0 0 16px;font-size:14px;color:${GRAY_600};line-height:1.5;">
        The refund has been issued to the card ending in <strong>${last4}</strong>.
        Please allow 5–10 business days for it to appear on your statement — this is standard bank processing time, not a SendMo delay.
      </p>`
    : `<p style="margin:0 0 16px;font-size:14px;color:${GRAY_600};line-height:1.5;">
        The refund has been issued to your original payment method.
        Please allow 5–10 business days for it to appear on your statement — this is standard bank processing time, not a SendMo delay.
      </p>`;

  return {
    subject: `Your ${amount} refund has been issued — SendMo`,
    html: layout(`
      <h2 style="margin:0 0 8px;font-size:20px;font-weight:600;color:#111827;">Refund issued — ${amount}</h2>
      <p style="margin:0 0 16px;font-size:14px;color:${GRAY_600};line-height:1.5;">
        Great news — the carrier confirmed the cancellation and we've issued your refund.
      </p>
      ${cardLine}
      <div style="text-align:center;margin:24px 0;">
        <a href="${tracking_url}" style="display:inline-block;background-color:${BRAND_BLUE};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 32px;border-radius:8px;">View shipment</a>
      </div>
      <p style="margin:0;font-size:12px;color:${GRAY_400};text-align:center;">
        SendMo tracking: <strong>${public_code}</strong>
      </p>
    `),
  };
}

// ─── Email C — Refund unsuccessful ───────────────────────────────────────────
// Customer-facing word: "Refund unsuccessful" (Decision D4).
// Soft framing: SendMo acts on their behalf; carrier sometimes won't return cost.

export function refundUnsuccessfulEmail(params: {
  amount_cents: number;
  carrier: string;
  public_code: string;
  tracking_url: string;
  /** Best-effort reason from EasyPost (sparse — often null). Don't show if null. */
  reason?: string | null;
}): { subject: string; html: string } {
  const { amount_cents, carrier, public_code, tracking_url, reason } = params;
  const amount = dollarStr(amount_cents);
  const carrierLabel = (carrier ?? "").trim() || "the carrier";

  const reasonLine = reason
    ? `<p style="margin:0 0 16px;font-size:13px;color:${GRAY_600};line-height:1.5;">
        Carrier note: <em>${reason}</em>
      </p>`
    : "";

  return {
    subject: `Refund unsuccessful — ${amount} — SendMo`,
    html: layout(`
      <h2 style="margin:0 0 8px;font-size:20px;font-weight:600;color:#111827;">Refund unsuccessful</h2>
      <p style="margin:0 0 16px;font-size:14px;color:${GRAY_600};line-height:1.5;">
        We submitted a void request for your label and followed up on your behalf, but unfortunately ${carrierLabel} did not return the shipping cost to us. Because the carrier didn't credit us, we're unable to issue a refund for this shipment.
      </p>
      ${reasonLine}
      <p style="margin:0 0 16px;font-size:13px;color:${GRAY_600};line-height:1.5;">
        We know this isn't the outcome you were hoping for. If you believe this was a carrier error, please <a href="mailto:support@sendmo.co" style="color:${BRAND_BLUE};text-decoration:none;">contact us</a> and we'll review the details.
      </p>
      <div style="text-align:center;margin:24px 0;">
        <a href="${tracking_url}" style="display:inline-block;background-color:${BRAND_BLUE};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 32px;border-radius:8px;">View shipment</a>
      </div>
      <p style="margin:0;font-size:12px;color:${GRAY_400};text-align:center;">
        SendMo tracking: <strong>${public_code}</strong>
      </p>
    `),
  };
}

// ─── B4: Radar-blocked-charge notification to the payer (O7) ────────
// Sent on every Stripe Radar block of a flex off_session charge. Gentle:
// the payer's card is fine; a sender on their link was flagged. They may
// want to rotate or cancel the link if it's been shared somewhere bad.
export function radarBlockedPayerEmail(params: {
  linkId: string;
  shortCode: string;
  dashboardOrigin?: string;
}): { subject: string; html: string } {
  const origin = (params.dashboardOrigin || "https://sendmo.co").replace(/\/$/, "");
  const dashUrl = `${origin}/dashboard`;
  return {
    subject: "A charge on your SendMo link was blocked as suspicious",
    html: layout(`
      <h2 style="margin:0 0 8px;font-size:20px;font-weight:600;color:#111827;">A charge on your link was blocked</h2>
      <p style="margin:0 0 16px;font-size:14px;color:${GRAY_600};line-height:1.5;">
        Stripe's fraud detection blocked a recent attempt to use your SendMo link <code>sendmo.co/s/${params.shortCode}</code>. <strong>Your card is fine and no money was charged.</strong> No action is required.
      </p>
      <p style="margin:0 0 16px;font-size:14px;color:${GRAY_600};line-height:1.5;">
        We're letting you know in case you'd like to review where your link is shared — if it's been posted somewhere public and you're seeing repeated blocks, you can rotate or cancel the link from your dashboard.
      </p>
      <div style="text-align:center;margin:24px 0;">
        <a href="${dashUrl}" style="display:inline-block;background-color:${BRAND_BLUE};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 32px;border-radius:8px;">Open dashboard</a>
      </div>
    `),
  };
}
