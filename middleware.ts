// ─── Vercel Edge Middleware — OG Meta Tag Injection ────────────────────────
//
// Intercepts /s/:shortCode requests BEFORE Vercel's CDN cache so social
// crawlers (iMessage, Slack, WhatsApp, Twitter) get personalised OG tags:
//
//   "You're sending a package to John — Portola Valley, CA"
//
// Why Edge Middleware instead of a serverless function (api/s/[shortCode].ts):
//   Vercel's CDN caches the SPA catch-all (/(.*) → index.html) at the edge,
//   so API functions are never invoked for paths that match the SPA rewrite.
//   Edge Middleware runs BEFORE the CDN cache layer and bypasses this issue.
//
// The copy + HTML rewriting live in src/lib/ogMeta.ts so this file and the
// legacy serverless copy can't drift apart.
//
// Env vars (must be set in Vercel dashboard):
//   VITE_SUPABASE_URL       — already set for the client build
//   VITE_SUPABASE_ANON_KEY  — already set for the client build

import {
  buildOgStrings,
  injectOgTags,
  type OgLinkPayload,
} from "./src/lib/ogMeta";

export const config = {
  matcher: "/s/:shortCode*",
};

export default async function middleware(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/");
  const shortCode = parts[2]; // /s/:shortCode

  if (!shortCode) return undefined; // pass through

  const SUPABASE_URL = process.env["VITE_SUPABASE_URL"] ?? "";
  const SUPABASE_ANON_KEY = process.env["VITE_SUPABASE_ANON_KEY"] ?? "";

  // Fetch link personalisation data (best-effort)
  let link: OgLinkPayload | null = null;
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
      if (res.ok) link = (await res.json()) as OgLinkPayload;
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

  const modifiedHtml = injectOgTags(html, {
    title,
    description,
    url: url.toString(),
  });

  return new Response(modifiedHtml, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Cache at the CDN for 60s; allow up to 5 min stale-while-revalidate
      "Cache-Control": "s-maxage=60, stale-while-revalidate=300",
    },
  });
}
