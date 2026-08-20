// @vitest-environment jsdom
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
  DEFAULT_TITLE,
  DEFAULT_DESC,
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

  it("keeps the generic copy for seller links (the buyer pays there)", () => {
    expect(buildOgStrings({ ...JOHN, link_type: "seller_link" })).toEqual({
      title: DEFAULT_TITLE,
      description: DEFAULT_DESC,
    });
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

  it("seller links still win the neutral copy even if flags are weird", () => {
    const og = buildOgStrings({
      recipient_name: "Pat", recipient_city: "Oakland", recipient_state: "CA",
      link_type: "seller_link", needs_destination: true,
    });
    expect(og.title).toBe(DEFAULT_TITLE);
  });
});
