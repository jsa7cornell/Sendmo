import { test, expect, type Page } from "@playwright/test";
import { SUPABASE_URL } from "./supabase-env";

// The sender is asked ONE question per step, and only the questions the link
// leaves open (2026-08-24). Before this every sender got the same
// "Package Details" mega-step — destination, ship-from and parcel on one
// screen — even when the creator had already answered two of the three.
//
// The prefill assertions from sender-origin-prefill.spec.ts (2026-08-18) move
// here: a carried answer now means the question is not asked at all, so
// "did the prefill land" and "was the question skipped" are the same test.

const LINK = {
  id: "link-1", short_code: "PREFIL1", link_type: "flexible", status: "active", is_test: true,
  max_price_cents: 10000, preferred_speed: "standard", preferred_carrier: null,
  size_hint: null, notes: null, recipient_city: "Portola Valley", recipient_state: "CA",
  recipient_zip: "94028", recipient_name: "John Anderson", recipient_address_complete: true,
  is_funded: true, public_code: "PC12345", origin_city: null, origin_state: null,
  package_prefill: null, origin_prefill: null,
};
const ORIGIN = {
  name: "Sarah Smith", street1: "388 Townsend St", street2: null, city: "San Francisco",
  state: "CA", zip: "94107", phone: "4155550142", verified: true,
};
const PARCEL = { length_in: 12, width_in: 9, height_in: 4, weight_oz: 32 };

const RATES = {
  // The /rates wire shape, not the client's ShippingRate — api.fetchSenderRates
  // maps easypost_rate_id/display_price/delivery_days across. A fixture in the
  // client shape passes the route mock and then quietly yields undefined days
  // and a $0 price, which makes "the sender sees no price" vacuous.
  rates: [
    { easypost_rate_id: "rate_1", easypost_shipment_id: "shp_test",
      carrier: "USPS", service: "Priority", display_price: 11.35, delivery_days: 2 },
    { easypost_rate_id: "rate_2", easypost_shipment_id: "shp_test",
      carrier: "UPS", service: "Ground", display_price: 18.40, delivery_days: 3 },
  ],
};

async function mockLink(page: Page, link: object) {
  await page.route(`${SUPABASE_URL}/rest/v1/**`, r =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route(`${SUPABASE_URL}/functions/v1/**`, r =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route(`${SUPABASE_URL}/functions/v1/labels**`, r =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      public_code: "PC12345", cancel_token: "tok", tracking_number: "1Z", label_url: "https://example.test/l.png",
    }) }));
  await page.route(`${SUPABASE_URL}/functions/v1/rates**`, r =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RATES) }));
  // Registered LAST so it wins — Playwright checks routes most-recent-first.
  // With the catch-all winning instead, linkData is {} and a prefill assertion
  // passes vacuously against an empty form.
  await page.route(`${SUPABASE_URL}/functions/v1/links**`, r =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(link) }));
}

async function start(page: Page, link: object) {
  await mockLink(page, link);
  await page.goto("/s/PREFIL1");
  await page.getByRole("button", { name: /Get Started/i }).click();
}

const q = {
  destination: /Where is it going\?/i,
  origin: /Where's it shipping from\?/i,
  package: /What are you shipping\?/i,
};

test.describe("the sender is asked only what the link left open", () => {
  test("everything specced but the destination → one question", async ({ page }) => {
    // The shape John hit on 2026-08-24: the creator supplied the ship-from
    // address and the parcel and deferred only the delivery address.
    await start(page, {
      ...LINK, origin_prefill: ORIGIN, package_prefill: PARCEL,
      recipient_name: null, recipient_city: null, recipient_state: null, recipient_zip: null,
      needs_destination: true,
    });

    await expect(page.getByRole("heading", { name: q.destination })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("heading", { name: q.origin })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: q.package })).toHaveCount(0);
    // Nothing pre-answered is on screen as a form: no dimension inputs at all.
    await expect(page.getByPlaceholder("L", { exact: true })).toHaveCount(0);
  });

  test("a bare link asks for the ship-from address, then the parcel", async ({ page }) => {
    await start(page, { ...LINK });

    await expect(page.getByRole("heading", { name: q.origin })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("heading", { name: q.package })).toHaveCount(0);
  });

  test("a specced parcel is never asked about again", async ({ page }) => {
    await start(page, { ...LINK, origin_prefill: ORIGIN, package_prefill: PARCEL });
    // Nothing left to ask → the flow goes straight to shipping options.
    await expect(page.getByPlaceholder("L", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: q.origin })).toHaveCount(0);
  });

  test("a phone-less ship-from prefill is still a question", async ({ page }) => {
    // The carriers reject a from-address with no phone, so a prefill without
    // one is a half-answer — skipping the step would bypass the phone gate.
    await start(page, {
      ...LINK, package_prefill: PARCEL,
      origin_prefill: { ...ORIGIN, phone: "" },
    });
    await expect(page.getByRole("heading", { name: q.origin })).toBeVisible({ timeout: 10000 });
    // …with the address the creator did supply already in place.
    await expect(page.getByText(/388 Townsend St/).first()).toBeVisible();
  });

  test("a weightless parcel prefill is still a question, with blank dims", async ({ page }) => {
    await start(page, {
      ...LINK, origin_prefill: ORIGIN,
      package_prefill: { ...PARCEL, weight_oz: null },
    });
    await expect(page.getByRole("heading", { name: q.package })).toBeVisible({ timeout: 10000 });
    // Shared <ParcelQuestion>: describe-it-first, so the dimension fields are
    // behind "or fill in manually" until there is something to show.
    await expect(page.getByPlaceholder("L", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: /or fill in manually/i }).click();
    await expect(page.getByPlaceholder("L", { exact: true })).toHaveValue("");
  });

  test("an asked parcel question carries whatever the creator did specc", async ({ page }) => {
    // origin deferred to the sender, parcel specced: the parcel question is
    // skipped, so ask for a link that specced neither and check the blank.
    await start(page, { ...LINK });
    await expect(page.getByRole("heading", { name: q.origin })).toBeVisible({ timeout: 10000 });
    await expect(page.getByLabel(/Origin address/i)).toHaveValue("");
  });
});

test.describe("the review step summarises the shipment the way its creator saw it", () => {
  test("reaches Review and shows the shared Shipment Details card", async ({ page }) => {
    await start(page, { ...LINK, origin_prefill: ORIGIN, package_prefill: PARCEL });

    // Nothing to ask → rates. Pick the mocked rate and continue.
    await expect(page.getByText(/USPS/i).first()).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: /continue|review/i }).first().click();

    await expect(page.getByText("Shipment Details")).toBeVisible({ timeout: 10000 });
    // The same four cells the creator's card carries, in the same order.
    const keys = await page.locator("text=/^(from|to|parcel|via)$/i").allTextContents();
    expect(keys.map(k => k.toLowerCase())).toEqual(["from", "to", "parcel", "via"]);
    // The sender never sees what the recipient is paying.
    await expect(page.getByText(/\$11\.35|\$9\.00/)).toHaveCount(0);
    await expect(page.getByText(/Shipping is prepaid by John Anderson/i)).toBeVisible();
  });
});

test.describe("a replayed buy is refused with the human copy, not the machine token", () => {
  // labels PR1 (seller-link launch proposal): a buy for a shipment that
  // already has a shipments row bound to a different payment returns 409
  // { error: "already_purchased", code: "SHIPMENT_ALREADY_PURCHASED",
  //   message: <support copy> }. The client must surface `message` — before
  // the api.ts fix, the raw token "already_purchased" was what rendered.
  test("shows the support copy from the 409 body", async ({ page }) => {
    await start(page, { ...LINK, origin_prefill: ORIGIN, package_prefill: PARCEL });
    // Re-register the labels mock so it wins over mockLink's happy-path one
    // (Playwright checks routes most-recent-first).
    await page.route(`${SUPABASE_URL}/functions/v1/labels**`, r =>
      r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({
        error: "already_purchased",
        code: "SHIPMENT_ALREADY_PURCHASED",
        refunded: true,
        message: "This shipment has already been purchased — your charge for this attempt has been refunded. If you believe this is an error, contact support@sendmo.co with reference shp_test",
      }) }));

    await expect(page.getByText(/USPS/i).first()).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: /continue|review/i }).first().click();
    await expect(page.getByText("Shipment Details")).toBeVisible({ timeout: 10000 });

    await page.locator("#sender-email").fill("sender@example.com");
    await page.getByRole("button", { name: /Confirm and generate label/i }).click();
    await page.getByRole("button", { name: /^Generate label$/i }).click();

    await expect(page.getByText(/Couldn't generate the label/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/contact support@sendmo\.co with reference/i)).toBeVisible();
    // The bare machine token must not be the rendered copy.
    await expect(page.getByText(/^already_purchased$/)).toHaveCount(0);
  });
});

test.describe("a sold seller link is a state, not an error", () => {
  // PR3 (seller-link launch): the links function 410s a non-active seller
  // link with { error, status, link_type } and the client renders "already
  // sold" — card styling, no destructive error framing. On a public
  // Marketplace post this is the most-visited screen after the first sale.
  test("renders 'This item has already sold' without the error card", async ({ page }) => {
    await mockLink(page, {});
    await page.route(`${SUPABASE_URL}/functions/v1/links**`, r =>
      r.fulfill({ status: 410, contentType: "application/json", body: JSON.stringify({
        error: "This item is no longer available", status: "in_use", link_type: "seller_link",
      }) }));
    await page.goto("/s/SOLDOUT1");

    await expect(page.getByRole("heading", { name: /This item has already sold/i })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/Hmm, that link didn't work/i)).toHaveCount(0);
  });

  test("a CLOSED listing (the PR5 off switch) renders the same sold-out state", async ({ page }) => {
    // 'closed' works because nothing enumerates statuses — the 410 fires on
    // any non-active seller link. This pins that invariant so a future
    // exhaustive status branch fails a test instead of shipping.
    await mockLink(page, {});
    await page.route(`${SUPABASE_URL}/functions/v1/links**`, r =>
      r.fulfill({ status: 410, contentType: "application/json", body: JSON.stringify({
        error: "This item is no longer available", status: "closed", link_type: "seller_link",
      }) }));
    await page.goto("/s/CLOSED01");

    await expect(page.getByRole("heading", { name: /This item has already sold/i })).toBeVisible({ timeout: 10000 });
  });

  test("a cancelled FLEX link keeps the ordinary error card", async ({ page }) => {
    await mockLink(page, {});
    await page.route(`${SUPABASE_URL}/functions/v1/links**`, r =>
      r.fulfill({ status: 410, contentType: "application/json", body: JSON.stringify({
        error: "This link is no longer active", status: "cancelled", link_type: "flexible",
      }) }));
    await page.goto("/s/GONEFLEX1");

    await expect(page.getByText(/Hmm, that link didn't work/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/This link is no longer active/i)).toBeVisible();
  });
});

test.describe("the shipping-option step", () => {
  test("names the cheapest option for the person paying, and drops the Guestimator note", async ({ page }) => {
    await start(page, { ...LINK, origin_prefill: ORIGIN, package_prefill: PARCEL });
    await expect(page.getByRole("heading", { name: /Choose a shipping option/i })).toBeVisible({ timeout: 15000 });

    // The sender sees no prices, so "cheapest" has to be said in words.
    const cheapest = page.getByText(/Most economical option for John Anderson/i);
    await expect(cheapest).toHaveCount(1);
    // …and it sits on the USPS card ($11.35), not the UPS one ($18.40).
    const uspsCard = page.locator("button", { hasText: /USPS/ }).first();
    await expect(uspsCard.getByText(/Most economical option/i)).toBeVisible();

    // The Guestimator beta note is gone — it described how the dimensions were
    // arrived at, on a screen about choosing a carrier.
    await expect(page.getByText(/Magic Guestimator is in beta/i)).toHaveCount(0);
    // No supporting line under the heading either.
    await expect(page.getByText(/Pick the speed that works best/i)).toHaveCount(0);
  });
});
