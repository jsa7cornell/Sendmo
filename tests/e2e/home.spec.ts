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

    // Primary door. Named for the job, not the artifact — and it no longer
    // excludes the plain "I'm mailing something out" case.
    await expect(
      page.getByRole("button", { name: /Send or receive a package/i })
    ).toBeVisible();
    await expect(page.getByText("You pay for shipping")).toBeVisible();

    // "How SendMo works" section
    await expect(
      page.getByRole("heading", { name: /How SendMo works/i })
    ).toBeVisible();
  });

  test("the you-pay door navigates to onboarding", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Send or receive a package/i }).click();
    await expect(page).toHaveURL(/\/onboarding/);
  });
});
