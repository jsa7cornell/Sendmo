// Unit tests for the emailed-label attachment builder
// (supabase/functions/_shared/label-attachment.ts).
//
// The contract that matters: this runs on the label-purchase path, so it must
// NEVER throw and never fail an email. Every failure mode returns null and the
// caller sends the email without the file.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildLabelAttachment } from "../../supabase/functions/_shared/label-attachment.ts";

const URL_OK = "https://example.test/label.png";

function pngResponse(bytes: Uint8Array, contentType = "image/png") {
  return new Response(bytes, { status: 200, headers: { "content-type": contentType } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildLabelAttachment", () => {
  it("returns null when there is no label url", async () => {
    expect(await buildLabelAttachment(null, "ABC1234")).toBeNull();
    expect(await buildLabelAttachment(undefined, "ABC1234")).toBeNull();
    expect(await buildLabelAttachment("", "ABC1234")).toBeNull();
  });

  it("base64-encodes the bytes and names the file by public code", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic
    vi.stubGlobal("fetch", vi.fn(async () => pngResponse(bytes)));

    const att = await buildLabelAttachment(URL_OK, "K1ZQ9FR");
    expect(att).not.toBeNull();
    expect(att!.filename).toBe("sendmo-label-K1ZQ9FR.png");
    expect(att!.content_type).toBe("image/png");
    // round-trips back to the original bytes
    expect([...atob(att!.content)].map((c) => c.charCodeAt(0))).toEqual([...bytes]);
  });

  it("picks the extension from the content type", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => pngResponse(new Uint8Array([1, 2, 3]), "application/pdf")));
    const att = await buildLabelAttachment(URL_OK, "ABC1234");
    expect(att!.filename).toBe("sendmo-label-ABC1234.pdf");
  });

  it("returns null on a non-OK response rather than attaching an error page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 404 })));
    expect(await buildLabelAttachment(URL_OK, "ABC1234")).toBeNull();
  });

  it("returns null — never throws — when the fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(buildLabelAttachment(URL_OK, "ABC1234")).resolves.toBeNull();
  });

  it("returns null on an empty body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => pngResponse(new Uint8Array([]))));
    expect(await buildLabelAttachment(URL_OK, "ABC1234")).toBeNull();
  });

  it("refuses an implausibly large file rather than blowing up the message", async () => {
    const huge = new Uint8Array(6 * 1024 * 1024);
    vi.stubGlobal("fetch", vi.fn(async () => pngResponse(huge)));
    expect(await buildLabelAttachment(URL_OK, "ABC1234")).toBeNull();
  });

  it("handles a label larger than one btoa chunk without throwing", async () => {
    // 0x8000 is the chunk size; go past it to exercise the loop.
    const bytes = new Uint8Array(0x8000 * 2 + 17).fill(65);
    vi.stubGlobal("fetch", vi.fn(async () => pngResponse(bytes)));
    const att = await buildLabelAttachment(URL_OK, "ABC1234");
    expect(att).not.toBeNull();
    expect(atob(att!.content).length).toBe(bytes.length);
  });
});
