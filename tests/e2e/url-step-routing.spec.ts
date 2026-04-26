import { test, expect, type Page } from "@playwright/test";

const SUPABASE_URL = "https://fkxykvzsqdjzhurntgah.supabase.co";

// Reuse mock data from onboarding.spec.ts
const MOCK_AUTOCOMPLETE_DEST = {
  predictions: [
    {
      description: "149 New Montgomery St, San Francisco, CA 94105, USA",
      place_id: "ChIJtest456",
      main_text: "149 New Montgomery St",
      secondary_text: "San Francisco, CA 94105, USA",
    },
  ],
};

const MOCK_AUTOCOMPLETE_ORIGIN = {
  predictions: [
    {
      description: "388 Townsend St, San Francisco, CA 94107, USA",
      place_id: "ChIJtest123",
      main_text: "388 Townsend St",
      secondary_text: "San Francisco, CA 94107, USA",
    },
  ],
};

const MOCK_PLACE_DETAILS_DEST = {
  street: "149 New Montgomery St",
  city: "San Francisco",
  state: "CA",
  zip: "94105",
};

const MOCK_PLACE_DETAILS_ORIGIN = {
  street: "388 Townsend St",
  city: "San Francisco",
  state: "CA",
  zip: "94107",
};

const MOCK_RATES = {
  rates: [
    {
      carrier: "USPS",
      service: "GroundAdvantage",
      display_price: 9.2,
      delivery_days: 5,
      easypost_shipment_id: "shp_mock123",
      easypost_rate_id: "rate_mock456",
    },
  ],
};

async function mockAllEdgeFunctions(page: Page) {
  let autocompleteCallCount = 0;

  await page.route(`${SUPABASE_URL}/functions/v1/autocomplete`, (route) => {
    autocompleteCallCount++;
    const body =
      autocompleteCallCount <= 2 ? MOCK_AUTOCOMPLETE_DEST : MOCK_AUTOCOMPLETE_ORIGIN;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.route(`${SUPABASE_URL}/functions/v1/place-details`, async (route) => {
    const req = route.request();
    let placeId = "";
    try {
      const postData = req.postDataJSON();
      placeId = postData?.place_id || "";
    } catch { /* ignore */ }

    const details =
      placeId === "ChIJtest456" ? MOCK_PLACE_DETAILS_DEST : MOCK_PLACE_DETAILS_ORIGIN;

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(details),
    });
  });

  await page.route(`${SUPABASE_URL}/functions/v1/addresses`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        verified: true,
        address_type: "residential",
        is_po_box: false,
        is_military: false,
      }),
    })
  );

  await page.route(`${SUPABASE_URL}/functions/v1/rates`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_RATES),
    })
  );

  await page.route(`${SUPABASE_URL}/functions/v1/labels`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        tracking_number: "9400111899223456789012",
        carrier: "USPS",
        service: "GroundAdvantage",
        label_url: "https://easypost.com/labels/mock-label.pdf",
        sendmo_id: "SM-TEST-001",
      }),
    })
  );

  await page.route(`${SUPABASE_URL}/rest/v1/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    })
  );
}

async function fillSmartAddress(page: Page, label: string) {
  const input = page.locator(`#${label}-address`);
  await input.fill("388 Townsend");
  await expect(
    page.locator("button", { hasText: /Townsend|Montgomery/i }).first()
  ).toBeVisible({ timeout: 5000 });
  await page
    .locator("button", { hasText: /Townsend|Montgomery/i })
    .first()
    .click();
  await expect(page.getByText("Verified").nth(0)).toBeVisible({ timeout: 5000 });
}

test.describe("URL-based step routing", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllEdgeFunctions(page);
  });

  // ── URL changes on navigation ──────────────────────────────

  test("URL updates to /onboarding/address when selecting a path", async ({ page }) => {
    await page.goto("/onboarding");
    await expect(page).toHaveURL(/\/onboarding$/);

    await page.getByText("Completed Prepaid Label").click();
    await expect(page).toHaveURL(/\/onboarding\/address$/);
  });

  test("URL updates to /onboarding/shipping when advancing from address step", async ({ page }) => {
    await page.goto("/onboarding");
    await page.getByText("Completed Prepaid Label").click();
    await expect(page).toHaveURL(/\/onboarding\/address$/);

    // Fill step 1
    await page.locator("#destination-name").fill("Jane Doe");
    await fillSmartAddress(page, "destination");
    await page.locator("#recipient-email").fill("test@example.com");
    await page.getByRole("button", { name: /Continue to shipment details/i }).click();

    await expect(page).toHaveURL(/\/onboarding\/shipping$/);
  });

  test("URL updates through full flow: address → shipping → payment → label", async ({ page }) => {
    await page.goto("/onboarding");
    await page.getByText("Completed Prepaid Label").click();

    // Step 1: address
    await expect(page).toHaveURL(/\/onboarding\/address$/);
    await page.locator("#destination-name").fill("Jane Doe");
    await fillSmartAddress(page, "destination");
    await page.locator("#recipient-email").fill("test@example.com");
    await page.getByRole("button", { name: /Continue to shipment details/i }).click();

    // Step 10: shipping
    await expect(page).toHaveURL(/\/onboarding\/shipping$/);
    await page.locator("#origin-name").fill("John Smith");
    await fillSmartAddress(page, "origin");
    await page.getByRole("textbox", { name: "L", exact: true }).fill("10");
    await page.getByRole("textbox", { name: "W", exact: true }).fill("10");
    await page.getByRole("textbox", { name: "H", exact: true }).fill("10");
    await page.getByRole("textbox", { name: "lbs" }).fill("5");
    await expect(page.getByText("$9.20").first()).toBeVisible({ timeout: 8000 });
    await page.getByRole("button", { name: /Continue to payment/i }).click();

    // Step 11: payment
    await expect(page).toHaveURL(/\/onboarding\/payment$/);
    await expect(page.getByText("Shipment Summary")).toBeVisible({ timeout: 5000 });
    await page.getByRole("button", { name: /Pay.*generate label/i }).click();

    // Step 12: label ready (renders within the same payment component, URL stays at /payment)
    await expect(page).toHaveURL(/\/onboarding\/payment$/);
    await expect(page.getByText("9400111899223456789012")).toBeVisible({ timeout: 10000 });
  });

  // ── Browser back button ────────────────────────────────────

  test("browser back button returns to previous step with data preserved", async ({ page }) => {
    await page.goto("/onboarding");
    await page.getByText("Completed Prepaid Label").click();

    // Fill step 1
    await page.locator("#destination-name").fill("Jane Doe");
    await fillSmartAddress(page, "destination");
    await page.locator("#recipient-email").fill("test@example.com");
    await page.getByRole("button", { name: /Continue to shipment details/i }).click();

    // Now on step 10
    await expect(page).toHaveURL(/\/onboarding\/shipping$/);
    await expect(page.getByText(/Ship from/i)).toBeVisible({ timeout: 5000 });

    // Hit browser back
    await page.goBack();

    // Should be back on step 1
    await expect(page).toHaveURL(/\/onboarding\/address$/);
    await expect(page.getByText("Where should the package be delivered?")).toBeVisible();

    // Data should be preserved — the Verified badge should still show
    await expect(page.getByText("Verified").first()).toBeVisible({ timeout: 3000 });
  });

  test("browser back from address step returns to path choice", async ({ page }) => {
    await page.goto("/onboarding");
    await page.getByText("Completed Prepaid Label").click();
    await expect(page).toHaveURL(/\/onboarding\/address$/);

    await page.goBack();
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByText("How would you like to ship?")).toBeVisible();
  });

  // ── Step guards (direct URL access) ────────────────────────

  test("direct navigation to /onboarding/shipping redirects to /onboarding when no steps completed", async ({ page }) => {
    await page.goto("/onboarding/shipping");

    // Should redirect — either to /onboarding (no path selected) or /onboarding/address
    await expect(page).not.toHaveURL(/\/onboarding\/shipping$/);
  });

  test("direct navigation to /onboarding/payment redirects when prior steps not completed", async ({ page }) => {
    await page.goto("/onboarding/payment");
    await expect(page).not.toHaveURL(/\/onboarding\/payment$/);
  });

  test("direct navigation to /onboarding/label redirects when prior steps not completed", async ({ page }) => {
    await page.goto("/onboarding/label");
    await expect(page).not.toHaveURL(/\/onboarding\/label$/);
  });

  test("direct navigation to flex slug /onboarding/preferences redirects when no path selected", async ({ page }) => {
    await page.goto("/onboarding/preferences");
    await expect(page).not.toHaveURL(/\/onboarding\/preferences$/);
  });

  // ── Cross-path slug rejection ──────────────────────────────

  test("flex slug rejected when full_label path is active", async ({ page }) => {
    await page.goto("/onboarding");
    // Select full label path first
    await page.getByText("Completed Prepaid Label").click();
    await expect(page).toHaveURL(/\/onboarding\/address$/);

    // Try navigating to a flex-only slug
    await page.goto("/onboarding/preferences");

    // Should redirect away from preferences
    await expect(page).not.toHaveURL(/\/onboarding\/preferences$/);
  });
});
