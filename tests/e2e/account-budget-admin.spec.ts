import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";

// ─── E2E: /admin Account-Budget setter ──────────────────────────────────────
//
// The minimal Admin UI shipped 2026-05-22 (commit dbf2254) for the
// set_account_budget RPC. This spec verifies the wiring:
//   - The collapsible panel renders for admins.
//   - Submitting valid input calls supabase.rpc("set_account_budget", …) and
//     renders the success message.
//   - A non-2xx RPC response surfaces the server error in the form.
//
// What this spec does NOT verify:
//   - The RPC's admin-role gating (covered by migration 031's SECURITY DEFINER
//     + role check; structurally verified by the DB-side review).
//   - Server-side budget enforcement (covered by tests/unit/budget.test.ts and
//     deferred integration / real-service e2e — see the
//     proposals/2026-05-22_payments-risk-intel-followups-handoff.md handoff).
//
// Authed harness: requires playwright/.auth/user.json (minted by
// global-setup.ts when E2E_TEST_USER_* are set). The test user is NOT actually
// an admin in the DB — we mock /rest/v1/profiles* to return role='admin' so
// AuthContext.ensureProfile resolves isAdmin=true and the page renders.
// This is the same mock-the-DB pattern admin.spec.ts noted as the coverage
// path forward.

const SUPABASE_URL = "https://fkxykvzsqdjzhurntgah.supabase.co";
const AUTH_FILE = "playwright/.auth/user.json";
const hasAuthState = existsSync(AUTH_FILE);

const TARGET_UUID = "22222222-2222-2222-2222-222222222222";

// PostgREST returns a single object when the client uses .single()/.maybeSingle()
// (Accept: application/vnd.pgrst.object+json) and an array otherwise. Mock both.
function profilesMockBody(req: { headers(): Record<string, string> }) {
    const accept = req.headers().accept ?? "";
    const obj = {
        id: "00000000-0000-0000-0000-000000000000",
        email: "e2e-admin@example.com",
        full_name: "E2E Admin",
        role: "admin",
        admin_active_mode: "test",
        stripe_customer_id_test: null,
        stripe_customer_id_live: null,
        daily_budget_cents: 20000,
        weekly_budget_cents: 50000,
    };
    return accept.includes("vnd.pgrst.object") ? JSON.stringify(obj) : JSON.stringify([obj]);
}

async function mockAdminContext(page: Page) {
    // The profile fetch — make the seeded test user look like an admin so
    // AuthContext.isAdmin = true and the page renders past the gate.
    await page.route(`${SUPABASE_URL}/rest/v1/profiles*`, (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: profilesMockBody(route.request()),
        }),
    );
    // Admin report — inert; we're not testing the reporting table.
    await page.route(`${SUPABASE_URL}/functions/v1/admin-report*`, (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ data: [] }),
        }),
    );
    // Other REST tables the page might touch — empty arrays.
    await page.route(`${SUPABASE_URL}/rest/v1/payment_methods*`, (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
    );
}

const describeOrSkip = hasAuthState ? test.describe : test.describe.skip;

describeOrSkip("admin — Set Account Budget UI", () => {
    test.use({ storageState: AUTH_FILE });

    test("expands the panel + submits a valid budget → success message", async ({ page }) => {
        await mockAdminContext(page);

        // RPC mock — return success (PostgREST 204 No Content for VOID-returning RPCs;
        // a 200 with null body also works for our error-shape consumer).
        await page.route(`${SUPABASE_URL}/rest/v1/rpc/set_account_budget`, (route) =>
            route.fulfill({ status: 204, body: "" }),
        );

        await page.goto("/admin");

        // The admin page renders past the gate (no "Admin access required").
        await expect(page.getByRole("heading", { name: /Admin/i }).first()).toBeVisible({ timeout: 10000 });
        await expect(page.getByText(/Admin access required/i)).not.toBeVisible();

        // The Account Budget panel exists and is collapsed by default.
        const summary = page.getByText("Set Account Budget", { exact: true });
        await expect(summary).toBeVisible();
        await summary.click();

        // Form is now visible; fill it.
        await page.getByLabel(/target_user_id/i).fill(TARGET_UUID);
        await page.getByLabel(/^daily/i).fill("250");
        await page.getByLabel(/^weekly/i).fill("600");

        // Submit and assert success.
        await page.getByRole("button", { name: /^Set$/ }).click();
        await expect(page.getByText(/Set \$250\.00\/day · \$600\.00\/week/)).toBeVisible({ timeout: 5000 });
    });

    test("server error from the RPC surfaces in the form", async ({ page }) => {
        await mockAdminContext(page);

        // RPC mock — return a PostgREST-shaped error.
        await page.route(`${SUPABASE_URL}/rest/v1/rpc/set_account_budget`, (route) =>
            route.fulfill({
                status: 400,
                contentType: "application/json",
                body: JSON.stringify({
                    code: "P0001",
                    message: "Budget value exceeds the sane maximum ($1,000,000)",
                    details: null,
                    hint: null,
                }),
            }),
        );

        await page.goto("/admin");
        await expect(page.getByRole("heading", { name: /Admin/i }).first()).toBeVisible({ timeout: 10000 });
        await page.getByText("Set Account Budget", { exact: true }).click();
        await page.getByLabel(/target_user_id/i).fill(TARGET_UUID);
        await page.getByLabel(/^daily/i).fill("99999999");
        await page.getByLabel(/^weekly/i).fill("99999999");

        await page.getByRole("button", { name: /^Set$/ }).click();
        await expect(
            page.getByText(/Budget value exceeds the sane maximum/i),
        ).toBeVisible({ timeout: 5000 });
    });

    test("client-side validation blocks submission with a missing user_id", async ({ page }) => {
        await mockAdminContext(page);
        // RPC mock — should NOT be called when client validation fails.
        let rpcCalled = false;
        await page.route(`${SUPABASE_URL}/rest/v1/rpc/set_account_budget`, (route) => {
            rpcCalled = true;
            route.fulfill({ status: 204, body: "" });
        });

        await page.goto("/admin");
        await expect(page.getByRole("heading", { name: /Admin/i }).first()).toBeVisible({ timeout: 10000 });
        await page.getByText("Set Account Budget", { exact: true }).click();
        // Leave target_user_id blank.
        await page.getByLabel(/^daily/i).fill("200");
        await page.getByLabel(/^weekly/i).fill("500");

        await page.getByRole("button", { name: /^Set$/ }).click();
        await expect(page.getByText(/Need a target_user_id/i)).toBeVisible({ timeout: 5000 });
        expect(rpcCalled).toBe(false);
    });
});
