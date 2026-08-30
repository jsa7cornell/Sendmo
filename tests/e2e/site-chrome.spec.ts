import { test, expect } from "@playwright/test";
import { seedAdminSession, profilesMockBody } from "./mock-admin-auth";

// Sitewide chrome: every signed-out page carries the header logo (clicking it
// goes home) and the shared footer. The signed-in surfaces (dashboard, links)
// are covered by the authed suite; ProtectedRoute bounces them here.
const PAGES = ["/", "/faq", "/privacy", "/terms", "/onboarding", "/login", "/no-such-page"];

for (const path of PAGES) {
  test(`${path} shows the brand mark and the footer`, async ({ page }) => {
    await page.goto(path);

    // Brand mark — the header logo everywhere, the centered logo on /login.
    const brand = page.getByRole("link", { name: /SendMo/i }).first();
    await expect(brand).toBeVisible();

    // Footer — its legal links are the tell.
    const footer = page.locator("footer");
    await expect(footer).toBeVisible();
    await expect(footer.getByRole("link", { name: "Privacy" })).toBeVisible();
    await expect(footer.getByRole("link", { name: "Terms" })).toBeVisible();
    await expect(footer.getByRole("link", { name: "Support" })).toBeVisible();
  });
}

test("the brand mark goes home from an interior page", async ({ page }) => {
  await page.goto("/terms");
  await page.getByRole("link", { name: /SendMo/i }).first().click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: /where it needs to go/i })).toBeVisible();
});

test("the footer logo goes home too", async ({ page }) => {
  await page.goto("/privacy");
  await page.locator("footer").getByRole("link").first().click();
  await expect(page).toHaveURL(/\/$/);
});

// ── Signed-in surfaces ────────────────────────────────────────────────────
// The dashboard used to be the one page with no logo and no footer — it had
// its own bespoke header instead. It now mounts the shared AppHeader (which
// owns the user menu + admin toolbar) and the shared footer.

test.describe("dashboard chrome", () => {
  test.beforeEach(async ({ page }) => {
    await seedAdminSession(page);
    await page.route("**/rest/v1/profiles*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: profilesMockBody(route.request()) }),
    );
    await page.route("**/rest/v1/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
    );
  });

  test("shows the header logo and the footer", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("link", { name: /SendMo/i }).first()).toBeVisible();
    await expect(page.locator("footer").getByRole("link", { name: "Terms" })).toBeVisible();
  });

  test("signing out lands on the homepage, not /login", async ({ page }) => {
    await page.route("**/auth/v1/logout*", (route) => route.fulfill({ status: 204, body: "" }));
    await page.goto("/dashboard");
    await page.getByRole("button", { name: /E2E Admin|e2e-admin/i }).click();
    await page.getByRole("button", { name: /Sign Out/i }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: /where it needs to go/i })).toBeVisible();
  });
});
