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
  });

  const data: ResendResponse = await response.json();

  if (!response.ok || data.error) {
    throw new Error(data.error?.message || `Resend API error: ${response.status}`);
  }

  return { id: data.id! };
}
