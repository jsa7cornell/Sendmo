import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchTrackingAdmin } from "../../src/lib/api";

const originalFetch = globalThis.fetch;

describe("fetchTrackingAdmin", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("GETs /tracking-admin?code= with Bearer token", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ identifiers: { shipment_id: "abc" } }), { status: 200 })
    );
    await fetchTrackingAdmin("NEC7J3E", { accessToken: "admin-jwt" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain("/functions/v1/tracking-admin");
    expect(String(url)).toContain("code=NEC7J3E");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer admin-jwt");
  });

  it("appends refetch=easypost when opts.refetch is set", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ identifiers: { shipment_id: "abc" } }), { status: 200 })
    );
    await fetchTrackingAdmin("NEC7J3E", { accessToken: "x", refetch: "easypost" });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain("refetch=easypost");
  });

  it("throws on 403 with the server's error message", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Admin access required" }), { status: 403 })
    );
    await expect(fetchTrackingAdmin("NEC7J3E", { accessToken: "user-jwt" })).rejects.toThrow(/admin access required/i);
  });

  it("throws on 404 (shipment not found)", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Shipment not found" }), { status: 404 })
    );
    await expect(fetchTrackingAdmin("BAD_CODE", { accessToken: "admin-jwt" })).rejects.toThrow(/shipment not found/i);
  });

  it("returns the parsed payload on 200", async () => {
    const fixture = {
      identifiers: { shipment_id: "abc-123", public_code: "NEC7J3E" },
      mode: { is_test: false, is_live: true, payment_method: "comp", carrier: "USPS", service: "Ground Advantage" },
      state: { status: "cancelled", refund_status: "not_applicable" },
      transactions: [],
      event_logs: [],
    };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify(fixture), { status: 200 })
    );
    const result = await fetchTrackingAdmin("NEC7J3E", { accessToken: "admin-jwt" });
    expect(result.identifiers.shipment_id).toBe("abc-123");
    expect(result.mode.is_live).toBe(true);
  });
});
