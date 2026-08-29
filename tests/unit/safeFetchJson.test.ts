import { describe, it, expect } from "vitest";
import { safeFetchJson } from "../../supabase/functions/_shared/easypost-rates";

// PR1: the labels buy path routes EasyPost calls through safeFetchJson so a
// thrown fetch or a non-JSON body can never escape to the outer catch (which
// used to mean: buyer charged, no refund, nobody paged).

const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("safeFetchJson", () => {
    it("passes through a successful JSON response", async () => {
        const result = await safeFetchJson("https://api.example/x", {}, () =>
            Promise.resolve(jsonResponse(200, { id: "shp_1" })));
        expect(result).toEqual({ ok: true, status: 200, data: { id: "shp_1" } });
    });

    it("passes through an error JSON response with its status", async () => {
        const result = await safeFetchJson("https://api.example/x", {}, () =>
            Promise.resolve(jsonResponse(404, { error: { code: "NOT_FOUND" } })));
        expect(result.ok).toBe(false);
        expect(result.status).toBe(404);
        expect(result.data.error.code).toBe("NOT_FOUND");
    });

    it("converts a thrown fetch into ok:false, status:null, REQUEST_THREW", async () => {
        const result = await safeFetchJson("https://api.example/x", {}, () =>
            Promise.reject(new Error("connection reset")));
        expect(result.ok).toBe(false);
        expect(result.status).toBe(null);
        expect(result.data.error.code).toBe("REQUEST_THREW");
        expect(result.data.error.message).toContain("connection reset");
    });

    it("converts a non-JSON body (CDN 502 page) into ok:false with the real status", async () => {
        const result = await safeFetchJson("https://api.example/x", {}, () =>
            Promise.resolve(new Response("<html>502 Bad Gateway</html>", { status: 502 })));
        expect(result.ok).toBe(false);
        expect(result.status).toBe(502);
        expect(result.data.error.code).toBe("NON_JSON_BODY");
    });

    it("treats a non-JSON body on an OK status as a failure too (a 200 HTML page is not a label)", async () => {
        const result = await safeFetchJson("https://api.example/x", {}, () =>
            Promise.resolve(new Response("<html>captive portal</html>", { status: 200 })));
        expect(result.ok).toBe(false);
        expect(result.status).toBe(200);
        expect(result.data.error.code).toBe("NON_JSON_BODY");
    });
});
