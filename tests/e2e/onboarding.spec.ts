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

  // Supabase OTP. Needed since 2026-08-22: sending the code is an explicit
  // button press on the Contact step whose failure is SHOWN, so an unmocked
  // call means the suite races the real endpoint's 60s rate limit and the step
  // never advances. The old on-blur priming swallowed every error, which is
  // exactly why nobody noticed the endpoint was live in these tests.
  await page.route(`${SUPABASE_URL}/auth/v1/otp**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );

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

/** Advance from step 10 (ship-from address) to step 14 (package + carrier). */
async function gotoPackageStep(page: Page) {
  await page.locator("#origin-name").fill("John Smith");
  await fillSmartAddress(page, "origin");
  await page.getByRole("button", { name: /^Continue$/ }).click();
}

/** Drive Step 0 → Step 1 → Step 10, leaving the page on the ship-from address step. */
async function gotoStep10(page: Page) {
  await page.goto("/onboarding");
  // /onboarding resolves straight to the destination step (no picker, 2026-08-18)
  await expect(page).toHaveURL(/\/full-label\/destination$/);
  await page.locator("#destination-name").fill("Jane Doe");
  await fillSmartAddress(page, "destination");
  await page.getByRole("button", { name: /^Continue$/ }).click();
  await expect(page.locator("#origin-name")).toBeVisible({ timeout: 5000 });
}

test.describe("Onboarding — Full Prepaid Label flow", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllEdgeFunctions(page);
  });

  test("/onboarding is the destination step — the who's-sending picker is gone", async ({ page }) => {
    await page.goto("/onboarding");

    // 2026-08-18 (unified-onboarding Phase 2): no picker. The flow itself
    // resolves who's sending — via the "use my address" chips, or by
    // deferring. Entry lands straight on the first real question.
    await expect(page).toHaveURL(/\/onboarding\/full-label\/destination$/);
    // Neutral heading: with sender unresolved, the copy must be true
    // whichever party the account holder turns out to be.
    await expect(page.getByRole("heading", { name: /Where's it going/i })).toBeVisible();
  });

  test("a finished draft is cleared at entry — never silently rehydrated", async ({ page }) => {
    // Review finding 1 (2026-08-18): a finished/expired draft is not offerable
    // (loadResumable → null) but WAS still hydrated by the provider after the
    // redirect — last shipment's addresses prefilling a "new" flow. Entry must
    // clear what it will not offer.
    await page.addInitScript(() => {
      localStorage.setItem("sendmo:recipient_flow:v1", JSON.stringify({
        savedAt: Date.now(),
        data: {
          sender: "other", path: "full_label", completedSteps: [1, 10, 14],
          short_code: "OLD123", // finished → not offerable
          email: "old@example.com",
          destinationAddress: {
            name: "Old Friend", street: "9 Stale St", city: "San Francisco",
            state: "CA", zip: "94107", phone: "4155550100", verified: true,
          },
        },
      }));
    });

    await page.goto("/onboarding");
    await expect(page).toHaveURL(/\/full-label\/destination$/);
    // No resume banner, and a genuinely blank flow.
    await expect(page.getByText(/shipment in progress/i)).toHaveCount(0);
    await expect(page.locator("#destination-name")).toHaveValue("");
    await expect(page.locator("#destination-phone")).toHaveValue("");
  });

  test("deferring the DESTINATION advances on the click and reaches the link path", async ({ page }) => {
    // Phase 3, decision B: every question is skippable. Since 2026-08-22 the
    // destination is the ONLY question on step 1 — the email moved to the
    // Contact step — so skipping it is a complete answer and advances at once,
    // exactly like the origin and package skips.
    await page.goto("/onboarding");
    await page.getByRole("button", { name: /Sender will fill this in/i }).click();
    // First skip rewrites the segment (§2.2, 2026-08-19): the flow heads to a
    // link now, and the URL says so from the very next navigation. No Continue
    // press in between.
    await expect(page).toHaveURL(/\/flexible\/origin$/);
    // 2026-08-23: the banner that used to announce this is gone with the
    // progress bar and the path chip. The URL segment carries it until the
    // payment step's Shipment Details card names it in full.
    await expect(page.getByText(/This will be a shipping link, not a label/i)).toHaveCount(0);
  });

  test("deferring resolves the sender and asks the next question", async ({ page }) => {
    await gotoStep10(page);

    // Skip the origin. The first skip rewrites the segment to flexible (§2.2),
    // and the next question — the package — is still asked.
    await page.getByRole("button", { name: /Sender will fill this in/i }).click();
    await expect(page.locator("#origin-name")).toHaveCount(0);
    await expect(page).toHaveURL(/\/flexible\/package$/);

    // No banner and no all-at-once undo since 2026-08-23. Taking the question
    // back is per-question: walk back to it and press "Enter it myself".
    await expect(page.getByRole("button", { name: /Undo skip/i })).toHaveCount(0);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page).toHaveURL(/\/origin$/);
    await page.getByRole("button", { name: /Enter it myself/i }).click();
    await expect(page.getByRole("button", { name: /Sender will fill this in/i })).toBeVisible();
  });

  test("the shipping link is a named, visible choice — not an escape from a failed form", async ({ page }) => {
    await gotoStep10(page);

    // The regression this fixes was the link existing only as muted help-text
    // called "I don't have their address", below a form the user can't
    // complete. It is now a first-class action on the question's own row.
    //
    // 2026-08-22: the two-button radiogroup that carried this property became
    // one link. "Neither option pre-selected" is gone with it — there is no
    // second option to pre-select — but the property it protected survives
    // intact and is asserted below: the label path gains no clicks.
    const skipLink = page.getByRole("button", { name: /Sender will fill this in/i });
    await expect(skipLink).toBeVisible();

    // The label path is NOT taxed for the link's prominence: the origin form
    // is open and typeable on arrival, so the path that has produced every
    // shipment to date costs nothing extra (brief point 9).
    await expect(page.locator("#origin-name")).toBeVisible();
    await expect(page.locator("#origin-name")).toBeEditable();

    // 2026-08-23: taking the link no longer NAMES it mid-flow. The banner that
    // said "This will be a shipping link" went with the progress bar and the
    // path chip; the URL segment is the only mid-flow signal, and the product
    // is named on the payment step by the Shipment Details card. Recorded as a
    // deliberate narrowing so a later reader does not treat it as drift — the
    // 2026-08-18 property was "named before the user can fail", and what
    // survives is "named before the user pays".
    await skipLink.click();
    await expect(page).toHaveURL(/\/flexible\/package$/);
    await expect(page.getByText(/This will be a shipping link/i)).toHaveCount(0);
  });

  test("a deep-linked flow (no step 0) can still undo the address escape", async ({ page }) => {
    // Regression: the escape is offered whenever sender !== 'self', but the undo
    // was gated on sender === 'other'. A user entering via a pre-existing deep
    // link — or a session persisted before the sender split shipped — has
    // sender=null, so they could convert to a shipping link with no way back.
    await page.goto("/onboarding/full-label/destination");
    await page.locator("#destination-name").fill("Jane Doe");
    await fillSmartAddress(page, "destination");
    await page.getByRole("button", { name: /^Continue$/ }).click();
    await expect(page.locator("#origin-name")).toBeVisible({ timeout: 5000 });

    await page.getByRole("button", { name: /Sender will fill this in/i }).click();
    // Deferring the address advances to the PACKAGE question — it must not
    // skip it (that was the 2026-08-18 bug) — on the flexible segment, which
    // the first skip rewrites (§2.2).
    await expect(page).toHaveURL(/\/onboarding\/flexible\/package/);
    // Wait for the step to actually MOUNT before clicking again. The URL flips
    // before the outgoing step unmounts, so clicking on the URL alone re-hits
    // the address step's button and silently re-runs the same defer.
    await expect(page.locator("#origin-name")).toHaveCount(0);
    await page.getByRole("button", { name: /Sender will fill this in/i }).click();
    await expect(page).toHaveURL(/\/onboarding\/flexible\/shipping/);

    // The way back must be rendered for this user too — Back walks a step at
    // a time now that the banner's all-at-once undo is gone.
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page).toHaveURL(/\/onboarding\/flexible\/package/);
    await expect(page.getByRole("button", { name: /Enter it myself/i })).toBeVisible();
  });

  test("the address escape converts to a shipping link, and undo restores what was typed", async ({
    page,
  }) => {
    await gotoStep10(page);

    // The user starts filling in the other party's address, then realises they
    // don't have it — the exact moment the link product becomes the answer.
    await page.locator("#origin-name").fill("Sarah Smith");
    await page.getByRole("button", { name: /Sender will fill this in/i }).click();

    // The package question is still asked — deferring the address no longer
    // leaps past it. Defer that too and the flow becomes a shipping link.
    await expect(page).toHaveURL(/\/onboarding\/flexible\/package/);
    await expect(page.locator("#origin-name")).toHaveCount(0);
    await page.getByRole("button", { name: /Sender will fill this in/i }).click();

    // Lands on the shared shipping step in flex mode. The guard must admit
    // step 20 — deferring marked 10 and 14 complete — or the user gets
    // bounced to firstIncompleteUrl (the 2026-05-19 navigate-vs-setData race).
    await expect(page).toHaveURL(/\/onboarding\/flexible\/shipping/);

    // The step must actually SWAP, not just the URL. An earlier cut of this
    // change left step 10 frozen mid-exit under a correct /flexible/preferences
    // URL — a URL-only assertion passed against that stale DOM. Assert the old
    // step is gone and the new one is mounted.
    await expect(page.locator("#origin-name")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: /How fast should it get there/i })
    ).toBeVisible();

    // Walking back re-opens each question in turn, and the typed origin is
    // intact — the skip never cleared it.
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page).toHaveURL(/\/onboarding\/flexible\/package/);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page).toHaveURL(/\/origin$/);
    await expect(page.locator("#origin-name")).toHaveValue("Sarah Smith");

    // And taking it back restores the label path.
    await page.getByRole("button", { name: /Enter it myself/i }).click();
    await expect(page.getByRole("button", { name: /Sender will fill this in/i })).toBeVisible();
  });

  test("Full label flow: Step 0 → Step 1 → Step 10 → reaches email verification", async ({
    page,
  }) => {
    await page.goto("/onboarding");

    // ── Step 0: Select "Full prepaid label" ──────────────────
    // /onboarding resolves straight to the destination step (no picker, 2026-08-18)
    await expect(page).toHaveURL(/\/full-label\/destination$/);

    // ── Step 1: the destination address ──────────────────────
    await expect(
      page.getByRole("heading", {
        name: /Where's it going/i,
      })
    ).toBeVisible();

    // Fill the name field for destination
    await page.locator("#destination-name").fill("Jane Doe");

    // Fill destination address using SmartAddressInput
    await fillSmartAddress(page, "destination");

    // Click continue
    await page
      .getByRole("button", { name: /^Continue$/ })
      .click();

    // ── Step 10: Full Shipping Details ───────────────────────
    // Step-10 marker: the origin name field. (The old /Ship from/i text no
    // longer exists — step 10's heading is now "Origin address".)
    await expect(page.locator("#origin-name")).toBeVisible({ timeout: 5000 });

    // Fill origin name
    await page.locator("#origin-name").fill("John Smith");

    // Fill origin address
    await fillSmartAddress(page, "origin");

    // ── Step 14: parcel + carrier ────────────────────────────
    // Split out of step 10 on 2026-08-18 so the address and the package can be
    // deferred independently.
    await page.getByRole("button", { name: /^Continue$/ }).click();
    // Parcel fields start collapsed behind "or fill in manually" (2026-08-22).
    await page.getByRole("button", { name: /or fill in manually/i }).click();
    await expect(
      page.getByRole("textbox", { name: "L", exact: true })
    ).toBeVisible({ timeout: 5000 });

    // Dimensions — L, W, H (use exact role matching to avoid ambiguity)
    await page.getByRole("textbox", { name: "L", exact: true }).fill("10");
    await page.getByRole("textbox", { name: "W", exact: true }).fill("10");
    await page.getByRole("textbox", { name: "H", exact: true }).fill("10");

    // Weight
    await page.getByRole("textbox", { name: "lbs" }).fill("5");

    // ── Step 20: shipping — rates fetch on entry ─────────────
    await page.getByRole("button", { name: /^Continue$/ }).click();
    await expect(page).toHaveURL(/\/full-label\/shipping/);
    await expect(
      page.getByText(/USPS/i).first()
    ).toBeVisible({ timeout: 8000 });

    // A rate card should be visible with a price
    await expect(page.getByText("$9.20").first()).toBeVisible();

    // Click continue to payment
    await page
      .getByRole("button", { name: /^Continue$/ })
      .click();

    // ── Step 11: the Contact step ────────────────────────────
    // Since 2026-08-22 this step both COLLECTS the email and confirms it —
    // the input moved here off step 1 — so the flow arrives with nothing
    // entered and the collect phase renders first.
    await expect(
      page.getByRole("heading", { name: /How do we reach you/i }),
    ).toBeVisible({ timeout: 5000 });
    await page.getByPlaceholder("Email address").fill("test@example.com");
    await page.getByRole("button", { name: /Send me a code/i }).click();

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
    // /onboarding resolves straight to the destination step (no picker, 2026-08-18)
    await expect(page).toHaveURL(/\/full-label\/destination$/);

    // Continue with nothing filled in.
    await page
      .getByRole("button", { name: /^Continue$/ })
      .click();

    // Validation summary + specific errors render; the step does not advance.
    // Destination only — the creator's email moved to the Contact step on
    // 2026-08-22, so step 1 no longer gates on it.
    await expect(page.getByText("Please fix the following:")).toBeVisible();
    await expect(page.getByText("Destination address is required")).toBeVisible();
    await expect(page.getByText(/Email is required/i)).toHaveCount(0);
    await expect(page.locator("#origin-name")).not.toBeVisible();
  });

  test("Step 10: an empty Continue is blocked on the address only", async ({
    page,
  }) => {
    await gotoStep10(page);

    await page.getByRole("button", { name: /^Continue$/ }).click();

    await expect(page.getByText("Please fix the following:")).toBeVisible();
    // "Origin address is required" renders both inline and in the summary list
    // — .first() is enough to prove the error surfaced.
    await expect(page.getByText("Origin address is required").first()).toBeVisible();
    // Parcel errors belong to step 14 now and must NOT appear here.
    await expect(page.getByText("Length is required")).toHaveCount(0);
  });

  test("Step 14: an empty Continue is blocked on the parcel", async ({ page }) => {
    await gotoStep10(page);
    await gotoPackageStep(page);

    await page.getByRole("button", { name: /^Continue$/ }).click();

    await expect(page.getByText("Please fix the following:")).toBeVisible();
    await expect(page.getByText("Length is required")).toBeVisible();
    // A validation summary naming Length must never point at a field the user
    // cannot see — failing validation reveals the collapsed parcel fields.
    await expect(page.getByRole("textbox", { name: "L", exact: true })).toBeVisible();
  });

  test("Step 14: the Magic Guestimator auto-fills package dimensions", async ({
    page,
  }) => {
    await gotoStep10(page);
    await gotoPackageStep(page);

    await expect(
      page.getByRole("heading", { name: "Describe it in plain words" }),
    ).toBeVisible();

    // The parcel fields start collapsed — describing the item is the intended
    // path, so the dimension cards are not the first thing on the screen.
    await expect(page.getByRole("textbox", { name: "L", exact: true })).toHaveCount(0);

    // The Guestimator's textarea is the only multiline input on the step.
    await page.locator("textarea").fill("a laptop");
    await page.getByRole("button", { name: /Estimate size & weight/i }).click();

    // The estimate renders as a one-line summary card (2026-08-30, Direction A
    // review) — the values are visible and "Adjust" opens the same fields.
    // This supersedes the 2026-08-24 reveal-the-fields confirmation; the old
    // invariant survives as "the guess the user cannot see doesn't exist":
    // the summary shows every value the estimate set.
    await expect(page.getByText(/Our estimate for/)).toBeVisible({ timeout: 8000 });
    await expect(page.getByText(/15 × /)).toBeVisible();
    await expect(page.getByRole("textbox", { name: "L", exact: true })).toHaveCount(0);
    await expect(page.getByText(/Auto-filled packaging/i)).toHaveCount(0);

    // "Adjust" opens the real fields, carrying the estimate's values.
    await page.getByRole("button", { name: /Adjust size, weight or packaging/i }).click();
    await expect(
      page.getByRole("textbox", { name: "L", exact: true }),
    ).toHaveValue("15");
  });

  test("Step 14: 'or fill in manually' opens the parcel fields without the Guestimator", async ({
    page,
  }) => {
    await gotoStep10(page);
    await gotoPackageStep(page);

    await expect(page.getByRole("textbox", { name: "L", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: /or fill in manually/i }).click();
    await expect(page.getByRole("textbox", { name: "L", exact: true })).toBeVisible();
    // The escape is spent once the fields are open — it has nothing left to do.
    await expect(page.getByRole("button", { name: /or fill in manually/i })).toHaveCount(0);
  });

  test("Back navigation: Step 10 → Step 1 keeps the entered data", async ({
    page,
  }) => {
    await gotoStep10(page);

    await page.getByRole("button", { name: "Back", exact: true }).click();

    // Back on Step 1, with the verified destination address still in place.
    await expect(
      page.getByRole("heading", {
        name: /Where's it going/i,
      }),
    ).toBeVisible();
    await expect(page.getByText("Verified").first()).toBeVisible();
  });
});

test.describe("Seller entry points — coming-soon mode", () => {
  // The buttons are inert while the buyer checkout is test-mode, but the /sell
  // route itself was ungated: a signed-in user who guessed the URL got a
  // working builder and could share a link whose buyer's card is declined.
  test("/sell is closed to non-admins while the seller flow is not live", async ({ page }) => {
    await page.goto("/sell");
    // 15s: first paint can absorb cold Vite transforms when this test is the
    // first to hit a fresh dev server under full-suite parallelism (35s+
    // observed 2026-08-18). Suite convention for first-paint-under-load.
    await expect(page.getByText(/Coming soon/i).first()).toBeVisible({ timeout: 15_000 });
    // The builder itself must not render — no origin address form.
    await expect(page.locator("#origin-address")).toHaveCount(0);
  });
});
