import { test, expect } from "@playwright/test";
import { SUPABASE_URL } from "./supabase-env";

// Phase 0 of the session-durability diagnosis: every page load must emit one
// auth.breadcrumb heartbeat to the ingest Edge Function (INITIAL_SESSION,
// throttled to once per day — a fresh browser context always qualifies), and
// the local ring buffer + marker cookie must be written. If this spec breaks,
// the daily-logout diagnosis is flying blind again.

test.describe("auth breadcrumbs", () => {
  test("app load emits the daily heartbeat to ingest and writes the local channels", async ({
    page,
  }) => {
    let ingestBody: Record<string, unknown> | null = null;
    await page.route(`${SUPABASE_URL}/functions/v1/ingest`, async (route) => {
      ingestBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, json: { ok: true } });
    });

    // Server sends are gated to the prod origin so ordinary specs and dev
    // servers can't pollute prod event_logs; this spec opts in via the force
    // key and mocks ingest above.
    await page.addInitScript(() => window.localStorage.setItem("sendmo-diag-send", "1"));
    await page.goto("/login");

    await expect.poll(() => ingestBody, { timeout: 10_000 }).not.toBeNull();
    expect(ingestBody!.event_type).toBe("auth.breadcrumb");
    expect(ingestBody!.source).toBe("frontend");
    expect((ingestBody!.properties as { event: string }).event).toBe("INITIAL_SESSION");

    const localChannels = await page.evaluate(() => ({
      crumbs: JSON.parse(window.localStorage.getItem("sendmo-auth-breadcrumbs") ?? "[]"),
      cookie: document.cookie.includes("sm_bc="),
    }));
    expect(localChannels.crumbs.length).toBeGreaterThan(0);
    expect(localChannels.cookie).toBe(true);
  });
});
