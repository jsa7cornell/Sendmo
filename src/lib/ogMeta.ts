// ─── Link-preview (Open Graph) copy + HTML injection ───────────────────────
//
// Single source of truth for what a shared /s/:shortCode link looks like when
// it unfurls in iMessage, WhatsApp, Slack, or Twitter. Imported by:
//
//   middleware.ts          — the live path (Edge Middleware, runs before CDN cache)
//   api/s/[shortCode].ts   — legacy serverless copy, bypassed by the SPA rewrite
//
// Pure functions only (no fetch, no env, no DOM) so both runtimes can use them
// and tests/unit/ogMeta.test.ts can cover them without a browser.
//
// Voice matches the page the link lands on (SenderStepIntro): "You're sending
// a package to John" / "John already paid". Rule 7 — city/state only, never
// street or zip in sender-facing text.

import { titleCaseName } from "./name";

export interface OgLinkPayload {
  recipient_name: string | null;
  recipient_city: string | null;
  recipient_state: string | null;
  link_type?: string | null;
  /** Phase 3: the creator deferred the destination — the sender picks it. */
  needs_destination?: boolean | null;
  /** Seller links: the seller's item text, shown on the card (sanitized). */
  notes?: string | null;
  /**
   * Link lifecycle status, carried by the 410 body for gone links (PR3
   * review #1): a sold seller link must unfurl as sold, not fall through to
   * the prepaid fallback.
   */
  status?: string | null;
  /** Seller-link price band (PR10) — rides the unfurl, where the click decision happens. */
  est_min_cents?: number | null;
  est_max_cents?: number | null;
}

export interface OgStrings {
  title: string;
  description: string;
}

// Shown when the link isn't found or has no address on file.
export const DEFAULT_TITLE = "You've been sent a prepaid shipping label";
export const DEFAULT_DESC =
  "Someone has set up a prepaid shipping label for you. Tap to ship your package — the cost is already covered.";

// Seller links: the BUYER pays for shipping, so the prepaid copy above would
// be a lie on the first thing every buyer reads (seller-link launch PR3).
export const SELLER_TITLE = "Enter your address to get this shipped";
export const SELLER_DESC =
  "The seller set up shipping with SendMo. Enter your delivery address, pick a speed, and pay for shipping — the seller ships it right to you.";

// The seller's item text, made safe for a branded unfurl (review N8): the
// card renders under sendmo.co, so seller-controlled text must not carry
// links or run long. Plain text only — escapeHtml happens at injection.
export function sanitizeItemLabel(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const cleaned = notes
    .replace(/https?:\/\/\S+|www\.\S+/gi, "") // no URLs in a branded card
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  // Code-POINT slice, not code units (review #4): Marketplace text is
  // emoji-dense, and a .slice() through a surrogate pair puts a lone
  // surrogate in og:title (U+FFFD on the card).
  const points = Array.from(cleaned);
  return points.length > 60 ? points.slice(0, 59).join("").trimEnd() + "…" : cleaned;
}

export const OG_IMAGE_URL = "https://sendmo.co/og-image.png";

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildOgStrings(link: OgLinkPayload | null): OgStrings {
  // Seller links reverse who pays: buyer-pays copy, naming the item when the
  // seller wrote one. Never the prepaid fallback — "the cost is already
  // covered" on a buyer-pays link was the knowingly-parked placeholder this
  // replaces (seller-link launch PR3).
  if (link?.link_type === "seller_link") {
    // Sold/closed listing (carried by the 410 body — review #1): the re-share
    // of a sold item is the most-visited card after the first sale, and it
    // must not fall through to any pays-related copy.
    if (link.status && link.status !== "active") {
      return {
        title: "This item has already sold",
        description: "The seller closed this listing on SendMo.",
      };
    }
    const item = sanitizeItemLabel(link.notes);
    // The band on the card (PR10): the unfurl is where the click decision
    // happens, and a precomputed number is the only kind that can ride it.
    // Manual cents formatting on purpose: ogMeta is imported by the Edge
    // middleware + the legacy serverless copy, and pulling formatCents from
    // api.ts would drag import.meta.env access into those runtimes.
    const band =
      typeof link.est_min_cents === "number" && typeof link.est_max_cents === "number"
        ? `Shipping typically $${(link.est_min_cents / 100).toFixed(2)}–$${(link.est_max_cents / 100).toFixed(2)}. `
        : "";
    return {
      // Typographic quotes (review #5): inch-marks are everywhere in listing
      // text (`12" vinyl`), and straight quotes around them break visibly.
      title: item ? `Get “${item}” shipped to you` : SELLER_TITLE,
      description: band + SELLER_DESC,
    };
  }

  // Destination-deferred link (Phase 3): "prepaid label to X" would be wrong —
  // there is deliberately no X, and the sender chooses it.
  if (link?.needs_destination) {
    return {
      title: "You've been sent prepaid shipping",
      description:
        "The postage is covered — you choose where it goes. Tap to enter the delivery address, describe your package, and print the label.",
    };
  }

  const fullName = link?.recipient_name?.trim()
    ? titleCaseName(link.recipient_name)
    : null;
  const firstName = fullName ? fullName.split(" ")[0] : null;
  const cityState =
    link?.recipient_city && link?.recipient_state
      ? `${link.recipient_city}, ${link.recipient_state}`
      : link?.recipient_city ?? null;

  if (!firstName) {
    // No name on file — the destination alone still beats the generic card.
    if (!cityState) return { title: DEFAULT_TITLE, description: DEFAULT_DESC };
    return {
      title: `You're sending a package to ${cityState}`,
      description: `The postage is already paid. Tap to tell us about your package and print the prepaid label.`,
    };
  }

  const title = cityState
    ? `You're sending a package to ${firstName} — ${cityState}`
    : `You're sending a package to ${firstName}`;

  const description = `${fullName} already paid the postage. Tap to tell us about your package and print the prepaid label — it costs you nothing.`;

  return { title, description };
}

// Strips the generic tags Vite ships in index.html, then injects the
// personalised set. The strip is the load-bearing half: without it the crawler
// sees two og:title values and picks the generic one (the bug this fixes —
// LOG 2026-08-10).
export function injectOgTags(
  html: string,
  { title, description, url }: OgStrings & { url: string }
): string {
  const t = escapeHtml(title);
  const d = escapeHtml(description);
  const u = escapeHtml(url);

  const tags = [
    `<title>${t}</title>`,
    `<meta name="description" content="${d}" />`,
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${u}" />`,
    `<meta property="og:image" content="${OG_IMAGE_URL}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="SendMo — prepaid shipping made easy" />`,
    `<meta property="og:site_name" content="SendMo" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${t}" />`,
    `<meta name="twitter:description" content="${d}" />`,
    `<meta name="twitter:image" content="${OG_IMAGE_URL}" />`,
  ].join("\n    ");

  return html
    .replace(/<title>[\s\S]*?<\/title>/i, "")
    .replace(
      /<meta\b[^>]*\b(?:property|name)\s*=\s*["'](?:og:[^"']*|twitter:[^"']*|description)["'][^>]*>\s*/gi,
      ""
    )
    .replace("<head>", `<head>\n    ${tags}`);
}
