import { test, expect, type Page } from "@playwright/test";
import { SUPABASE_URL, SUPABASE_STORAGE_KEY } from "./supabase-env";


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

// Minimal tracking response — used after the post-payment redirect to /t/<code>.
// Per 2026-05-19_unify-confirmation-into-tracking: payment success redirects to
// /t/<public_code>?fresh=1 rather than rendering the inline LabelReady view.
const MOCK_LABEL_RESULT = {
  tracking_number: "9400111899223456789012",
  carrier: "USPS",
  service: "GroundAdvantage",
  label_url: "https://easypost.com/labels/mock-label.pdf",
  sendmo_id: "SM-TEST-001",
  public_code: "TESTUR1",
  cancel_token: "aabbccdd1122334455667788aabbccdd",
};

const MOCK_TRACKING_URL = {
  tracking_number: "9400111899223456789012",
  public_code: "TESTUR1",
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

// A mock Supabase session — used in the full-flow test so that the
// step-11 email-verify screen sees user?.email and auto-advances within
// the 1-second timer (no manual OTP entry needed).
function buildMockSession(email = "test@example.com") {
  return {
    access_token: "mock-jwt-access",
    refresh_token: "mock-refresh",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
    user: {
      id: "user-mock-id",
      email,
      user_metadata: { full_name: "Test User" },
      aud: "authenticated",
      role: "authenticated",
    },
  };
}

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
      body: JSON.stringify(MOCK_LABEL_RESULT),
    })
  );

  // Mock tracking endpoint — needed after the post-payment redirect to /t/<code>.
  await page.route(`${SUPABASE_URL}/functions/v1/tracking*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_TRACKING_URL),
    })
  );

  await page.route(`${SUPABASE_URL}/rest/v1/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    })
  );

  // Mock Supabase OTP endpoint so any email triggers a silent 200 response.
  // Required for the verify screen (step 11) to accept the typed OTP code.
  await page.route(`${SUPABASE_URL}/auth/v1/otp**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
  );
  await page.route(`${SUPABASE_URL}/auth/v1/verify**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
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
  // Phone is required by shipping carriers (added 2026-05-19). Fill it after
  // address verification so the step-1 / step-10 validation doesn't block.
  await page.locator(`#${label}-phone`).fill("4155551234");
}

test.describe("URL-based step routing", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllEdgeFunctions(page);
  });

  // ── URL changes on navigation ──────────────────────────────

  test("/onboarding resolves to /onboarding/full-label/destination (no picker)", async ({ page }) => {
    await page.goto("/onboarding");
    await expect(page).toHaveURL(/\/onboarding\/full-label\/destination$/);
  });

  test("URL updates to /onboarding/full-label/origin when advancing from destination step", async ({ page }) => {
    await page.goto("/onboarding");
    // /onboarding resolves straight to the destination step (no picker, 2026-08-18)
    await expect(page).toHaveURL(/\/full-label\/destination$/);
    await expect(page).toHaveURL(/\/onboarding\/full-label\/destination$/);

    // Fill step 1
    await page.locator("#destination-name").fill("Jane Doe");
    await fillSmartAddress(page, "destination");
    await page.locator("#recipient-email").fill("test@example.com");
    await page.getByRole("button", { name: /Continue to shipment details/i }).click();

    // One step map (2026-08-19): the ship-from step's slug is `origin`;
    // `shipping` now names the shared rates/preferences step (20).
    await expect(page).toHaveURL(/\/onboarding\/full-label\/origin$/);
  });

  test("URL updates through full flow: destination → shipping → verify → payment", async ({ page }) => {
    // Inject a mock Supabase session so the step-11 verify screen sees
    // user?.email and auto-advances (1-second timer) without manual OTP entry.
    const session = buildMockSession("test@example.com");
    await page.addInitScript(
      ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
      { key: SUPABASE_STORAGE_KEY, value: session }
    );
    // Return the session on any auth REST call so useAuth() picks it up.
    await page.route(`${SUPABASE_URL}/auth/v1/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(session),
      })
    );

    await page.goto("/onboarding");
    // /onboarding resolves straight to the destination step (no picker, 2026-08-18)
    await expect(page).toHaveURL(/\/full-label\/destination$/);

    // Step 1: destination.
    // NOTE: since a Supabase session is pre-injected, the identity pill renders
    // instead of the email input — no need to fill #recipient-email; the email
    // is auto-populated from user.email by the component.
    await expect(page).toHaveURL(/\/onboarding\/full-label\/destination$/);
    await page.locator("#destination-name").fill("Jane Doe");
    await fillSmartAddress(page, "destination");
    await page.getByRole("button", { name: /Continue to shipment details/i }).click();

    // Step 10: origin (ship-from address)
    await expect(page).toHaveURL(/\/onboarding\/full-label\/origin$/);
    await page.locator("#origin-name").fill("John Smith");
    await fillSmartAddress(page, "origin");
    await page.getByRole("button", { name: /Continue to package details/i }).click();

    // Step 14: package (parcel only — the carrier choice moved to step 20)
    await expect(page).toHaveURL(/\/onboarding\/full-label\/package$/);
    await expect(page.getByRole("textbox", { name: "L", exact: true })).toBeVisible({ timeout: 5000 });
    await page.getByRole("textbox", { name: "L", exact: true }).fill("10");
    await page.getByRole("textbox", { name: "W", exact: true }).fill("10");
    await page.getByRole("textbox", { name: "H", exact: true }).fill("10");
    await page.getByRole("textbox", { name: "lbs" }).fill("5");
    await page.getByRole("button", { name: /Continue to shipping/i }).click();

    // Step 20: shipping — rates fetch on entry; pick is auto-applied.
    await expect(page).toHaveURL(/\/onboarding\/full-label\/shipping$/);
    await expect(page.getByText("$9.20").first()).toBeVisible({ timeout: 8000 });
    await page.getByRole("button", { name: /Continue to payment/i }).click();

    // Step 11: email verify — auto-advances because session email matches.
    // URL momentarily hits /verify before jumping to /payment.
    await expect(page).toHaveURL(/\/onboarding\/full-label\/(verify|payment)$/, { timeout: 8000 });

    // Step 12: payment — wait for it (auto-advance from verify takes ~1 s)
    await expect(page).toHaveURL(/\/onboarding\/full-label\/payment$/, { timeout: 8000 });
    await expect(page.getByText("Shipment Summary")).toBeVisible({ timeout: 5000 });

    // NOTE: The post-payment redirect to /t/<code> requires completing the
    // Stripe payment form, which operates inside cross-origin iframes and
    // cannot be fully mocked in Playwright without Stripe test helper
    // integration. Testing the redirect from payment → tracking is a known
    // gap (PLAYBOOK → "E2e testing" → Known gaps). This test proves the URL
    // scheme is wired correctly through all pre-payment steps.
    // The redirect itself is covered by the "TrackingPage redirect" assertion
    // in onboarding.spec.ts once Stripe test cards are plumbed in.
  });

  // ── Browser back button ────────────────────────────────────

  test("browser back button returns to previous step with data preserved", async ({ page }) => {
    await page.goto("/onboarding");
    // /onboarding resolves straight to the destination step (no picker, 2026-08-18)
    await expect(page).toHaveURL(/\/full-label\/destination$/);

    // Fill step 1
    await page.locator("#destination-name").fill("Jane Doe");
    await fillSmartAddress(page, "destination");
    await page.locator("#recipient-email").fill("test@example.com");
    await page.getByRole("button", { name: /Continue to shipment details/i }).click();

    // Now on step 10 (slug `origin` since 2026-08-19)
    await expect(page).toHaveURL(/\/onboarding\/full-label\/origin$/);
    // Step-10 landmark. The "Origin address" heading was removed 2026-08-18 —
    // the card is now headed by the "Where's it shipping from?" fieldset legend,
    // which is the more accurate landmark for the same step.
    await expect(page.getByText(/Where's it shipping from\?/i)).toBeVisible({ timeout: 5000 });

    // Hit browser back
    await page.goBack();

    // Should be back on step 1
    await expect(page).toHaveURL(/\/onboarding\/full-label\/destination$/);
    await expect(page.getByText("Where's it going?")).toBeVisible();

    // Data should be preserved — the Verified badge should still show
    await expect(page.getByText("Verified").first()).toBeVisible({ timeout: 3000 });
  });

  test("/onboarding redirects to the destination step, replacing history", async ({ page }) => {
    // Two entries: a real page first, so Back has somewhere legitimate to go.
    await page.goto("/");
    await page.goto("/onboarding");
    await expect(page).toHaveURL(/\/onboarding\/full-label\/destination$/);

    // The redirect must REPLACE /onboarding in history: Back returns to the
    // page before it. Without replace, Back lands on /onboarding, which
    // redirects forward again — a trap where Back never escapes the flow.
    await page.goBack();
    await expect(page).not.toHaveURL(/\/onboarding/);
  });

  // ── Step guards (direct URL access) ────────────────────────

  test("direct navigation to /onboarding/full-label/shipping redirects when no steps completed", async ({ page }) => {
    // `shipping` is step 20 now (the shared rates/preferences step) — deeper
    // in the sequence, so the guard walks an unearned deep link back harder.
    await page.goto("/onboarding/full-label/shipping");
    await expect(page).not.toHaveURL(/\/onboarding\/full-label\/shipping$/);
  });

  test("direct navigation to /onboarding/full-label/payment redirects when prior steps not completed", async ({ page }) => {
    await page.goto("/onboarding/full-label/payment");
    await expect(page).not.toHaveURL(/\/onboarding\/full-label\/payment$/);
  });

  test("direct navigation to /onboarding/full-label/label redirects when prior steps not completed", async ({ page }) => {
    await page.goto("/onboarding/full-label/label");
    await expect(page).not.toHaveURL(/\/onboarding\/full-label\/label$/);
  });

  test("retired slug /onboarding/flexible/preferences resolves — redirects, never 404s", async ({ page }) => {
    // `preferences` retired when the maps unified (2026-08-19): it redirects
    // to `shipping`, then the access guard walks an unearned link back to the
    // first incomplete step. Either way the old URL keeps resolving.
    await page.goto("/onboarding/flexible/preferences");
    await expect(page).not.toHaveURL(/\/onboarding\/flexible\/preferences$/);
    await expect(page).toHaveURL(/\/onboarding/);
  });

  // ── Retired slugs on either segment ────────────────────────

  test("retired slug under the full-label segment resolves too (one map, no invalid combinations)", async ({ page }) => {
    await page.goto("/onboarding");
    // /onboarding resolves straight to the destination step (no picker, 2026-08-18)
    await expect(page).toHaveURL(/\/full-label\/destination$/);

    // Pre-2026-08-19 this combination was REJECTED (preferences was flex-only).
    // With one step map there are no cross-path combinations: the retired slug
    // canonicalizes to `shipping`, and the guard then walks the user to the
    // first incomplete step. It must never 404 or bounce to a dead end.
    await page.goto("/onboarding/full-label/preferences");
    await expect(page).not.toHaveURL(/\/onboarding\/full-label\/preferences$/);
    await expect(page).toHaveURL(/\/onboarding/);
  });
});
