// Unit tests for the link-preview (Open Graph) copy + injection helpers.
//
// The regression these lock down: index.html ships its own generic og:* tags,
// and the middleware used to append personalised ones without removing them.
// Crawlers saw two og:title values and unfurled the generic SendMo card — the
// bug John reported from WhatsApp on 2026-08-10. The "exactly one" assertions
// below read the real index.html, so adding another static og tag to it
// without teaching ogMeta.ts to strip it turns this suite red.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildOgStrings,
  injectOgTags,
  sanitizeItemLabel,
  DEFAULT_TITLE,
  DEFAULT_DESC,
  SELLER_TITLE,
  SELLER_DESC,
} from "@/lib/ogMeta";
import { titleCaseName, displayName } from "@/lib/name";

// vitest runs with cwd at the project root (jsdom makes import.meta.url an
// http: URL, so resolve from cwd instead).
const INDEX_HTML = readFileSync(resolve(process.cwd(), "index.html"), "utf-8");

const JOHN = {
  recipient_name: "john anderson",
  recipient_city: "Portola Valley",
  recipient_state: "CA",
};

function countMatches(html: string, re: RegExp): number {
  return html.match(re)?.length ?? 0;
}

describe("titleCaseName", () => {
  it("capitalises casually typed names", () => {
    expect(titleCaseName("john anderson")).toBe("John Anderson");
    expect(titleCaseName("  jane  ")).toBe("Jane");
  });

  it("leaves deliberate casing alone", () => {
    expect(titleCaseName("Ann McDonald")).toBe("Ann McDonald");
    expect(titleCaseName("Paul DeLuca")).toBe("Paul DeLuca");
    expect(titleCaseName("JAY")).toBe("JAY");
  });

  it("handles hyphens and apostrophes", () => {
    expect(titleCaseName("mary-jane o'brien")).toBe("Mary-Jane O'Brien");
  });
});

describe("displayName", () => {
  it("returns null for empty/missing values so callers can fall back", () => {
    expect(displayName(null)).toBeNull();
    expect(displayName(undefined)).toBeNull();
    expect(displayName("   ")).toBeNull();
  });

  it("trims and capitalises", () => {
    expect(displayName("  john anderson ")).toBe("John Anderson");
  });
});

describe("buildOgStrings", () => {
  it("puts the first name and destination in the title", () => {
    const { title } = buildOgStrings(JOHN);
    expect(title).toBe("You're sending a package to John — Portola Valley, CA");
  });

  it("puts the full name and the reassurance in the description", () => {
    const { description } = buildOgStrings(JOHN);
    expect(description).toContain("John Anderson already paid the postage");
  });

  it("drops the destination when city/state are missing", () => {
    const { title } = buildOgStrings({
      ...JOHN,
      recipient_city: null,
      recipient_state: null,
    });
    expect(title).toBe("You're sending a package to John");
  });

  it("falls back to the destination alone when there is no name", () => {
    const { title } = buildOgStrings({ ...JOHN, recipient_name: null });
    expect(title).toBe("You're sending a package to Portola Valley, CA");
  });

  it("uses the generic copy with no link data", () => {
    expect(buildOgStrings(null)).toEqual({
      title: DEFAULT_TITLE,
      description: DEFAULT_DESC,
    });
  });

  // Seller links (PR3, seller-link launch): the BUYER pays, so the card must
  // say so — the old "cost is already covered" fallback was a lie on the
  // first thing every Marketplace buyer reads.
  it("tells the truth on a seller link: buyer-pays copy, never the prepaid fallback", () => {
    const og = buildOgStrings({ ...JOHN, link_type: "seller_link" });
    expect(og).toEqual({ title: SELLER_TITLE, description: SELLER_DESC });
    expect(og.description).not.toMatch(/already covered|already paid/i);
  });

  it("names the item on a seller link when the seller wrote one (typographic quotes — inch-marks are common in listings)", () => {
    const og = buildOgStrings({ ...JOHN, link_type: "seller_link", notes: `12" vinyl record` });
    expect(og.title).toBe(`Get “12" vinyl record” shipped to you`);
    expect(og.description).toBe(SELLER_DESC);
  });

  it("a SOLD seller link unfurls as sold, never as any pays-copy (the 410 body carries status)", () => {
    const og = buildOgStrings({ ...JOHN, link_type: "seller_link", status: "in_use", notes: "Couch" });
    expect(og.title).toBe("This item has already sold");
    expect(og.description).not.toMatch(/pay|covered|shipped to you/i);
  });

  it("sanitizes seller item text for the branded card: URLs stripped, length capped, surrogate-safe", () => {
    expect(sanitizeItemLabel("Check https://scam.example/x my   couch")).toBe("Check my couch");
    expect(sanitizeItemLabel("visit www.totally-legit.biz now")).toBe("visit now");
    expect(sanitizeItemLabel("  ")).toBe(null);
    expect(sanitizeItemLabel("https://only-a-url.example")).toBe(null);
    const long = "a".repeat(80);
    expect(sanitizeItemLabel(long)).toHaveLength(60);
    expect(sanitizeItemLabel(long)!.endsWith("…")).toBe(true);
    // Emoji straddling the cut must never yield a lone surrogate (U+FFFD on the card).
    const emojiHeavy = "🛋️".repeat(40);
    const cut = sanitizeItemLabel(emojiHeavy)!;
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).not.toContain("�");
    for (let i = 0; i < cut.length; i++) {
      const c = cut.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = cut.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
      }
    }
  });
});

describe("injectOgTags", () => {
  const { title, description } = buildOgStrings(JOHN);
  const out = injectOgTags(INDEX_HTML, {
    title,
    description,
    url: "https://sendmo.co/s/C4hLV3uFub",
  });

  it("leaves exactly one of each preview tag", () => {
    expect(countMatches(out, /<title>/gi)).toBe(1);
    expect(countMatches(out, /property="og:title"/gi)).toBe(1);
    expect(countMatches(out, /property="og:description"/gi)).toBe(1);
    expect(countMatches(out, /property="og:image"/gi)).toBe(1);
    expect(countMatches(out, /property="og:url"/gi)).toBe(1);
    expect(countMatches(out, /name="twitter:card"/gi)).toBe(1);
    expect(countMatches(out, /name="description"/gi)).toBe(1);
  });

  it("the surviving tags are the personalised ones", () => {
    expect(out).toContain(`<title>${title}</title>`);
    expect(out).toContain(`content="${title}"`);
    expect(out).toContain('content="https://sendmo.co/s/C4hLV3uFub"');
    expect(out).not.toContain("SendMo — Prepaid Shipping Made Easy");
    expect(out).not.toContain('content="https://sendmo.co/" />');
  });

  it("keeps a large-image card so the preview stays visual", () => {
    expect(out).toContain('name="twitter:card" content="summary_large_image"');
    expect(out).toContain('property="og:image:width" content="1200"');
  });

  it("does not disturb the rest of the document", () => {
    expect(out).toContain('<div id="root"></div>');
    expect(out).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(out).toContain('<meta name="theme-color" content="#1681E5" />');
    expect(countMatches(out, /<head>/gi)).toBe(1);
  });

  it("escapes quotes and angle brackets in link data", () => {
    const evil = injectOgTags(INDEX_HTML, {
      title: 'Jo"n <script>alert(1)</script>',
      description: "d & d",
      url: "https://sendmo.co/s/x",
    });
    expect(evil).not.toContain("<script>alert(1)</script>");
    expect(evil).toContain("&quot;n &lt;script&gt;");
    expect(evil).toContain("d &amp; d");
  });
});

describe("destination-deferred links (Phase 3)", () => {
  it("names the shape instead of promising a destination that doesn't exist", () => {
    const og = buildOgStrings({
      recipient_name: null, recipient_city: null, recipient_state: null,
      link_type: "flexible", needs_destination: true,
    });
    expect(og.title).toMatch(/prepaid shipping/i);
    expect(og.description).toMatch(/you choose where it goes/i);
  });

  it("seller links still win the seller copy even if flags are weird", () => {
    const og = buildOgStrings({
      recipient_name: "Pat", recipient_city: "Oakland", recipient_state: "CA",
      link_type: "seller_link", needs_destination: true,
    });
    expect(og.title).toBe(SELLER_TITLE);
    expect(og.title).not.toBe(DEFAULT_TITLE);
  });
});
