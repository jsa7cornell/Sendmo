import { test, expect, type Page } from "@playwright/test";

const SUPABASE_URL = "https://fkxykvzsqdjzhurntgah.supabase.co";

// Mock responses for Supabase Edge Functions
const MOCK_AUTOCOMPLETE = {
  predictions: [
    {
      description: "388 Townsend St, San Francisco, CA 94107, USA",
      place_id: "ChIJtest123",
      main_text: "388 Townsend St",
      secondary_text: "San Francisco, CA 94107, USA",
    },
  ],
};

const MOCK_PLACE_DETAILS = {
  street: "388 Townsend St",
  city: "San Francisco",
  state: "CA",
  zip: "94107",
};

const MOCK_PLACE_DETAILS_DEST = {
  street: "149 New Montgomery St",
  city: "San Francisco",
  state: "CA",
  zip: "94105",
};

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
    {
      carrier: "USPS",
      service: "Priority",
      display_price: 12.5,
      delivery_days: 2,
      easypost_shipment_id: "shp_mock123",
      easypost_rate_id: "rate_mock789",
    },
  ],
};

const MOCK_LABEL: import("../../src/lib/types").LabelResult = {
  tracking_number: "9400111899223456789012",
  carrier: "USPS",
  service: "GroundAdvantage",
  label_url: "https://easypost.com/labels/mock-label.pdf",
  sendmo_id: "SM-TEST-001",
  public_code: "TESTPC1",
  cancel_token: "aabbccdd1122334455667788aabbccdd",
};

/** Minimal tracking response shape that TrackingPage expects after the redirect. */
const MOCK_TRACKING = {
  tracking_number: "9400111899223456789012",
  public_code: "TESTPC1",
  carrier: "USPS",
  service: "GroundAdvantage",
  status: "label_created",
  estimated_delivery: null,
  events: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  promised_delivery_date: null,
  delivered_at: null,
  label_url: "https://easypost.com/labels/mock-label.pdf",
  link_short_code: "TESTSC1",
  link_status: "in_use",
  link_type: "full_label",
  viewer_is_recipient: false,
  viewerRole: "anonymous",
  recipient_first_name: null,
  refund_status: "none",
  paid: false,
  amount_paid_cents: null,
  is_test: true,
  cancelled_at: null,
  cancelled_by_actor: null,
  item_description: null,
  from_city: "San Francisco",
  from_state: "CA",
  to_city: "San Francisco",
  to_state: "CA",
  print_count: 0,
  last_printed_at: null,
};

/**
 * Set up route interception for all Supabase Edge Function calls.
 * We track autocomplete call count to serve destination vs origin responses.
 */
async function mockAllEdgeFunctions(page: Page) {
  let autocompleteCallCount = 0;

  // Mock autocomplete — first call is for destination (step 1), second for origin (step 10)
  await page.route(`${SUPABASE_URL}/functions/v1/autocomplete`, (route) => {
    autocompleteCallCount++;
    // After the destination step, reset so origin calls get the right mock
    const body =
      autocompleteCallCount <= 2 ? MOCK_AUTOCOMPLETE_DEST : MOCK_AUTOCOMPLETE;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  // Mock place-details — serve based on place_id
  await page.route(`${SUPABASE_URL}/functions/v1/place-details`, async (route) => {
    const req = route.request();
    let placeId = "";
    try {
      const postData = req.postDataJSON();
      placeId = postData?.place_id || "";
    } catch { /* ignore */ }

    const details =
      placeId === "ChIJtest456" ? MOCK_PLACE_DETAILS_DEST : MOCK_PLACE_DETAILS;

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(details),
    });
  });

  // Mock address verification
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

  // Mock rates
  await page.route(`${SUPABASE_URL}/functions/v1/rates`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_RATES),
    })
  );

  // Mock label purchase
  await page.route(`${SUPABASE_URL}/functions/v1/labels`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_LABEL),
    })
  );

  // Mock tracking endpoint — TrackingPage calls this after the post-payment redirect.
  // Route is keyed by public_code from MOCK_LABEL so the redirect lands correctly.
  await page.route(`${SUPABASE_URL}/functions/v1/tracking*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_TRACKING),
    })
  );

  // Mock Supabase REST API calls (profile checks, etc.)
  await page.route(`${SUPABASE_URL}/rest/v1/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    })
  );
}

/**
 * Helper: type into a SmartAddressInput and select the first autocomplete result
 */
async function fillSmartAddress(page: Page, label: string) {
  const input = page.locator(`#${label}-address`);
  await input.fill("388 Townsend");
  // Wait for the autocomplete dropdown to appear
  await expect(
    page.locator("button", { hasText: /Townsend|Montgomery/i }).first()
  ).toBeVisible({ timeout: 5000 });
  // Click the first result
  await page
    .locator("button", { hasText: /Townsend|Montgomery/i })
    .first()
    .click();
  // Wait for the "Verified" badge to appear
  await expect(page.getByText("Verified").nth(0)).toBeVisible({ timeout: 5000 });
  // Phone is required (2026-05-19 — FedEx/UPS PHONENUMBEREMPTY fix). Fill it
  // so form validation doesn't block the Continue button.
  await page.locator(`#${label}-phone`).fill("4155550100");
}

test.describe("Onboarding — Full Prepaid Label flow", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllEdgeFunctions(page);
  });

  test("Step 0: path choice renders both options", async ({ page }) => {
    await page.goto("/onboarding");

    await expect(
      page.getByRole("heading", { name: /How should we set up your prepaid shipment/i })
    ).toBeVisible();
    await expect(page.getByText("Completed Prepaid Label")).toBeVisible();
    await expect(page.getByText("Flexible Prepaid Shipping Link")).toBeVisible();
  });

  test("Full label flow: Step 0 → Step 1 → Step 10 → Step 11 → label ready", async ({
    page,
  }) => {
    await page.goto("/onboarding");

    // ── Step 0: Select "Full prepaid label" ──────────────────
    await page.getByText("Completed Prepaid Label").click();

    // ── Step 1: Address + Email ──────────────────────────────
    await expect(
      page.getByRole("heading", {
        name: /Where should the package be delivered/i,
      })
    ).toBeVisible();

    // Fill the name field for destination
    await page.locator("#destination-name").fill("Jane Doe");

    // Fill destination address using SmartAddressInput
    await fillSmartAddress(page, "destination");

    // Fill email
    await page.locator("#recipient-email").fill("test@example.com");

    // Click continue
    await page
      .getByRole("button", { name: /Continue to shipment details/i })
      .click();

    // ── Step 10: Full Shipping Details ───────────────────────
    await expect(
      page.getByText(/Ship from/i)
    ).toBeVisible({ timeout: 5000 });

    // Fill origin name
    await page.locator("#origin-name").fill("John Smith");

    // Fill origin address
    await fillSmartAddress(page, "origin");

    // Dimensions — L, W, H (use exact role matching to avoid ambiguity)
    await page.getByRole("textbox", { name: "L", exact: true }).fill("10");
    await page.getByRole("textbox", { name: "W", exact: true }).fill("10");
    await page.getByRole("textbox", { name: "H", exact: true }).fill("10");

    // Weight
    await page.getByRole("textbox", { name: "lbs" }).fill("5");

    // Wait for rates to load (debounced 600ms + mock response)
    await expect(
      page.getByText(/USPS/i).first()
    ).toBeVisible({ timeout: 8000 });

    // A rate card should be visible with a price
    await expect(page.getByText("$9.20").first()).toBeVisible();

    // Click continue to payment
    await page
      .getByRole("button", { name: /Continue to payment/i })
      .click();

    // ── Step 11: Payment ─────────────────────────────────────
    await expect(page.getByText("Shipment Summary")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByText("Test Mode", { exact: true })).toBeVisible();

    // Click pay & generate label
    await page
      .getByRole("button", { name: /Pay.*generate label/i })
      .click();

    // ── Step 12: TrackingPage redirect ─────────────────────
    // After payment succeeds, the app navigates to /t/<public_code>?fresh=1.
    // TrackingPage strips ?fresh=1 on first paint (setSearchParams replace:true),
    // so the URL settles at /t/TESTPC1.
    await expect(page).toHaveURL(/\/t\/[A-Z0-9]+/, { timeout: 10000 });

    // Pre-drop-off state hero — headline contains "ready to print"
    await expect(page.getByText(/ready to print/i)).toBeVisible({ timeout: 10000 });

    // Print button (formerly "View Label" — renamed per proposal)
    await expect(
      page.getByRole("button", { name: /Print/i })
        .or(page.getByRole("link", { name: /Print/i }))
    ).toBeVisible();

    // Download button
    await expect(
      page.getByRole("button", { name: /Download/i })
        .or(page.getByRole("link", { name: /Download/i }))
    ).toBeVisible();

    // "How to ship" heading from HowToShipStrip
    await expect(page.getByText(/how to ship/i)).toBeVisible();

    // ETA banner is conditional on promised_delivery_date — not asserted here
    // because MOCK_TRACKING has promised_delivery_date: null (banner hides itself).
  });
});
