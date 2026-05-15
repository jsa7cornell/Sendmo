import type { VercelRequest, VercelResponse } from "@vercel/node";

// ─── OG Meta Tag Handler for /s/:shortCode ─────────────────────────────────
//
// Intercepts sender-flow URLs before the SPA catch-all so social crawlers
// (iMessage, Slack, WhatsApp, Twitter) get personalised OG meta tags:
//
//   "John's Prepaid Label → Portola Valley, CA"
//
// Real browsers receive the same index.html they always would — the SPA boots
// normally and React Router renders <SenderFlow />.
//
// Architecture:
//   vercel.json routes /s/:shortCode → this function (before the /(*) rewrite)
//   Function fetches link data → fetches index.html → injects OG tags → returns HTML
//
// Supabase env vars needed in Vercel:
//   VITE_SUPABASE_URL       (already set — used by the Vite client build)
//   VITE_SUPABASE_ANON_KEY  (already set — public anon key, safe server-side)

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY ?? "";

// Default OG copy shown when the link isn't found or has no address data.
const DEFAULT_TITLE = "You've been sent a prepaid shipping label";
const DEFAULT_DESC =
  "Someone has set up a prepaid shipping label for you. Tap to ship your package — the cost is already covered.";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

interface LinkPayload {
  recipient_name: string | null;
  recipient_city: string | null;
  recipient_state: string | null;
}

async function fetchLinkData(shortCode: string): Promise<LinkPayload | null> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/functions/v1/links?code=${encodeURIComponent(shortCode)}`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
      }
    );
    if (!res.ok) return null;
    return (await res.json()) as LinkPayload;
  } catch {
    return null;
  }
}

function buildOgStrings(link: LinkPayload | null): { title: string; description: string } {
  if (!link?.recipient_name) return { title: DEFAULT_TITLE, description: DEFAULT_DESC };

  const firstName = link.recipient_name.split(" ")[0];
  const city = link.recipient_city;
  const state = link.recipient_state;

  const title = city && state
    ? `${firstName}'s Prepaid Label → ${city}, ${state}`
    : `${firstName}'s Prepaid Label`;

  const description = city
    ? `${link.recipient_name} has set up a prepaid shipping label to ${city}. Tap to ship your package — the cost is already covered.`
    : `${link.recipient_name} has set up a prepaid shipping label for you. Tap to ship your package — the cost is already covered.`;

  return { title, description };
}

function injectOgTags(html: string, title: string, description: string, url: string): string {
  const t = escapeHtml(title);
  const d = escapeHtml(description);
  const u = escapeHtml(url);

  const tags = [
    `<title>${t}</title>`,
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${u}" />`,
    `<meta property="og:image" content="https://sendmo.co/og-image.png" />`,
    `<meta property="og:site_name" content="SendMo" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${t}" />`,
    `<meta name="twitter:description" content="${d}" />`,
  ].join("\n    ");

  // Remove any existing <title> injected by Vite, then add ours right after <head>
  return html
    .replace(/<title>[^<]*<\/title>/i, "")
    .replace("<head>", `<head>\n    ${tags}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const shortCode = req.query.shortCode as string;

  // Determine canonical URL for og:url
  const host = req.headers.host ?? "sendmo.co";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const baseUrl = `${proto}://${host}`;
  const canonicalUrl = `${baseUrl}/s/${shortCode}`;

  // Fetch link personalisation data (best-effort — falls back to defaults)
  const link = await fetchLinkData(shortCode);
  const { title, description } = buildOgStrings(link);

  // Fetch index.html from the same deployment (CDN, not this function)
  // /index.html is a static file served by Vercel before the catch-all rewrite.
  let html: string;
  try {
    const indexRes = await fetch(`${baseUrl}/index.html`, {
      headers: { "x-sendmo-internal": "og-handler" },
    });
    if (!indexRes.ok) throw new Error(`index.html fetch ${indexRes.status}`);
    html = await indexRes.text();
  } catch {
    // If we can't get index.html, just redirect — the SPA will load without OG tags.
    res.redirect(302, `/s/${shortCode}`);
    return;
  }

  const modifiedHtml = injectOgTags(html, title, description, canonicalUrl);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Cache for 60s at the CDN; allow up to 5 min stale-while-revalidate
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  res.status(200).send(modifiedHtml);
}
