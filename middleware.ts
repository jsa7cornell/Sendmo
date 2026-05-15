// ─── Vercel Edge Middleware — OG Meta Tag Injection ────────────────────────
//
// Intercepts /s/:shortCode requests BEFORE Vercel's CDN cache so social
// crawlers (iMessage, Slack, WhatsApp, Twitter) get personalised OG tags:
//
//   "John's Prepaid Label → Portola Valley, CA"
//
// Why Edge Middleware instead of a serverless function (api/s/[shortCode].ts):
//   Vercel's CDN caches the SPA catch-all (/(.*) → index.html) at the edge,
//   so API functions are never invoked for paths that match the SPA rewrite.
//   Edge Middleware runs BEFORE the CDN cache layer and bypasses this issue.
//
// Env vars (must be set in Vercel dashboard):
//   VITE_SUPABASE_URL       — already set for the client build
//   VITE_SUPABASE_ANON_KEY  — already set for the client build

export const config = {
  matcher: "/s/:shortCode*",
};

// ─── Utilities ──────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const DEFAULT_TITLE = "You've been sent a prepaid shipping label";
const DEFAULT_DESC =
  "Someone has set up a prepaid shipping label for you. Tap to ship your package — the cost is already covered.";

interface LinkPayload {
  recipient_name: string | null;
  recipient_city: string | null;
  recipient_state: string | null;
}

function buildOgStrings(link: LinkPayload | null): { title: string; description: string } {
  if (!link?.recipient_name) return { title: DEFAULT_TITLE, description: DEFAULT_DESC };

  const firstName = link.recipient_name.split(" ")[0];
  const city = link.recipient_city;
  const state = link.recipient_state;

  const title =
    city && state
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

  return html
    .replace(/<title>[^<]*<\/title>/i, "")
    .replace("<head>", `<head>\n    ${tags}`);
}

// ─── Middleware Handler ──────────────────────────────────────

export default async function middleware(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/");
  const shortCode = parts[2]; // /s/:shortCode

  if (!shortCode) return undefined; // pass through

  const SUPABASE_URL = process.env["VITE_SUPABASE_URL"] ?? "";
  const SUPABASE_ANON_KEY = process.env["VITE_SUPABASE_ANON_KEY"] ?? "";

  // Fetch link personalisation data (best-effort)
  let link: LinkPayload | null = null;
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
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
      if (res.ok) link = (await res.json()) as LinkPayload;
    } catch {
      // Best-effort — fall through to default OG copy
    }
  }

  const { title, description } = buildOgStrings(link);

  // Fetch index.html from the same deployment
  let html: string;
  try {
    const indexRes = await fetch(`${url.origin}/index.html`, {
      headers: { "x-sendmo-internal": "og-middleware" },
    });
    if (!indexRes.ok) throw new Error(`index.html fetch ${indexRes.status}`);
    html = await indexRes.text();
  } catch {
    // Can't fetch index.html — pass through to normal SPA routing
    return undefined;
  }

  const modifiedHtml = injectOgTags(html, title, description, url.toString());

  return new Response(modifiedHtml, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Cache at the CDN for 60s; allow up to 5 min stale-while-revalidate
      "Cache-Control": "s-maxage=60, stale-while-revalidate=300",
    },
  });
}
