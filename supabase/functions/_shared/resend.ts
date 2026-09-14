/**
 * Resend email client for SendMo Edge Functions.
 * Uses the Resend REST API directly (no SDK needed for Deno).
 */

const RESEND_API_URL = "https://api.resend.com/emails";

/**
 * One file to attach. `content` is base64 (no data: prefix) — Resend's
 * documented shape for inline bytes.
 */
export interface EmailAttachment {
  filename: string;
  content: string;
  contentType?: string;
}

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  from?: string;
  /**
   * Optional files. Added 2026-09-14 so the label-created email can carry the
   * label itself — WISHLIST.md:77 promised "label PDF delivered to seller
   * (email + their dashboard)" at the seller-link build and it was never done.
   * Resend caps a message at 40MB; our labels are ~20-60KB PNGs.
   */
  attachments?: EmailAttachment[];
  // Optional AbortSignal — pass from an AbortController to enforce a timeout
  // on the Resend POST. The stripe-webhook decline-recovery email uses this
  // to keep the webhook handler under Stripe's 30s response window.
  signal?: AbortSignal;
}

interface ResendResponse {
  id?: string;
  error?: { message: string; name: string };
}

export async function sendEmail(params: SendEmailParams): Promise<{ id: string }> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    throw new Error("RESEND_API_KEY not configured");
  }

  const from = params.from || Deno.env.get("SENDMO_FROM_EMAIL") || "SendMo <noreply@sendmo.co>";

  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to: [params.to],
      subject: params.subject,
      html: params.html,
      ...(params.attachments?.length ? { attachments: params.attachments } : {}),
    }),
    signal: params.signal,
  });

  const data: ResendResponse = await response.json();

  if (!response.ok || data.error) {
    throw new Error(data.error?.message || `Resend API error: ${response.status}`);
  }

  return { id: data.id! };
}
