import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logLabelPrint } from "../../src/lib/api";

const originalFetch = globalThis.fetch;

describe("logLabelPrint", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("POSTs public_code in the body", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ actor: "anonymous", print_count: 1 }), { status: 200 })
    );
    await logLabelPrint("NEC7J3E");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const [url, init] = call;
    expect(String(url)).toContain("/functions/v1/label-print");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ public_code: "NEC7J3E" });
  });

  it("attaches Authorization header when accessToken is provided", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ actor: "link_owner", print_count: 1 }), { status: 200 })
    );
    await logLabelPrint("NEC7J3E", { accessToken: "jwt-token-123" });
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer jwt-token-123");
  });

  it("attaches X-Cancel-Token header when cancelToken is provided", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ actor: "session_token", print_count: 2 }), { status: 200 })
    );
    await logLabelPrint("NEC7J3E", { cancelToken: "abc123def456" });
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["X-Cancel-Token"]).toBe("abc123def456");
  });

  it("returns parsed JSON body on 200", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ actor: "admin", print_count: 5 }), { status: 200 })
    );
    const result = await logLabelPrint("NEC7J3E");
    expect(result).toEqual({ actor: "admin", print_count: 5 });
  });

  it("throws on non-2xx response, surfacing server error message", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Too many requests. Try again in a moment." }), { status: 429 })
    );
    await expect(logLabelPrint("NEC7J3E")).rejects.toThrow(/too many requests/i);
  });

  it("throws on 5xx with a generic fallback message", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response("internal", { status: 500 })
    );
    await expect(logLabelPrint("NEC7J3E")).rejects.toThrow(/print log failed.*500/i);
  });
});
