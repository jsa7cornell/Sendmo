/**
 * Fetch a carrier label and turn it into an email attachment.
 *
 * Why this can exist at all: the label lives on an S3 host that sends no
 * Access-Control-Allow-Origin, which is why the browser cannot fetch it (the
 * tracking page's Download button fell back to opening a raw PNG in a tab for
 * exactly this reason). Server-side there is no CORS, so an edge function can
 * read the bytes freely.
 *
 * WISHLIST.md:77 promised "label PDF delivered to seller (email + their
 * dashboard)" when seller links were built; the email half never shipped.
 * SendMo's first real seller then asked for "a copy of my shipment to my
 * email". This is that.
 *
 * Best-effort by construction: a label that will not fetch must never fail the
 * email, and an email failure must never fail a label purchase. Every caller
 * treats null as "send without the attachment".
 */

import type { EmailAttachment } from "./resend.ts";

/** Labels are small (~20-60KB). Anything larger is a surprise worth skipping. */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Don't let a slow label host hold the notification path open. */
const FETCH_TIMEOUT_MS = 8000;

function extensionFor(contentType: string | null): string {
  if (!contentType) return "png";
  if (contentType.includes("pdf")) return "pdf";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("gif")) return "gif";
  return "png";
}

/** base64 without blowing the stack on a large buffer (btoa needs a string). */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Returns the label as an attachment, or null if it could not be fetched.
 * Never throws.
 *
 * @param labelUrl  the carrier label URL (shipments.label_url)
 * @param publicCode  SendMo's short code — names the file the recipient saves
 */
export async function buildLabelAttachment(
  labelUrl: string | null | undefined,
  publicCode: string,
): Promise<EmailAttachment | null> {
  if (!labelUrl) return null;

  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(labelUrl, { signal: timeout });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type");
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_ATTACHMENT_BYTES) return null;

    return {
      filename: `sendmo-label-${publicCode}.${extensionFor(contentType)}`,
      content: toBase64(buf),
      content_type: contentType ?? "image/png",
    };
  } catch {
    // Network error, timeout, or an expired object — send the email without it.
    // The email always carries a link to the label as well, so nothing is lost
    // that the recipient cannot still reach.
    return null;
  }
}
