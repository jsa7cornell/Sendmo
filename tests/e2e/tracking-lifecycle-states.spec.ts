/**
 * tracking-lifecycle-states.spec.ts
 *
 * Regression guard for the four lifecycle buckets on /t/<code>.
 *
 * Per 2026-05-19_unify-confirmation-into-tracking proposal (Author response
 * → blocking finding #1 + Pass 7 execution plan):
 *
 *   F1 (pre-dropoff)   — status: label_created → state hero "ready to print",
 *                        Print + Download buttons, HowToShipStrip heading.
 *   F2 (post-dropoff)  — status: in_transit     → state hero "in transit",
 *                        lifecycle progress with at least one done dot.
 *   F2' (post-delivery)— status: delivered      → state hero "delivered",
 *                        lifecycle progress with all dots done.
 *   F3 (terminal)      — status: cancelled      → voided banner heading.
 *                        (Preserves existing F3 composition from
 *                        2026-05-13_tracking-page-ia-polish §2.1.)
 *
 * Additionally, for each state: assert the "Need help" link inside
 * DetailsCard is visible and points at mailto:support@sendmo.co.
 *
 * Strategy: mock the tracking Edge Function entirely — each test navigates
 * to /t/TESTLC1 with a different mocked response. No DB seeding needed.
 */

import { test, expect, type Page } from "@playwright/test";

const SUPABASE_URL = "https://fkxykvzsqdjzhurntgah.supabase.co";

// ── Shared fixture fields ──────────────────────────────────────────────────

const BASE_TRACKING = {
  tracking_number: "9400111899223456789012",
  public_code: "TESTLC1",
  carrier: "USPS",
  service: "GroundAdvantage",
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
  viewerRole: "anonymous" as const,
  recipient_first_name: null,
  refund_status: "none",
  paid: false,
  amount_paid_cents: null,
  is_test: true,
  cancelled_at: null,
  cancelled_by_actor: null,
  item_description: "Test item",
  from_city: "San Francisco",
  from_state: "CA",
  to_city: "Los Angeles",
  to_state: "CA",
  print_count: 0,
  last_printed_at: null,
};

// ── Helper: mock the tracking endpoint with the given status override ──────

async function mockTrackingEndpoint(page: Page, overrides: Partial<typeof BASE_TRACKING>) {
  const body = { ...BASE_TRACKING, ...overrides };
  await page.route(`${SUPABASE_URL}/functions/v1/tracking*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    })
  );
  // Supabase REST API — auth / profile lookups
  await page.route(`${SUPABASE_URL}/rest/v1/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    })
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe("TrackingPage — lifecycle state rendering", () => {

  // ── F1: pre-dropoff (status: label_created) ──────────────────────────────

  test("F1 — label_created: shows 'ready to print' hero, Print + Download buttons, HowToShipStrip", async ({ page }) => {
    await mockTrackingEndpoint(page, { status: "label_created" });
    await page.goto("/t/TESTLC1");

    // State hero headline — substring match ("ready to print")
    await expect(page.getByText(/ready to print/i)).toBeVisible({ timeout: 10000 });

    // Print button
    await expect(
      page.getByRole("button", { name: /print/i })
        .or(page.getByRole("link", { name: /print/i }))
        .first()
    ).toBeVisible();

    // Download button
    await expect(
      page.getByRole("button", { name: /download/i })
        .or(page.getByRole("link", { name: /download/i }))
        .first()
    ).toBeVisible();

    // HowToShipStrip heading
    await expect(page.getByText(/how to ship/i)).toBeVisible();

    // ETA banner absent (promised_delivery_date: null)
    // No assertion here — it self-hides when null; asserting absence is fragile.

    // "Need help" link in DetailsCard footer
    await expect(
      page.getByRole("link", { name: /need help/i })
    ).toBeVisible();
    const helpHref = await page.getByRole("link", { name: /need help/i }).getAttribute("href");
    expect(helpHref).toMatch(/^mailto:support@sendmo\.co/);
  });

  // ── F2: post-dropoff (status: in_transit) ────────────────────────────────

  test("F2 — in_transit: shows 'in transit' hero, lifecycle progress with at least one done dot", async ({ page }) => {
    await mockTrackingEndpoint(page, {
      status: "in_transit",
      events: [
        {
          message: "Accepted at USPS Origin Facility",
          status: "in_transit",
          datetime: new Date().toISOString(),
          location: "San Francisco, CA",
        },
      ],
    });
    await page.goto("/t/TESTLC1");

    // State hero headline — match the h1. A bare /in transit/i is a
    // strict-mode violation: it also hits the "In Transit" progress-step label.
    await expect(
      page.getByRole("heading", { level: 1, name: /in transit/i }),
    ).toBeVisible({ timeout: 10000 });

    // Lifecycle progress card
    const progressCard = page.getByRole("heading", { name: "Progress" }).locator("..");
    await expect(progressCard).toBeVisible();

    // At least one completed step dot. Scope the dot match to the Progress
    // card — unscoped, .rounded-full.bg-primary also catches the first
    // Tracking-History event dot, which lives in a different card.
    await expect(
      progressCard.locator(".rounded-full.bg-primary").first(),
    ).toBeVisible();

    // "Need help" link
    await expect(
      page.getByRole("link", { name: /need help/i })
    ).toBeVisible();
    const helpHref = await page.getByRole("link", { name: /need help/i }).getAttribute("href");
    expect(helpHref).toMatch(/^mailto:support@sendmo\.co/);
  });

  // ── F2': post-delivery (status: delivered) ───────────────────────────────

  test("F2' — delivered: shows 'delivered' hero, lifecycle progress with all dots done", async ({ page }) => {
    await mockTrackingEndpoint(page, {
      status: "delivered",
      delivered_at: new Date().toISOString(),
      events: [
        {
          message: "Delivered",
          status: "delivered",
          datetime: new Date().toISOString(),
          location: "Los Angeles, CA",
        },
      ],
    });
    await page.goto("/t/TESTLC1");

    // State hero headline — match the h1.
    await expect(
      page.getByRole("heading", { level: 1, name: /delivered/i }),
    ).toBeVisible({ timeout: 10000 });

    // Lifecycle progress card — all four TIMELINE_STEPS complete.
    // TIMELINE_STEPS = ["label_created", "in_transit", "out_for_delivery", "delivered"]
    // Scope the completed-dot count to the Progress card; unscoped it also
    // catches the Tracking-History event dot, which lives in a different card.
    const progressCard = page.getByRole("heading", { name: "Progress" }).locator("..");
    await expect(progressCard).toBeVisible();
    await expect(progressCard.locator(".rounded-full.bg-primary")).toHaveCount(4, {
      timeout: 5000,
    });

    // "Need help" link
    await expect(
      page.getByRole("link", { name: /need help/i })
    ).toBeVisible();
    const helpHref = await page.getByRole("link", { name: /need help/i }).getAttribute("href");
    expect(helpHref).toMatch(/^mailto:support@sendmo\.co/);
  });

  // ── F3: terminal (status: cancelled) ─────────────────────────────────────
  // Preserves the existing F3 composition from 2026-05-13_tracking-page-ia-polish §2.1.
  // Per Author response blocking finding #1: cancelled/return_to_sender must fall
  // through to the F3 path — not be misclassified as label_created (pre-dropoff).

  test("F3 — cancelled: shows voided banner, does NOT show pre-dropoff hero or Print button", async ({ page }) => {
    await mockTrackingEndpoint(page, {
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      cancelled_by_actor: "link_owner",
      refund_status: "not_applicable",
    });
    await page.goto("/t/TESTLC1");

    // CancelledShipmentBanner heading — TERMINAL_BANNERS.cancelled.title = "This label was voided"
    await expect(page.getByText(/voided/i)).toBeVisible({ timeout: 10000 });

    // Must NOT show the pre-dropoff hero ("ready to print") — regression guard for
    // the blocking finding #1 fall-through: cancelled must NOT map to label_created.
    await expect(page.getByText(/ready to print/i)).not.toBeVisible();

    // Must NOT show Print or Download action buttons (F3 has no label actions)
    await expect(
      page.getByRole("button", { name: /^print$/i })
        .or(page.getByRole("link", { name: /^print$/i }))
    ).not.toBeVisible();

    // "Need help" link in DetailsCard(family=3) footer
    await expect(
      page.getByRole("link", { name: /need help/i })
    ).toBeVisible();
    const helpHref = await page.getByRole("link", { name: /need help/i }).getAttribute("href");
    expect(helpHref).toMatch(/^mailto:support@sendmo\.co/);
  });

  // ── out_for_delivery: post-dropoff bucket ─────────────────────────────────
  // Sanity-check that out_for_delivery routes to F2 (not F1 or unknown fallback).

  test("out_for_delivery: routes to post-dropoff F2 — shows progress, not print buttons", async ({ page }) => {
    await mockTrackingEndpoint(page, {
      status: "out_for_delivery",
      events: [
        {
          message: "Out for Delivery",
          status: "out_for_delivery",
          datetime: new Date().toISOString(),
          location: "Los Angeles, CA",
        },
      ],
    });
    await page.goto("/t/TESTLC1");

    // Should show a post-dropoff hero (in transit or out for delivery text)
    await expect(
      page.getByText(/in transit|out for delivery/i).first()
    ).toBeVisible({ timeout: 10000 });

    // Lifecycle progress card visible
    await expect(page.getByText(/progress/i).first()).toBeVisible();

    // Must NOT show pre-dropoff hero ("ready to print")
    await expect(page.getByText(/ready to print/i)).not.toBeVisible();
  });

});
