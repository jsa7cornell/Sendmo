import { test, expect } from '@playwright/test';

test.describe('Label Test Flow', () => {
    test.beforeEach(async ({ page }) => {
        // Navigate to the Label Test route
        await page.goto('/label-test');
    });

    test('completes full rate checking flow with prefilled data', async ({ page }) => {
        // 1. Addresses Step
        await expect(page.locator('h1')).toHaveText('Label Test');
        await expect(page.locator('h2').first()).toHaveText('Addresses');

        // Use pre-fill button to populate fields
        await page.getByRole('button', { name: 'Pre-fill Test Data' }).click();

        // Verify a field is filled
        await expect(page.locator('#From-name')).toHaveValue('SendMo HQ');

        // Hit Get Rates (Address Verification)
        await page.getByRole('button', { name: 'Get Rates' }).click();

        // 2. Package Details Step
        // Wait for the next step UI to appear
        await expect(page.locator('h2').first()).toHaveText('Package Details');

        // Pre-fill dimensions
        await page.getByRole('button', { name: 'Pre-fill Test Data' }).click();
        await expect(page.locator('#length')).toHaveValue('10');

        // Hit See Rates
        await page.getByRole('button', { name: 'See Rates' }).click();

        // 3. Selection Step
        await expect(page.locator('h2').first()).toHaveText('Select a Rate');

        // Ensure we get at least one rate back
        // (Testing that the actual edge function worked against EasyPost)
        const rateCards = page.locator('.border-border').or(page.locator('.border-primary'));
        await rateCards.first().waitFor();
        const count = await rateCards.count();
        expect(count).toBeGreaterThan(0);

        // Select the first rate
        await page.getByRole('button', { name: 'Select' }).first().click();

        // 4. Label Ready Step
        await expect(page.locator('h2').first()).toHaveText('Label Ready!');
        await expect(page.getByText('Tracking Number')).toBeVisible();
        await expect(page.getByRole('button', { name: 'View Label' })).toBeVisible();
    });

    test('allows manual address entry', async ({ page }) => {
        // Fill From Address
        await page.locator('#From-name').fill('Alice Tester');
        await page.locator('#From-street').fill('1000 Wilshire Blvd');
        await page.locator('#From-city').fill('Los Angeles');
        await page.locator('#From-state').fill('CA');
        await page.locator('#From-zip').fill('90017');

        // Verify fields retain value (catches the earlier bug)
        await expect(page.locator('#From-name')).toHaveValue('Alice Tester');

        // Fill To Address
        await page.locator('#To-name').fill('Bob Tester');
        await page.locator('#To-street').fill('301 W 2nd St');
        await page.locator('#To-city').fill('Austin');
        await page.locator('#To-state').fill('TX');
        await page.locator('#To-zip').fill('78701');

        await expect(page.locator('#To-name')).toHaveValue('Bob Tester');
    });
});
