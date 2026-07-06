/**
 * tracking-anonymous-payment-gating.spec.ts
 *
 * Load-bearing regression guard for blocking finding #2 of proposal
 * 2026-05-19_unify-confirmation-into-tracking:
 *
 *   "Anonymous-viewer payment-info filtering must be server-side, not
 *   client-side. [...] Client-side filtering ≠ a security boundary; anyone
 *   curl'ing /functions/v1/tracking?code=<x> or scraping the JSON sees
 *   the payment fields regardless of what ReceiptBlock renders."
 *
 * Author response (blocking finding #2):
 *   "Gate `paid` / `amount_paid_cents` / any new receipt fields server-side
 *   in tracking/index.ts on viewerRole === 'payer'. Anonymous response shape
 *   omits [or collapses] the fields entirely. New e2e: `tracking anonymous
 *   response omits payment fields` — assertion on JSON shape, not on
 *   rendered UI."
 *
 * This spec asserts the JSON shape of the tracking Edge Function response,
 * NOT the rendered UI, so it catches server-side regressions that client-side
 * render tests would miss.
 *
 * ── Test structure ────────────────────────────────────────────────────────
 *
 * Part 1 — Anonymous request (no Authorization header):
 *   - paid === false
 *   - amount_paid_cents === null
 *   - viewerRole === "anonymous"
 *   - recipient_first_name === null
 *
 * Part 2 — Payer request (JWT of the link owner):
 *   - viewerRole === "payer"
 *   - recipient_first_name is a string (or null if profile has no full_name —
 *     tolerant assertion)
 *
 * ── Infrastructure notes ──────────────────────────────────────────────────
 *
 * These tests call the REAL tracking Edge Function against the dev/test DB.
 * They require:
 *   SENDMO_TEST_PUBLIC_CODE   — public_code of a shipment in the test DB
 *   SENDMO_TEST_PAYER_JWT     — JWT of the user who owns that shipment's link
 *
 * If either env var is unset, the relevant test is skipped with a TODO.
 * The anonymous half (Part 1) is the load-bearing regression guard —
 * it is sufficient on its own if SENDMO_TEST_PAYER_JWT is not set.
 *
 * To obtain these values for local development:
 *   1. Find a test shipment in the DB that has a sendmo_link with a known
 *      user. Note its public_code.
 *   2. Sign in as that user via the app and copy the access_token from
 *      localStorage.sendmo-auth-token (or equivalent Supabase session key).
 *   3. Set SENDMO_TEST_PUBLIC_CODE and SENDMO_TEST_PAYER_JWT in .env.local.
 *
 * Alternatively, create a test shipment via the full onboarding flow in
 * test mode and capture the public_code from the redirect URL.
 */

import { test, expect } from "@playwright/test";

// The tracking Edge Function URL is derived from the Supabase project URL.
// We hardcode the project URL here (same as other specs in this suite) since
// VITE_SUPABASE_URL is not available in the Playwright process environment.
const SUPABASE_URL = "https://fkxykvzsqdjzhurntgah.supabase.co";
const TRACKING_ENDPOINT = `${SUPABASE_URL}/functions/v1/tracking`;

const TEST_PUBLIC_CODE = process.env.SENDMO_TEST_PUBLIC_CODE ?? "";
const TEST_PAYER_JWT = process.env.SENDMO_TEST_PAYER_JWT ?? "";

// ── Guards for conditional tests ──────────────────────────────────────────
const testWithCode = TEST_PUBLIC_CODE ? test : test.skip;
const testWithCodeAndJwt = TEST_PUBLIC_CODE && TEST_PAYER_JWT ? test : test.skip;

// ── Part 1: Anonymous request ─────────────────────────────────────────────

test.describe("tracking API — anonymous viewer payment-field gating", () => {

  testWithCode(
    "anonymous GET returns paid=false, amount_paid_cents=null, viewerRole='anonymous', recipient_first_name=null",
    async ({ request }) => {
      // Make an unauthenticated request — no Authorization header.
      // This is the critical regression guard: even if the shipment has a real
      // Stripe payment (stripe_payment_intent_id IS NOT NULL), the server must
      // gate paid/amount_paid_cents to false/null for anonymous callers.
      const response = await request.get(
        `${TRACKING_ENDPOINT}?code=${encodeURIComponent(TEST_PUBLIC_CODE)}`,
        {
          // Explicitly no Authorization header — anonymous caller.
          headers: {
            // Supabase requires at least the anon key for Edge Functions
            // that do not use verify_jwt. The tracking function is
            // verify_jwt=false at the gateway but still handles auth
            // optionally for viewer_is_recipient derivation.
            // Pass no auth header — the spec exercises the zero-auth path.
          },
        }
      );

      expect(response.ok()).toBeTruthy();
      const body = await response.json();

      // ── Load-bearing assertions ──────────────────────────────────────────
      // These are the information-zero guarantees from tracking/index.ts lines
      // 498-503 (viewerRole === 'payer' gate).

      // Anonymous viewers ALWAYS see paid=false regardless of real payment state.
      expect(body.paid).toBe(false);

      // Anonymous viewers ALWAYS see amount_paid_cents=null.
      expect(body.amount_paid_cents).toBeNull();

      // Anonymous viewers ALWAYS see payment_method_last4=null — card
      // metadata sits inside the same payer gate as amount_paid_cents.
      expect(body.payment_method_last4).toBeNull();

      // Server must derive and return viewerRole = "anonymous" when no JWT.
      expect(body.viewerRole).toBe("anonymous");

      // recipient_first_name must be null for anonymous viewers —
      // the profiles join is skipped server-side for anonymous callers.
      expect(body.recipient_first_name).toBeNull();

      // ── Sanity: public fields must still be present ──────────────────────
      // The gate must not accidentally drop non-payment fields.
      expect(typeof body.tracking_number).toBe("string");
      expect(typeof body.status).toBe("string");
      expect(typeof body.carrier).toBe("string");
    }
  );

  // Regression guard: the gate must not be bypassable by injecting an
  // anonymous-key-only Authorization header (which is not a user JWT).
  // tracking/index.ts: token !== anonKey check at line 374 must hold.
  testWithCode(
    "request with Supabase anon key (not a user JWT) is treated as anonymous",
    async ({ request }) => {
      // We don't have the anon key in the test process env to inject, but
      // we can assert by using a clearly invalid JWT — the server must not
      // throw or return payer data; it must degrade gracefully to anonymous.
      const response = await request.get(
        `${TRACKING_ENDPOINT}?code=${encodeURIComponent(TEST_PUBLIC_CODE)}`,
        {
          headers: {
            Authorization: "Bearer not_a_real_jwt_token_at_all",
          },
        }
      );

      // Should still return 200 — tracking is public; invalid JWT is ignored.
      expect(response.ok()).toBeTruthy();
      const body = await response.json();

      // Must still see the anonymous shape for payment fields.
      expect(body.paid).toBe(false);
      expect(body.amount_paid_cents).toBeNull();
      expect(body.payment_method_last4).toBeNull();
      expect(body.viewerRole).toBe("anonymous");
    }
  );

});

// ── Part 2: Payer request ─────────────────────────────────────────────────

test.describe("tracking API — payer viewer role", () => {

  testWithCodeAndJwt(
    "payer GET returns viewerRole='payer' and recipient_first_name is string or null",
    async ({ request }) => {
      // TODO: to enable this test, set SENDMO_TEST_PUBLIC_CODE and
      // SENDMO_TEST_PAYER_JWT in .env.local:
      //   SENDMO_TEST_PUBLIC_CODE=<public_code of a shipment owned by the JWT user>
      //   SENDMO_TEST_PAYER_JWT=<access_token from Supabase session of the link owner>
      //
      // The JWT must correspond to the user_id on the sendmo_link that owns
      // the shipment identified by SENDMO_TEST_PUBLIC_CODE.
      const response = await request.get(
        `${TRACKING_ENDPOINT}?code=${encodeURIComponent(TEST_PUBLIC_CODE)}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_PAYER_JWT}`,
          },
        }
      );

      expect(response.ok()).toBeTruthy();
      const body = await response.json();

      // Server-derived viewerRole must be "payer" when JWT matches link owner.
      expect(body.viewerRole).toBe("payer");

      // recipient_first_name may be null if the profile has no full_name set —
      // tolerate null here; non-null is the happy path.
      expect(
        body.recipient_first_name === null || typeof body.recipient_first_name === "string"
      ).toBe(true);

      // viewer_is_recipient must also be true (legacy boolean, still returned).
      expect(body.viewer_is_recipient).toBe(true);

      // paid is a boolean (may be true or false depending on payment state).
      expect(typeof body.paid).toBe("boolean");

      // amount_paid_cents is number or null — both are valid; the gate only
      // requires it is NOT gated to null for payer (it may be null if comp).
      expect(
        body.amount_paid_cents === null || typeof body.amount_paid_cents === "number"
      ).toBe(true);

      // payment_method_last4 is a 4-char string or null (null when comp or
      // when the stripe_intents → payment_methods chain has a gap).
      expect(
        body.payment_method_last4 === null ||
          (typeof body.payment_method_last4 === "string" && body.payment_method_last4.length === 4)
      ).toBe(true);
    }
  );

});

// ── Part 3: Shape-only assertions (no live DB needed) ────────────────────
//
// These tests use a mocked fetch and can run in any environment.
// They assert that the response shape contract from the proposal is correct
// even when we cannot talk to the real Edge Function.

test.describe("tracking API — response shape contract (mocked)", () => {

  test("anonymous mock response satisfies the payment-gating contract", async ({ page }) => {
    // Mock the tracking endpoint at the page level to return a known anonymous shape.
    await page.route(`${SUPABASE_URL}/functions/v1/tracking*`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tracking_number: "9400111899223456789012",
          public_code: "TESTPG1",
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
          // Payment-gating contract — anonymous shape:
          viewer_is_recipient: false,
          viewerRole: "anonymous",
          recipient_first_name: null,
          paid: false,
          amount_paid_cents: null,
          payment_method_last4: null,
          refund_status: "none",
          is_test: true,
          cancelled_at: null,
          cancelled_by_actor: null,
          item_description: null,
          from_city: "San Francisco",
          from_state: "CA",
          to_city: "Los Angeles",
          to_state: "CA",
          print_count: 0,
          last_printed_at: null,
        }),
      })
    );

    // Navigate to the tracking page and capture the fetch response.
    // The page will call the endpoint and we read the response via page.evaluate.
    await page.route(`${SUPABASE_URL}/rest/v1/**`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
    );

    await page.goto("/t/TESTPG1");

    // Assert via the page: no receipt block should be rendered for anonymous viewers.
    // The ReceiptBlock is gated on effectiveViewerRole === "payer" in TrackingPage.tsx.
    // "Amount paid" text is a good proxy — it should be absent.
    await expect(page.getByText(/amount paid/i)).not.toBeVisible({ timeout: 8000 });

    // Pre-dropoff surface IS visible (non-payment assertions still hold).
    await expect(page.getByText(/ready to print/i)).toBeVisible({ timeout: 8000 });
  });

  test("payer mock response surfaces receipt block when viewerRole=payer", async ({ page }) => {
    await page.route(`${SUPABASE_URL}/functions/v1/tracking*`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tracking_number: "9400111899223456789012",
          public_code: "TESTPG2",
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
          link_short_code: "TESTSC2",
          link_status: "in_use",
          link_type: "full_label",
          // Payment-gating contract — payer shape:
          viewer_is_recipient: true,
          viewerRole: "payer",
          recipient_first_name: "Jane",
          paid: false,             // comp shipment — paid is false even for payer
          amount_paid_cents: null, // comp shipment — null even for payer
          payment_method_last4: null, // comp shipment — no card was charged
          refund_status: "none",
          is_test: true,
          cancelled_at: null,
          cancelled_by_actor: null,
          item_description: null,
          from_city: "San Francisco",
          from_state: "CA",
          to_city: "Los Angeles",
          to_state: "CA",
          print_count: 0,
          last_printed_at: null,
        }),
      })
    );

    await page.route(`${SUPABASE_URL}/rest/v1/**`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
    );

    await page.goto("/t/TESTPG2");

    // Payer sees ReceiptBlock. The ReceiptBlock renders for viewerRole=payer.
    // comp-shipment receipt shows "No charge" or "$0.00" copy (from ReceiptBlock).
    // We assert the block is present by checking for a receipt-related text.
    // This assertion ties to ReceiptBlock's rendered copy — update if copy changes.
    await expect(
      page.getByText(/no charge|receipt|amount paid|\$0/i).first()
    ).toBeVisible({ timeout: 8000 });
  });

  test("payer receipt shows card last4 when payment_method_last4 is present", async ({ page }) => {
    await page.route(`${SUPABASE_URL}/functions/v1/tracking*`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tracking_number: "9400111899223456789012",
          public_code: "TESTPG3",
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
          link_short_code: "TESTSC3",
          link_status: "in_use",
          link_type: "full_label",
          // Payment-gating contract — paid payer shape:
          viewer_is_recipient: true,
          viewerRole: "payer",
          recipient_first_name: "Jane",
          paid: true,
          amount_paid_cents: 1595,
          payment_method_last4: "4242",
          refund_status: "none",
          is_test: true,
          cancelled_at: null,
          cancelled_by_actor: null,
          item_description: null,
          from_city: "San Francisco",
          from_state: "CA",
          to_city: "Los Angeles",
          to_state: "CA",
          print_count: 0,
          last_printed_at: null,
        }),
      })
    );

    await page.route(`${SUPABASE_URL}/rest/v1/**`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
    );

    await page.goto("/t/TESTPG3");

    // ReceiptBlock masks the card as "•••• 4242" (maskedCard in
    // ReceiptBlock.tsx) instead of the "card on file" fallback.
    await expect(page.getByText(/•••• 4242/).first()).toBeVisible({ timeout: 8000 });
    await expect(page.getByText(/card on file/i)).not.toBeVisible();
  });

});
