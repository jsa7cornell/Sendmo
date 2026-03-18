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
          <span style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.5px;">SendMo</span>
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

export function labelConfirmationEmail(
  tracking: string,
  carrier: string,
  eta: string,
): { subject: string; html: string } {
  return {
    subject: "Your shipping label is ready — SendMo",
    html: layout(`
      <h2 style="margin:0 0 8px;font-size:20px;font-weight:600;color:#111827;">Label created!</h2>
      <p style="margin:0 0 24px;font-size:14px;color:${GRAY_600};line-height:1.5;">
        A shipping label has been purchased for your SendMo link. Here are the details:
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;background-color:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;">
        <tr>
          <td style="padding:12px 16px;border-bottom:1px solid #e5e7eb;">
            <span style="font-size:12px;color:${GRAY_400};text-transform:uppercase;letter-spacing:0.5px;">Tracking Number</span><br/>
            <span style="font-size:16px;font-weight:600;color:${BRAND_BLUE};">${tracking}</span>
          </td>
        </tr>
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
  tracking: string,
): { subject: string; html: string } {
  const info = STATUS_LABELS[status] || { label: status, emoji: "📦", color: BRAND_BLUE };
  return {
    subject: `${info.emoji} Your package is ${info.label.toLowerCase()} — SendMo`,
    html: layout(`
      <div style="text-align:center;margin:0 0 24px;">
        <span style="font-size:48px;">${info.emoji}</span>
      </div>
      <h2 style="margin:0 0 8px;font-size:20px;font-weight:600;color:#111827;text-align:center;">${info.label}</h2>
      <p style="margin:0 0 24px;font-size:14px;color:${GRAY_600};line-height:1.5;text-align:center;">
        ${status === "delivered"
          ? "Your package has been delivered!"
          : status === "out_for_delivery"
            ? "Your package is out for delivery and should arrive today."
            : "Your package is on its way."}
      </p>
      <div style="text-align:center;margin:0 0 24px;background-color:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;padding:16px;">
        <span style="font-size:12px;color:${GRAY_400};text-transform:uppercase;letter-spacing:0.5px;">Tracking Number</span><br/>
        <span style="font-size:16px;font-weight:600;color:${BRAND_BLUE};">${tracking}</span>
      </div>
    `),
  };
}
