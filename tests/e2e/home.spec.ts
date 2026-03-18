import { test, expect } from "@playwright/test";

test.describe("Home page", () => {
  test("renders hero text and CTA button", async ({ page }) => {
    await page.goto("/");

    // Hero heading
    await expect(
      page.getByRole("heading", { name: /Create a shipping label/i })
    ).toBeVisible();

    // Tagline pill (appears in hero pill and footer — use first)
    await expect(page.getByText("Prepaid shipping made easy").first()).toBeVisible();

    // Primary CTA
    const cta = page.getByRole("button", { name: /Get started/i });
    await expect(cta).toBeVisible();

    // "How SendMo works" section
    await expect(
      page.getByRole("heading", { name: /How SendMo works/i })
    ).toBeVisible();
  });

  test("CTA navigates to onboarding", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Get started/i }).click();
    await expect(page).toHaveURL(/\/onboarding/);
  });
});
