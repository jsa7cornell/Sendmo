import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  buildOgStrings,
  injectOgTags,
  type OgLinkPayload,
} from "../../src/lib/ogMeta";

// ─── OG Meta Tag Handler for /s/:shortCode ─────────────────────────────────
//
// ⚠️ NOT the live path. Vercel's CDN serves the SPA catch-all rewrite for
// /s/:shortCode before this function is ever invoked — that's why the real
// implementation is Edge Middleware (middleware.ts at the project root). This
// file is kept as the serverless fallback and shares the same copy/injection
// module, so the two can't drift. Edit src/lib/ogMeta.ts, not this file.
//
// Supabase env vars needed in Vercel:
//   VITE_SUPABASE_URL       (already set — used by the Vite client build)
//   VITE_SUPABASE_ANON_KEY  (already set — public anon key, safe server-side)

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY ?? "";

async function fetchLinkData(shortCode: string, viewerIp?: string): Promise<OgLinkPayload | null> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/functions/v1/links?code=${encodeURIComponent(shortCode)}`,
      {
        headers: {
          // Parity with middleware.ts (PR2): per-viewer bucketing hint for
          // the links GET rate limit, so this path never pools page views
          // into one server IP if it ever goes live again.
          ...(viewerIp ? { "x-sendmo-client-ip": viewerIp } : {}),
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
      }
    );
    // 410 bodies carry {link_type, status} — a sold seller link unfurls as
    // sold, not as the prepaid fallback (parity with middleware.ts, PR3).
    if (!res.ok && res.status !== 410) return null;
    return (await res.json()) as OgLinkPayload;
  } catch {
    return null;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const shortCode = req.query.shortCode as string;

  // Determine canonical URL for og:url
  const host = req.headers.host ?? "sendmo.co";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const baseUrl = `${proto}://${host}`;
  const canonicalUrl = `${baseUrl}/s/${shortCode}`;

  // Fetch link personalisation data (best-effort — falls back to defaults)
  const viewerIp = (Array.isArray(req.headers["x-forwarded-for"])
    ? req.headers["x-forwarded-for"][0]
    : req.headers["x-forwarded-for"])?.split(",")[0]?.trim();
  const link = await fetchLinkData(shortCode, viewerIp);
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

  const modifiedHtml = injectOgTags(html, {
    title,
    description,
    url: canonicalUrl,
  });

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Cache for 60s at the CDN; allow up to 5 min stale-while-revalidate
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  res.status(200).send(modifiedHtml);
}
