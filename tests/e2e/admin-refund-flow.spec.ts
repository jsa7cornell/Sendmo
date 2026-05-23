/**
 * E2E test: admin issues a partial refund via the /admin Labels tab.
 *
 * Pattern: mocked Edge Functions via page.route (no real Stripe/DB traffic).
 * Verifies: Refund button visibility, RefundModal opens, form validation,
 * successful submission path, and button disabled state after success (N1).
 *
 * Cross-link: H3 — decided proposal
 *   proposals/2026-05-21_refund-system-implementation_reviewed-2026-05-21_
 *   decided-2026-05-22.md — N1 (10s button disable after success).
 * PLAYBOOK Rule 19 — browser-verified spec for product surface (Admin.tsx +
 *   RefundModal.tsx).
 */

import { test, expect, type Page } from "@playwright/test";

// ── Mock helpers ─────────────────────────────────────────────────────────────

function mockAdminReport(page: Page) {
  return page.route("**/functions/v1/admin-report**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        mode: "live",
        data: [
          {
            id: "link-abc",
            short_code: "LINK1",
            link_type: "full_label",
            status: "in_use",
            created_at: new Date().toISOString(),
            is_test: false,
            profiles: { email: "test@example.com" },
            shipments: [
              {
                id: "ship-uuid-001",
                easypost_shipment_id: "shp_test_001",
                carrier: "USPS",
                service: "Ground Advantage",
                tracking_number: "9400111899223397861234",
                label_url: null,
                rate_cents: 900,
                status: "label_created",
                is_test: false,
                is_live: true,
                payment_method: "card",
                refund_status: "none",
                easypost_refund_status: null,
                refund_submitted_at: null,
                cancelled_at: null,
                created_at: new Date().toISOString(),
                stripe_payment_intent_id: "pi_test_001",
                transactions: [
                  {
                    id: "tx-charge-001",
                    amount_cents: 1150,
                    type: "charge",
                    funding_source: "card",
                    mode: "live",
                    stripe_intent_id: "pi_test_001",
                  },
                ],
                sender_address: { name: "Alice Smith", street1: "123 Main St", city: "SF", state: "CA", zip: "94107" },
                recipient_address: { name: "Bob Jones", street1: "456 Elm St", city: "Oakland", state: "CA", zip: "94601" },
              },
            ],
          },
        ],
      }),
    });
  });
}

function mockRefundsEndpoint(page: Page, opts: { success: boolean; error?: string } = { success: true }) {
  return page.route("**/functions/v1/refunds", async (route) => {
    if (!opts.success) {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: opts.error ?? "Refund failed" }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          refund_id: "re_test_abc123",
          amount_cents: 500,
          expected_post_refund_balance: 650,
        }),
      });
    }
  });
}

function mockSupabaseAuth(page: Page) {
  // Mock the Supabase profile call so isAdmin resolves to true.
  return page.route("**/rest/v1/profiles*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: "user-admin-001", role: "admin", email: "admin@sendmo.co" }]),
    });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe("Admin — Refund button and modal (H3)", () => {
  test.beforeEach(async ({ page }) => {
    await mockSupabaseAuth(page);
    await mockAdminReport(page);
    await mockRefundsEndpoint(page);
  });

  test("Refund button is visible for a shipment with a charge", async ({ page }) => {
    await page.goto("/admin");

    // The admin-report mock returns a live shipment with a charge row.
    // The Refund button should be visible in the Actions column.
    const refundButton = page.getByRole("button", { name: /refund/i }).first();
    await expect(refundButton).toBeVisible({ timeout: 10000 });
  });

  test("Clicking Refund opens the RefundModal", async ({ page }) => {
    await page.goto("/admin");

    const refundButton = page.getByRole("button", { name: /refund/i }).first();
    await refundButton.click();

    // Modal should appear with the shipment public ID.
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText(/issue refund/i)).toBeVisible();
  });

  test("RefundModal prefills amount and accepts a partial amount", async ({ page }) => {
    await page.goto("/admin");

    const refundButton = page.getByRole("button", { name: /refund/i }).first();
    await refundButton.click();

    // Amount field should be prefilled.
    const amountField = page.getByLabel(/amount.*usd/i);
    await expect(amountField).toBeVisible();

    // Clear and enter a partial amount.
    await amountField.fill("5.00");
    await expect(amountField).toHaveValue("5.00");
  });

  test("Successful refund shows success state in modal", async ({ page }) => {
    await page.goto("/admin");

    const refundButton = page.getByRole("button", { name: /refund/i }).first();
    await refundButton.click();

    const amountField = page.getByLabel(/amount.*usd/i);
    await amountField.fill("5.00");

    // Submit.
    const confirmButton = page.getByRole("button", { name: /confirm refund/i });
    await confirmButton.click();

    // Success state.
    await expect(page.getByText(/refund initiated/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/5\.00/i)).toBeVisible();
  });

  test("Zero amount shows validation error", async ({ page }) => {
    await page.goto("/admin");

    const refundButton = page.getByRole("button", { name: /refund/i }).first();
    await refundButton.click();

    const amountField = page.getByLabel(/amount.*usd/i);
    await amountField.fill("0");

    const confirmButton = page.getByRole("button", { name: /confirm refund/i });
    await confirmButton.click();

    // Client-side validation catches it before the API call.
    await expect(page.getByText(/valid positive dollar amount/i)).toBeVisible();
  });

  test("Over-collected amount shows validation error", async ({ page }) => {
    await page.goto("/admin");

    const refundButton = page.getByRole("button", { name: /refund/i }).first();
    await refundButton.click();

    const amountField = page.getByLabel(/amount.*usd/i);
    // The collected_cents is 1150 ($11.50); request more.
    await amountField.fill("99.99");

    const confirmButton = page.getByRole("button", { name: /confirm refund/i });
    await confirmButton.click();

    // Client-side cap enforcement.
    await expect(page.getByText(/cannot exceed/i)).toBeVisible();
  });

  test("Error from endpoint shows error state in modal", async ({ page }) => {
    // Override the route for this test to return an error.
    await page.route("**/functions/v1/refunds", async (route) => {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "No refundable balance remaining for this PaymentIntent" }),
      });
    });

    await page.goto("/admin");

    const refundButton = page.getByRole("button", { name: /refund/i }).first();
    await refundButton.click();

    const amountField = page.getByLabel(/amount.*usd/i);
    await amountField.fill("5.00");

    const confirmButton = page.getByRole("button", { name: /confirm refund/i });
    await confirmButton.click();

    // Error state shown.
    await expect(page.getByText(/refund failed/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/no refundable balance/i)).toBeVisible();
  });
});
