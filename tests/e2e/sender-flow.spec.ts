import { test, expect, type Page } from "@playwright/test";

// E2E tests for the sender flow at /s/:shortCode
//
// Covers:
//   - Unknown/invalid short code → error state
//   - Valid link → intro step renders (not the "broken link" error)
//
// The SENDMO_TEST_LINK_CODE env var should be a real active flex link
// with a complete address in the DB. Set it in .env.local or CI secrets.
// If unset, the "valid link loads" tests are skipped.

const SUPABASE_URL = "https://fkxykvzsqdjzhurntgah.supabase.co";
const TEST_CODE = process.env.SENDMO_TEST_LINK_CODE ?? "";

// ─── Any link code — error handling ─────────────────────────

test.describe("sender flow — invalid / unknown links", () => {
  // SenderFlow.fetchLink() calls GET /functions/v1/links?code=… — mock it to
  // a 404 so the unknown-code path is deterministic and offline.
  test.beforeEach(async ({ page }: { page: Page }) => {
    await page.route(`${SUPABASE_URL}/functions/v1/links*`, (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "Link not found" }),
      }),
    );
    await page.route(`${SUPABASE_URL}/rest/v1/**`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
    );
    await page.route(`${SUPABASE_URL}/auth/v1/**`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );
  });

  test("unknown short code shows a friendly error, not a crash", async ({ page }) => {
    await page.goto("/s/ZZZZ_DOES_NOT_EXIST_AT_ALL");

    // Error heading — target the h2 specifically. A broad text regex would be
    // a strict-mode violation (it also matches the error-detail paragraph).
    await expect(
      page.getByRole("heading", { name: /didn't work/i }),
    ).toBeVisible({ timeout: 10000 });

    // Should NOT show the sender wizard intro
    await expect(page.getByText(/who's sending/i)).not.toBeVisible();
  });

  test("error screen has a 'Back to SendMo' escape hatch", async ({ page }) => {
    await page.goto("/s/ZZZZ_DOES_NOT_EXIST_AT_ALL");
    await expect(page.getByRole("link", { name: /back to sendmo/i })
      .or(page.getByRole("button", { name: /back to sendmo/i }))).toBeVisible({ timeout: 10000 });
  });
});

// ─── Valid link — regression guard ──────────────────────────
//
// This is the test that would have caught the 2026-05-15 regression:
// recipient_address_complete was always false (because street1 was missing
// from the Supabase SELECT), so every valid link showed the "incomplete
// address" error screen instead of the sender wizard.

const testWithCode = TEST_CODE ? test : test.skip;

test.describe("sender flow — valid link with complete address", () => {
  testWithCode(
    "loads the sender intro step — NOT the address-incomplete error",
    async ({ page }) => {
      await page.goto(`/s/${TEST_CODE}`);

      // Must NOT show the incomplete-address error we introduced
      await expect(
        page.getByText(/delivery address is incomplete/i)
      ).not.toBeVisible({ timeout: 10000 });

      // Must NOT show a generic broken-link error
      await expect(
        page.getByText(/didn't work|not found|no longer active/i)
      ).not.toBeVisible();

      // Should show the sender wizard (intro step heading or package step)
      await expect(
        page.getByText(/who's sending|what are you shipping|shipping to/i)
      ).toBeVisible({ timeout: 10000 });
    }
  );

  testWithCode(
    "page title / OG meta reflects personalised link data",
    async ({ page }) => {
      await page.goto(`/s/${TEST_CODE}`);

      // The OG meta tag (injected by api/s/[shortCode].ts) should contain
      // something other than the generic fallback title
      const ogTitle = await page
        .locator('meta[property="og:title"]')
        .getAttribute("content");

      // Should NOT be the generic fallback
      expect(ogTitle).not.toContain("You've been sent a prepaid shipping label");

      // Should include either a name or a city
      expect(ogTitle?.length).toBeGreaterThan(10);
    }
  );
});
