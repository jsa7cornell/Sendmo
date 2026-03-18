import { test, expect } from '@playwright/test';
import * as fs from 'fs';

test('Test buying a label on the existing local host', async ({ page }) => {
    // Collect console logs and network response errors
    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('response', async res => {
        if (!res.ok()) {
            console.log(`FAILED RESP [${res.status()}] ${res.url()}`);
            console.log('REASON: ', await res.text());
        }
    });

    await page.goto('http://localhost:5173/label-test');
    
    await page.getByRole('button', { name: "Pre-fill Test Data" }).click();
    await page.getByRole('button', { name: "Get Rates" }).click();
    
    await expect(page.getByText('Package Details')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: "Pre-fill Test Data" }).click();
    
    const getRatesBtns = await page.getByRole('button', { name: "See Rates" });
    if(await getRatesBtns.isVisible()){
        await getRatesBtns.click();
    } else {
        await page.getByRole('button', { name: "Get Rates" }).last().click();
    }

    await page.waitForTimeout(4000); 
    const selectButtons = await page.getByRole('button', { name: "Select" });
    await selectButtons.first().click();

    await page.waitForTimeout(5000); 
    await expect(page.getByText('Label Ready!')).toBeVisible({ timeout: 10000 });
});
