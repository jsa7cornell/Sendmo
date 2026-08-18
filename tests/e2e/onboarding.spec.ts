import { test, expect, type Page } from "@playwright/test";
import { SUPABASE_URL } from "./supabase-env";


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

/** Magic Guestimator response — high confidence so no advisory note renders. */
const MOCK_GUESTIMATE = {
  itemName: "Laptop",
  packaging: "box" as const,
  length_in: 15,
  width_in: 10,
  height_in: 3,
  weight_lbs: 5,
  speedHint: "standard" as const,
  confidence: "high" as const,
  notes: "",
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

  // Mock the Magic Guestimator AI estimate
  await page.route(`${SUPABASE_URL}/functions/v1/guestimate`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_GUESTIMATE),
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

/** Drive Step 0 → Step 1 → Step 10, leaving the page on the shipment-details step. */
async function gotoStep10(page: Page) {
  await page.goto("/onboarding");
  await page.getByRole("button", { name: /Someone else/ }).click();
  await page.locator("#destination-name").fill("Jane Doe");
  await fillSmartAddress(page, "destination");
  await page.locator("#recipient-email").fill("test@example.com");
  await page.getByRole("button", { name: /Continue to shipment details/i }).click();
  await expect(page.locator("#origin-name")).toBeVisible({ timeout: 5000 });
}

test.describe("Onboarding — Full Prepaid Label flow", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllEdgeFunctions(page);
  });

  test("Step 0: asks who's sending and offers both answers", async ({ page }) => {
    await page.goto("/onboarding");

    await expect(
      page.getByRole("heading", { name: /Who's sending the package/i })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /I am/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Someone else/ })).toBeVisible();
    // Who-pays is stated once, not badged on each option.
    await expect(page.getByText(/you're the one paying for shipping/i)).toBeVisible();
  });

  test("Step 0: 'I am' starts an outbound label — the case that had no door", async ({ page }) => {
    await page.goto("/onboarding");
    await page.getByRole("button", { name: /I am/ }).click();

    // Same link_type and same first step as every other full-label flow; only
    // which party owns which address differs.
    await expect(page).toHaveURL(/\/onboarding\/full-label\/destination/);
    await expect(page.getByRole("heading", { name: /Where's it going/i })).toBeVisible();
  });

  test("'I am' survives a sessionStorage write failure", async ({ page }) => {
    // Regression: startFlowAs writes sessionStorage, and persist() swallows
    // write errors by design. When storage is unavailable the answer used to be
    // lost, sender fell back to 'other', and the user's OWN saved address would
    // be prefilled into the DESTINATION slot — the wrong-party bug the sender
    // split exists to prevent. App.tsx now also carries it in router state.
    await page.addInitScript(() => {
      const store = new Map<string, string>();
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        value: {
          getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
          setItem: () => { throw new DOMException("QuotaExceededError"); },
          removeItem: (k: string) => { store.delete(k); },
          clear: () => { store.clear(); },
          key: () => null,
          get length() { return store.size; },
        },
      });
    });

    await page.goto("/onboarding");
    await page.getByRole("button", { name: /I am/ }).click();

    // The 'self' branch must still be in force: step 1 collects the OTHER
    // party's address, so it asks "Where's it going?", not "delivered to you".
    await expect(page).toHaveURL(/\/onboarding\/full-label\/destination/);
    await expect(page.getByRole("heading", { name: /Where's it going/i })).toBeVisible();
  });

  test("a deep-linked flow (no step 0) can still undo the address escape", async ({ page }) => {
    // Regression: the escape is offered whenever sender !== 'self', but the undo
    // was gated on sender === 'other'. A user entering via a pre-existing deep
    // link — or a session persisted before the sender split shipped — has
    // sender=null, so they could convert to a shipping link with no way back.
    await page.goto("/onboarding/full-label/destination");
    await page.locator("#destination-name").fill("Jane Doe");
    await fillSmartAddress(page, "destination");
    await page.locator("#recipient-email").fill("test@example.com");
    await page.getByRole("button", { name: /Continue to shipment details/i }).click();
    await expect(page.locator("#origin-name")).toBeVisible({ timeout: 5000 });

    await page.getByRole("button", { name: /I don't have their address/i }).click();
    await expect(page).toHaveURL(/\/onboarding\/flexible\/preferences/);

    // The way back must be rendered for this user too.
    await page.getByRole("button", { name: /I do have it/i }).click();
    await expect(page).toHaveURL(/\/onboarding\/full-label\/shipping/);
  });

  test("the address escape converts to a shipping link, and undo restores what was typed", async ({
    page,
  }) => {
    await gotoStep10(page);

    // The user starts filling in the other party's address, then realises they
    // don't have it — the exact moment the link product becomes the answer.
    await page.locator("#origin-name").fill("Sarah Smith");
    await page.getByRole("button", { name: /I don't have their address/i }).click();

    // Moves to the shipping-link path. Guard must admit step 20 off the shared
    // steps 0+1 — if it doesn't, the user gets bounced to firstIncompleteUrl
    // (the 2026-05-19 navigate-vs-setData race).
    await expect(page).toHaveURL(/\/onboarding\/flexible\/preferences/);

    // The step must actually SWAP, not just the URL. An earlier cut of this
    // change left step 10 frozen mid-exit under a correct /flexible/preferences
    // URL — a URL-only assertion passed against that stale DOM. Assert the old
    // step is gone and the new one is mounted.
    await expect(page.locator("#origin-name")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: /How fast should it get there/i })
    ).toBeVisible();

    // Undo is reachable and returns the flow — with the typed origin intact,
    // because the escape never clears it.
    await page.getByRole("button", { name: /I do have it/i }).click();
    await expect(page).toHaveURL(/\/onboarding\/full-label\/shipping/);
    await expect(page.locator("#origin-name")).toHaveValue("Sarah Smith");
  });

  test("Full label flow: Step 0 → Step 1 → Step 10 → reaches email verification", async ({
    page,
  }) => {
    await page.goto("/onboarding");

    // ── Step 0: Select "Full prepaid label" ──────────────────
    await page.getByRole("button", { name: /Someone else/ }).click();

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
    // Step-10 marker: the origin name field. (The old /Ship from/i text no
    // longer exists — step 10's heading is now "Origin address".)
    await expect(page.locator("#origin-name")).toBeVisible({ timeout: 5000 });

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

    // ── Step 11: email verification ──────────────────────────
    // The full-label flow gates on a Supabase email OTP here. Driving the
    // OTP → payment → label tail end-to-end needs OTP interception, tracked
    // as a known gap (PLAYBOOK → "E2e testing" → Known gaps). This test
    // proves the flow is correctly wired Step 0 → 1 → 10 → verification.
    await expect(
      page.getByRole("heading", { name: /Confirm your email/i }),
    ).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/6-digit code/i).first()).toBeVisible();
  });

  // ── Validation gates (consolidated from the retired full-label-flow.spec) ──

  test("Step 1: an empty Continue is blocked and lists validation errors", async ({
    page,
  }) => {
    await page.goto("/onboarding");
    await page.getByRole("button", { name: /Someone else/ }).click();

    // Continue with nothing filled in.
    await page
      .getByRole("button", { name: /Continue to shipment details/i })
      .click();

    // Validation summary + specific errors render; the step does not advance.
    await expect(page.getByText("Please fix the following:")).toBeVisible();
    await expect(page.getByText("Destination address is required")).toBeVisible();
    await expect(page.getByText("Email is required")).toBeVisible();
    await expect(page.locator("#origin-name")).not.toBeVisible();
  });

  test("Step 1: an invalid email is rejected", async ({ page }) => {
    await page.goto("/onboarding");
    await page.getByRole("button", { name: /Someone else/ }).click();

    await page.locator("#recipient-email").fill("notanemail");
    await page
      .getByRole("button", { name: /Continue to shipment details/i })
      .click();

    await expect(page.getByText("Enter a valid email address")).toBeVisible();
  });

  test("Step 10: an empty Continue is blocked and lists validation errors", async ({
    page,
  }) => {
    await gotoStep10(page);

    // Continue to payment with no origin address / dimensions / weight.
    await page.getByRole("button", { name: /Continue to payment/i }).click();

    await expect(page.getByText("Please fix the following:")).toBeVisible();
    // "Origin address is required" renders both inline and in the summary list
    // — .first() is enough to prove the error surfaced.
    await expect(page.getByText("Origin address is required").first()).toBeVisible();
    await expect(page.getByText("Length is required")).toBeVisible();
  });

  test("Step 10: the Magic Guestimator auto-fills package dimensions", async ({
    page,
  }) => {
    await gotoStep10(page);

    await expect(
      page.getByRole("heading", { name: "Magic Guestimator" }),
    ).toBeVisible();

    // The Guestimator's textarea is the only multiline input on the step.
    await page.locator("textarea").fill("a laptop");
    await page.getByRole("button", { name: /I'm Feeling Lucky/i }).click();

    // Success confirmation + the L dimension populated from MOCK_GUESTIMATE.
    await expect(
      page.getByText(/Auto-filled packaging, dimensions/i),
    ).toBeVisible({ timeout: 8000 });
    await expect(
      page.getByRole("textbox", { name: "L", exact: true }),
    ).toHaveValue("15");
  });

  test("Back navigation: Step 10 → Step 1 keeps the entered data", async ({
    page,
  }) => {
    await gotoStep10(page);

    await page.getByRole("button", { name: "Back", exact: true }).click();

    // Back on Step 1, with the verified destination address still in place.
    await expect(
      page.getByRole("heading", {
        name: /Where should the package be delivered/i,
      }),
    ).toBeVisible();
    await expect(page.getByText("Verified").first()).toBeVisible();
  });
});
