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
}

export interface OgStrings {
  title: string;
  description: string;
}

// Shown when the link isn't found, has no address on file, or is a seller link
// (where the buyer pays — "already covered" would be wrong, so the neutral copy
// stands until that flow launches).
export const DEFAULT_TITLE = "You've been sent a prepaid shipping label";
export const DEFAULT_DESC =
  "Someone has set up a prepaid shipping label for you. Tap to ship your package — the cost is already covered.";

export const OG_IMAGE_URL = "https://sendmo.co/og-image.png";

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildOgStrings(link: OgLinkPayload | null): OgStrings {
  // Seller links reverse who pays — keep the neutral copy rather than promising
  // prepaid postage. Revisit when that flow launches.
  if (link?.link_type === "seller_link") {
    return { title: DEFAULT_TITLE, description: DEFAULT_DESC };
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
