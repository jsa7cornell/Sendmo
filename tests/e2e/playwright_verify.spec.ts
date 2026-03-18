import { test, expect } from '@playwright/test';

test('Label Test Flow creates admin DB entry', async ({ page }) => {
    // Navigate to LabelTest page
    await page.goto('http://localhost:5173/label-test');

    // Fill out the from address
    await page.fill('input[id*="name"]', 'Playwright Tester');

    // Click the pre-fill buttons
    await page.getByRole('button', { name: "Pre-fill Test Data" }).click();

    // Click Get Rates
    await page.getByRole('button', { name: "Get Rates" }).click();

    // Wait for the package details to appear and click See Rates
    await expect(page.getByText('Package Details')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: "Pre-fill Test Data" }).click();
    await page.getByRole('button', { name: "See Rates" }).click();

    // Wait for rates to appear and click the first Select button
    await page.waitForTimeout(4000); // Rates pull takes long
    const selectButtons = await page.getByRole('button', { name: "Select" });
    await selectButtons.first().click();

    // Wait for the tracking number and label to be ready
    await page.waitForTimeout(3000); // Buying label takes a bit
    await expect(page.getByText('Label Ready!')).toBeVisible();

    const trackingText = await page.locator('.font-mono.text-2xl').innerText();
    console.log("Tracking number assigned:", trackingText);

    // Now verify it landed in the admin dashboard
    await page.goto('http://localhost:5173/admin');

    // Switch to ALL or TEST
    await page.getByRole('button', { name: 'test', exact: true }).click();

    // Increase timeout since admin-report fetch could be slow
    await expect(page.getByText('Loading report data...')).toBeHidden({ timeout: 15000 });

    // Print out everything in the table body to debug
    const tableText = await page.locator('tbody').innerText();
    console.log("Table contents after load:", tableText);

    // We should see the tracking number somewhere on the table
    await expect(page.getByText(trackingText)).toBeVisible({ timeout: 15000 });
});
