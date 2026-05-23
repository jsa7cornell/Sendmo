/**
 * E2E test: admin opens the Reconciliation tab, sees the summary populated,
 * and clicks a Needs-Attention action (recharge / absorb / dispute).
 *
 * Pattern: mocked Edge Functions via page.route (no real DB/Stripe/EasyPost).
 * The mock feeds realistic fixture data matching the Net-margin identity.
 *
 * Cross-link: H4 — decided proposal
 *   proposals/2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_
 *   decided-2026-05-22.md §2.5 (admin dashboard), N3 (dispute-window countdown).
 * PLAYBOOK Rule 19 — browser-verified spec for the Reconciliation tab.
 */

import { test, expect, type Page } from "@playwright/test";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const RECON_REPORT_FIXTURE = {
  summary: {
    total_count: 3,
    reconciled_count: 2,
    needs_attention_count: 1,
    net_margin_cents: 200,
    carrier_adjustments_total_cents: 1420,
    refunds_in_flight_cents: 0,
    chargebacks_count: 0,
    easypost_wallet_balance_cents: 12263,
    period: { start_date: "2026-05-01", end_date: "2026-05-23" },
    last_run_at: new Date().toISOString(),
  },
  needs_attention: [
    {
      type: "carrier_adjustment",
      shipment_id: "ship-adj-001",
      shipment_public: "SM-SHIP",
      carrier: "USPS",
      carrier_adjustment_id: "adj-uuid-001",
      delta_cents: 1420,
      reason: "reweigh",
      claimed_weight_oz: 16,
      captured_weight_oz: 50,
      days_until_dispute_deadline: 45,
      deadline_past: false,
    },
  ],
  rows: [
    {
      shipment_id: "ship-001",
      shipment_public: "SM-ABCD",
      easypost_shipment_id: "shp_abc",
      carrier: "USPS",
      service: "Ground Advantage",
      tracking_number: "9400111899",
      label_url: null,
      is_test: false,
      is_live: true,
      payment_method: "card",
      link_short_code: "LINK1",
      link_type: "full_label",
      label_created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      shipped_at: null,
      delivered_at: null,
      cancelled_at: null,
      paid_cents: 910,
      stripe_fee_cents: -56,
      refunded_to_customer_cents: 0,
      adjustment_collected_cents: 0,
      chargeback_cents: 0,
      label_cost_cents: -710,
      easypost_refund_cents: 0,
      adjustment_charged_cents: 0,
      net_margin_cents: 144,
      shipment_status: "in_transit",
      refund_status: "none",
      easypost_refund_status: null,
      recon_status: "reconciled",
      carrier_adjustments: [],
      transactions: [],
      stripe_payment_intent_id: "pi_test",
    },
    {
      shipment_id: "ship-adj-001",
      shipment_public: "SM-SHIP",
      easypost_shipment_id: "shp_xyz",
      carrier: "USPS",
      service: "Ground Advantage",
      tracking_number: "9400222888",
      label_url: null,
      is_test: false,
      is_live: true,
      payment_method: "card",
      link_short_code: "LINK2",
      link_type: "full_label",
      label_created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      shipped_at: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
      delivered_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      cancelled_at: null,
      paid_cents: 940,
      stripe_fee_cents: -57,
      refunded_to_customer_cents: 0,
      adjustment_collected_cents: 0, // pending review
      chargeback_cents: 0,
      label_cost_cents: -730,
      easypost_refund_cents: 0,
      adjustment_charged_cents: -1420,
      net_margin_cents: -1267,
      shipment_status: "delivered",
      refund_status: "none",
      easypost_refund_status: null,
      recon_status: "adjustment_review",
      carrier_adjustments: [
        {
          id: "adj-uuid-001",
          delta_cents: 1420,
          reason: "reweigh",
          claimed_weight_oz: 16,
          captured_weight_oz: 50,
          recovery_status: "pending",
          created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
          resolved_at: null,
          days_until_dispute_deadline: 45,
        },
      ],
      transactions: [],
      stripe_payment_intent_id: "pi_test2",
    },
    {
      shipment_id: "ship-comp-001",
      shipment_public: "SM-COMP",
      easypost_shipment_id: "shp_comp",
      carrier: "USPS",
      service: "Ground Advantage",
      tracking_number: null,
      label_url: null,
      is_test: false,
      is_live: true,
      payment_method: "comp",
      link_short_code: null,
      link_type: "full_label",
      label_created_at: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
      shipped_at: null,
      delivered_at: null,
      cancelled_at: null,
      paid_cents: 0,
      stripe_fee_cents: 0,
      refunded_to_customer_cents: 0,
      adjustment_collected_cents: 0,
      chargeback_cents: 0,
      label_cost_cents: -1129,
      easypost_refund_cents: 0,
      adjustment_charged_cents: 0,
      net_margin_cents: -1129,
      shipment_status: "label_created",
      refund_status: "none",
      easypost_refund_status: null,
      recon_status: "reconciled",
      carrier_adjustments: [],
      transactions: [],
      stripe_payment_intent_id: null,
    },
  ],
};

const ABSORB_ACTION_FIXTURE = {
  ok: true,
  action: "absorb",
  carrier_adjustment: {
    id: "adj-uuid-001",
    recovery_status: "absorbed",
    resolved_at: new Date().toISOString(),
  },
};

const DISPUTE_ACTION_FIXTURE = {
  ok: true,
  action: "dispute",
  carrier_adjustment: {
    id: "adj-uuid-001",
    recovery_status: "disputed",
    resolved_at: new Date().toISOString(),
  },
};

// ─── Mock helpers ──────────────────────────────────────────────────────────────

function mockAdminReport(page: Page) {
  return page.route("**/functions/v1/admin-report**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mode: "live", data: [] }),
    });
  });
}

function mockReconReport(page: Page, fixture = RECON_REPORT_FIXTURE) {
  return page.route("**/functions/v1/reconciliation-report**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixture),
    });
  });
}

function mockReconAction(page: Page, fixture: object = ABSORB_ACTION_FIXTURE) {
  return page.route("**/functions/v1/admin-recon-action**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixture),
    });
  });
}

function mockSweep(page: Page) {
  return page.route("**/functions/v1/reconciliation-sweep**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, mode: "daily", mismatches: 0, recovery_re_fires: 0 }),
    });
  });
}

// Mock Supabase auth so the page renders as admin.
function mockSupabaseAuth(page: Page) {
  return page.route("**/auth/v1/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: "mock-admin-token",
        user: { id: "admin-user-id", email: "admin@sendmo.co", role: "authenticated" },
      }),
    });
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe("Admin — Reconciliation tab", () => {
  test("Reconciliation tab is present in the admin nav", async ({ page }) => {
    await mockAdminReport(page);
    await mockReconReport(page);
    await mockSweep(page);

    // Navigate to the admin page and go directly to the reconciliation tab.
    await page.goto("http://localhost:5173/admin?tab=reconciliation");

    // Wait for the page to load enough to check for the tab.
    await page.waitForLoadState("domcontentloaded");

    // The Reconciliation tab button should be visible.
    const reconTab = page.getByRole("button", { name: /Reconciliation/i });
    await expect(reconTab).toBeVisible({ timeout: 10_000 });
  });

  test("Reconciliation tab renders summary cards when data is loaded", async ({ page }) => {
    await mockAdminReport(page);
    await mockReconReport(page);
    await mockSweep(page);

    await page.goto("http://localhost:5173/admin?tab=reconciliation");
    await page.waitForLoadState("domcontentloaded");

    // Click the Reconciliation tab.
    const reconTab = page.getByRole("button", { name: /Reconciliation/i });
    await reconTab.click();

    // Summary card: Reconciled count.
    await expect(page.getByText("2 / 3")).toBeVisible({ timeout: 15_000 });

    // Summary card: EasyPost wallet (mocked as $122.63).
    await expect(page.getByText("$122.63")).toBeVisible();
  });

  test("Needs-Attention panel shows the carrier adjustment item", async ({ page }) => {
    await mockAdminReport(page);
    await mockReconReport(page);
    await mockSweep(page);

    await page.goto("http://localhost:5173/admin?tab=reconciliation");
    await page.waitForLoadState("domcontentloaded");
    const reconTab = page.getByRole("button", { name: /Reconciliation/i });
    await reconTab.click();

    // Needs-Attention panel.
    await expect(page.getByText("Needs attention")).toBeVisible({ timeout: 15_000 });

    // The carrier adjustment item.
    await expect(page.getByText(/Carrier adjustment over \$10/i)).toBeVisible();

    // Dispute window countdown.
    await expect(page.getByText(/45 days remaining/i)).toBeVisible();

    // Action buttons.
    await expect(page.getByRole("button", { name: /Dispute/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Re-charge customer/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Absorb/i })).toBeVisible();
  });

  test("Absorb action fires and shows success message", async ({ page }) => {
    await mockAdminReport(page);
    await mockReconReport(page);
    await mockSweep(page);
    await mockReconAction(page, ABSORB_ACTION_FIXTURE);

    await page.goto("http://localhost:5173/admin?tab=reconciliation");
    await page.waitForLoadState("domcontentloaded");
    const reconTab = page.getByRole("button", { name: /Reconciliation/i });
    await reconTab.click();

    // Wait for Needs-Attention panel.
    await expect(page.getByText(/Carrier adjustment over \$10/i)).toBeVisible({ timeout: 15_000 });

    // Click Absorb.
    const absorbBtn = page.getByRole("button", { name: /Absorb/i });
    await absorbBtn.click();

    // Success message.
    await expect(page.getByText(/Action "absorb" applied/i)).toBeVisible({ timeout: 10_000 });
  });

  test("Dispute action fires and shows success message", async ({ page }) => {
    await mockAdminReport(page);
    await mockReconReport(page);
    await mockSweep(page);
    await mockReconAction(page, DISPUTE_ACTION_FIXTURE);

    await page.goto("http://localhost:5173/admin?tab=reconciliation");
    await page.waitForLoadState("domcontentloaded");
    const reconTab = page.getByRole("button", { name: /Reconciliation/i });
    await reconTab.click();

    await expect(page.getByText(/Carrier adjustment over \$10/i)).toBeVisible({ timeout: 15_000 });

    const disputeBtn = page.getByRole("button", { name: /Dispute/i });
    await disputeBtn.click();

    await expect(page.getByText(/Action "dispute" applied/i)).toBeVisible({ timeout: 10_000 });
  });

  test("Full shipment table renders with COMP badge", async ({ page }) => {
    await mockAdminReport(page);
    await mockReconReport(page);
    await mockSweep(page);

    await page.goto("http://localhost:5173/admin?tab=reconciliation");
    await page.waitForLoadState("domcontentloaded");
    const reconTab = page.getByRole("button", { name: /Reconciliation/i });
    await reconTab.click();

    // "All shipments" table header.
    await expect(page.getByText("All shipments — every money movement")).toBeVisible({ timeout: 15_000 });

    // COMP badge on the comp shipment.
    await expect(page.getByText("COMP")).toBeVisible();

    // Shipment IDs in the table.
    await expect(page.getByText("SM-ABCD")).toBeVisible();
  });

  test("Net-margin identity legend is visible on the page", async ({ page }) => {
    await mockAdminReport(page);
    await mockReconReport(page);
    await mockSweep(page);

    await page.goto("http://localhost:5173/admin?tab=reconciliation");
    await page.waitForLoadState("domcontentloaded");
    const reconTab = page.getByRole("button", { name: /Reconciliation/i });
    await reconTab.click();

    // The legend must be present (from the mockup — preserved in the React port).
    await expect(page.getByText(/The reconcile identity/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Paid − Stripe fee/i)).toBeVisible();
    await expect(page.getByText(/Net margin/)).toBeVisible();
  });

  test("Run reconciliation now button triggers the sweep", async ({ page }) => {
    await mockAdminReport(page);
    await mockReconReport(page);
    await mockSweep(page);

    await page.goto("http://localhost:5173/admin?tab=reconciliation");
    await page.waitForLoadState("domcontentloaded");
    const reconTab = page.getByRole("button", { name: /Reconciliation/i });
    await reconTab.click();

    await expect(page.getByRole("button", { name: /Run reconciliation now/i })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: /Run reconciliation now/i }).click();

    // After sweep completes (mocked instantly), shows result.
    await expect(page.getByText(/Sweep complete/i)).toBeVisible({ timeout: 10_000 });
  });
});
