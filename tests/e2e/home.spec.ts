import { test, expect } from "@playwright/test";

test.describe("Home page", () => {
  test("renders hero text and CTA button", async ({ page }) => {
    await page.goto("/");

    // Hero heading — the H1 is split across colored spans, so match a phrase
    // that lives in a single text node.
    await expect(
      page.getByRole("heading", { name: /where it needs to go/i })
    ).toBeVisible();

    // Primary door card + CTA. The card h2 and the button differ only in
    // casing, so scope to the button role.
    await expect(
      page.getByRole("button", { name: /Buy a shipping label/i })
    ).toBeVisible();
    await expect(
      page.getByText("Buy a shipping label that you or someone else can fill out.")
    ).toBeVisible();

    // "How SendMo works" section
    await expect(
      page.getByRole("heading", { name: /How SendMo works/i })
    ).toBeVisible();
  });

  test("the you-pay door navigates to onboarding", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Buy a shipping label/i }).click();
    await expect(page).toHaveURL(/\/onboarding/);
  });
});
