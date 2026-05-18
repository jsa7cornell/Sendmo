/**
 * Resend email client for SendMo Edge Functions.
 * Uses the Resend REST API directly (no SDK needed for Deno).
 */

const RESEND_API_URL = "https://api.resend.com/emails";

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  from?: string;
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
    }),
    signal: params.signal,
  });

  const data: ResendResponse = await response.json();

  if (!response.ok || data.error) {
    throw new Error(data.error?.message || `Resend API error: ${response.status}`);
  }

  return { id: data.id! };
}
