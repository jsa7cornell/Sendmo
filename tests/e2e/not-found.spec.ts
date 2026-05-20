import { test, expect } from "@playwright/test";

test.describe("404 page", () => {
  test("shows the not-found page for unknown routes", async ({ page }) => {
    await page.goto("/nonexistent-path");

    await expect(
      page.getByRole("heading", { name: /Lost in transit/i }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Go home/i })).toBeVisible();
  });
});
