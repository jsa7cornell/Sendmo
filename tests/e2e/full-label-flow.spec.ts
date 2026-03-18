import { test, expect } from "@playwright/test";

// E2E test for the Full Prepaid Label recipient flow (Steps 0 → 1 → 10 → 11 → 12)
// Requires: dev server running (playwright.config.ts starts it automatically)
// Uses: Real Google Places autocomplete + real EasyPost test mode APIs

test.describe("Full Prepaid Label Flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/onboarding");
  });

  test("Step 0: renders two path choice cards", async ({ page }) => {
    await expect(page.getByText("Full prepaid label")).toBeVisible();
    await expect(page.getByText("Flexible shipping link")).toBeVisible();
    await expect(page.getByText("Recommended")).toBeVisible();
  });

  test("Step 0 → Step 1: clicking Full Label advances to address step", async ({ page }) => {
    await page.getByText("Full prepaid label").click();
    await expect(page.getByText("Where should the package be delivered?")).toBeVisible();
    await expect(page.getByPlaceholder("you@example.com")).toBeVisible();
  });

  test("Step 1: validation errors shown when Continue clicked without data", async ({ page }) => {
    await page.getByText("Full prepaid label").click();
    await page.getByText("Continue to shipment details").click();

    // Should show validation errors
    await expect(page.getByText("Please fix the following:")).toBeVisible();
    await expect(page.getByText("Destination address is required")).toBeVisible();
    await expect(page.getByText("Email is required")).toBeVisible();
  });

  test("Step 1: email validation shows error for invalid email", async ({ page }) => {
    await page.getByText("Full prepaid label").click();

    // Type an invalid email
    await page.getByPlaceholder("you@example.com").fill("notanemail");
    await page.getByText("Continue to shipment details").click();

    await expect(page.getByText("Enter a valid email address")).toBeVisible();
  });

  test("Step 1 → Step 10: advance with valid address and email", async ({ page }) => {
    await page.getByText("Full prepaid label").click();

    // Use the address autocomplete
    const addressInput = page.getByPlaceholder("Start typing your address…").first();
    await addressInput.fill("388 Townsend St San Francisco");

    // Wait for and click a prediction
    await page.waitForSelector('[class*="shadow-lg"]', { timeout: 10000 });
    await page.locator('[class*="shadow-lg"] button').first().click();

    // Wait for verified badge
    await expect(page.getByText("Verified").first()).toBeVisible({ timeout: 5000 });

    // Fill email
    await page.getByPlaceholder("you@example.com").fill("test@example.com");

    // Click continue
    await page.getByText("Continue to shipment details").click();

    // Should now be on Step 10
    await expect(page.getByText("Ship from (sender's address)")).toBeVisible({ timeout: 3000 });
    await expect(page.getByText("Magic Guestimator")).toBeVisible();
  });

  test("Step 10: Magic Guestimator fills in laptop details", async ({ page }) => {
    // Navigate to step 10
    await page.getByText("Full prepaid label").click();

    const addressInput = page.getByPlaceholder("Start typing your address…").first();
    await addressInput.fill("388 Townsend St San Francisco");
    await page.waitForSelector('[class*="shadow-lg"]', { timeout: 10000 });
    await page.locator('[class*="shadow-lg"] button').first().click();
    await expect(page.getByText("Verified").first()).toBeVisible({ timeout: 5000 });
    await page.getByPlaceholder("you@example.com").fill("test@example.com");
    await page.getByText("Continue to shipment details").click();
    await expect(page.getByText("Magic Guestimator")).toBeVisible({ timeout: 3000 });

    // Use guestimator
    await page.getByPlaceholder(/Describe what/).fill("laptop");
    await page.getByText("Guestimate it").click();

    // Should show success and fill dimensions
    await expect(page.getByText("Filled from: Laptop")).toBeVisible({ timeout: 2000 });
  });

  test("Step 10: validation errors when Continue clicked without required fields", async ({ page }) => {
    // Navigate to step 10
    await page.getByText("Full prepaid label").click();

    const addressInput = page.getByPlaceholder("Start typing your address…").first();
    await addressInput.fill("388 Townsend St San Francisco");
    await page.waitForSelector('[class*="shadow-lg"]', { timeout: 10000 });
    await page.locator('[class*="shadow-lg"] button').first().click();
    await expect(page.getByText("Verified").first()).toBeVisible({ timeout: 5000 });
    await page.getByPlaceholder("you@example.com").fill("test@example.com");
    await page.getByText("Continue to shipment details").click();
    await expect(page.getByText("Ship from")).toBeVisible({ timeout: 3000 });

    // Click continue without filling anything
    await page.getByText("Continue to payment").click();

    // Should show validation errors
    await expect(page.getByText("Ship from address is required")).toBeVisible();
    await expect(page.getByText("Length is required")).toBeVisible();
  });

  test("Progress bar shows correct state and allows back navigation", async ({ page }) => {
    // Navigate to step 1
    await page.getByText("Full prepaid label").click();

    // Progress bar should be visible with Destination active
    await expect(page.getByText("Destination")).toBeVisible();

    // Fill step 1 and advance to step 10
    const addressInput = page.getByPlaceholder("Start typing your address…").first();
    await addressInput.fill("388 Townsend St San Francisco");
    await page.waitForSelector('[class*="shadow-lg"]', { timeout: 10000 });
    await page.locator('[class*="shadow-lg"] button').first().click();
    await expect(page.getByText("Verified").first()).toBeVisible({ timeout: 5000 });
    await page.getByPlaceholder("you@example.com").fill("test@example.com");
    await page.getByText("Continue to shipment details").click();
    await expect(page.getByText("Ship from")).toBeVisible({ timeout: 3000 });

    // Click Back button
    await page.getByText("Back").click();

    // Should be back on step 1 with data preserved
    await expect(page.getByText("Where should the package be delivered?")).toBeVisible();
    await expect(page.getByText("Verified").first()).toBeVisible();
  });

  test("Mobile responsive: progress labels hidden on small viewport", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByText("Full prepaid label").click();

    // Progress labels should be hidden on mobile
    await expect(page.getByText("Destination")).not.toBeVisible();

    // But the flow should still work
    await expect(page.getByText("Where should the package be delivered?")).toBeVisible();
  });
});
