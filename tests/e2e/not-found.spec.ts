import { test, expect } from "@playwright/test";

test.describe("404 page", () => {
  test("shows not found for unknown routes", async ({ page }) => {
    await page.goto("/nonexistent-path");

    await expect(
      page.getByRole("heading", { name: /NotFound/i })
    ).toBeVisible();
  });
});
