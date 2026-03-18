import { test, expect } from "@playwright/test";

test.describe("Admin page", () => {
  test.beforeEach(async ({ page }) => {
    // Mock the admin-report Edge Function so the page renders without real data
    await page.route("**/functions/v1/admin-report**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [] }),
      })
    );
  });

  test("shows PIN gate before auth", async ({ page }) => {
    await page.goto("/admin");

    await expect(
      page.getByRole("heading", { name: /Admin Access/i })
    ).toBeVisible();
    await expect(page.getByPlaceholder("••••")).toBeVisible();
  });

  test("wrong PIN shows error", async ({ page }) => {
    await page.goto("/admin");

    await page.getByPlaceholder("••••").fill("0000");
    await page.getByRole("button", { name: /Enter/i }).click();
    await expect(page.getByText("Incorrect PIN")).toBeVisible();
  });

  test("correct PIN shows reporting page", async ({ page }) => {
    await page.goto("/admin");

    await page.getByPlaceholder("••••").fill("2026");
    await page.getByRole("button", { name: /Enter/i }).click();

    // Should show the admin reporting header
    await expect(
      page.getByRole("heading", { name: /Admin \/ Reporting/i })
    ).toBeVisible();
  });
});
