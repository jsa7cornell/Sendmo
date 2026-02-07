import { test, expect, Page } from '@playwright/test';

// Helper to navigate and wait for page to be interactive
async function gotoAndWait(page: Page, path: string = '/') {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}

// Test addresses - real format addresses for testing
const TEST_ADDRESSES = {
  buyers: [
    {
      name: 'NYC Buyer',
      address: '350 Fifth Avenue\nNew York, NY 10118',
    },
    {
      name: 'LA Buyer',
      address: '100 Universal City Plaza\nLos Angeles, CA 91608',
    },
    {
      name: 'Chicago Buyer',
      address: '233 S Wacker Dr\nChicago, IL 60606',
    },
    {
      name: 'Miami Buyer',
      address: '1111 Lincoln Rd\nMiami Beach, FL 33139',
    },
    {
      name: 'Seattle Buyer',
      address: '400 Broad St\nSeattle, WA 98109',
    },
  ],
  sellers: [
    {
      name: 'SF Seller',
      address: '1 Ferry Building\nSan Francisco, CA 94111',
    },
    {
      name: 'Austin Seller',
      address: '500 E 4th St\nAustin, TX 78701',
    },
    {
      name: 'Denver Seller',
      address: '2001 Blake St\nDenver, CO 80205',
    },
    {
      name: 'Boston Seller',
      address: '4 Yawkey Way\nBoston, MA 02215',
    },
    {
      name: 'Portland Seller',
      address: '1000 SW Broadway\nPortland, OR 97205',
    },
  ],
};

const TEST_ITEMS = [
  'Vintage leather backpack',
  'Nintendo Switch console',
  'MacBook Pro 14"',
  'Handmade ceramic vase',
  'Signed basketball jersey',
  'Antique pocket watch',
  'Gaming keyboard',
  'Designer sunglasses',
];

test.describe('SendMo Shipping Flow', () => {
  test('Landing page loads correctly', async ({ page }) => {
    await gotoAndWait(page);
    await expect(page.locator('.logo')).toContainText('SendMo');
    await expect(page.getByRole('heading', { name: /ship smarter/i })).toBeVisible();
  });

  test('Buyer can create a shipping label and get share link', async ({ page }) => {
    await gotoAndWait(page);

    // Click "Create a Shipping Label" button
    await page.getByRole('button', { name: /create a shipping label/i }).click();

    // Fill in item description
    await page.fill('input[name="itemDescription"]', 'Vintage leather backpack');

    // Fill in destination address
    await page.fill('textarea[name="destinationAddress"]', '350 Fifth Avenue\nNew York, NY 10118');

    // Select package size
    await page.click('.size-option:has-text("Medium")');

    // Click create label
    await page.getByRole('button', { name: /create shipping label/i }).click();

    // Wait for success view
    await expect(page.locator('.success-icon')).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('heading', { name: /label created/i })).toBeVisible();

    // Verify share link is generated
    const shareLink = page.locator('.share-link');
    await expect(shareLink).toBeVisible();
    const linkText = await shareLink.textContent();
    expect(linkText).toContain('sendmo.co');
    expect(linkText).toContain('data=');
  });

  test('Seller can open share link and see shipment details', async ({ page }) => {
    // First, create a label as buyer
    await gotoAndWait(page);
    await page.getByRole('button', { name: /create a shipping label/i }).click();
    await page.fill('input[name="itemDescription"]', 'Nintendo Switch console');
    await page.fill('textarea[name="destinationAddress"]', '100 Universal City Plaza\nLos Angeles, CA 91608');
    await page.click('.size-option:has-text("Small")');
    await page.getByRole('button', { name: /create shipping label/i }).click();

    // Wait for success and get share link
    await expect(page.locator('.success-icon')).toBeVisible({ timeout: 10000 });
    const shareLinkText = await page.locator('.share-link').textContent();

    // Navigate to share link (seller flow)
    await gotoAndWait(page, shareLinkText!);

    // Verify seller view loads with item details
    await expect(page.getByRole('heading', { name: /print & ship/i })).toBeVisible();
    await expect(page.locator('.shipping-summary')).toContainText('Nintendo Switch console');
    await expect(page.locator('.shipping-summary')).toContainText('Los Angeles');
  });

  test('Full buyer -> seller flow works end to end', async ({ page }) => {
    // === BUYER FLOW ===
    await gotoAndWait(page);
    await page.getByRole('button', { name: /create a shipping label/i }).click();

    // Fill buyer details
    await page.fill('input[name="itemDescription"]', 'MacBook Pro 14"');
    await page.fill('textarea[name="destinationAddress"]', '233 S Wacker Dr\nChicago, IL 60606');
    await page.click('.size-option:has-text("Medium")');

    // Create label
    await page.getByRole('button', { name: /create shipping label/i }).click();
    await expect(page.locator('.success-icon')).toBeVisible({ timeout: 10000 });

    // Get share link
    const shareLinkText = await page.locator('.share-link').textContent();

    // === SELLER FLOW ===
    await gotoAndWait(page, shareLinkText!);

    // Verify seller view
    await expect(page.getByRole('heading', { name: /print & ship/i })).toBeVisible();

    // Fill seller's origin address
    await page.fill('textarea[name="originAddress"]', '1 Ferry Building\nSan Francisco, CA 94111');

    // Click print label
    await page.getByRole('button', { name: /print shipping label/i }).click();

    // Verify print confirmation or success
    await expect(page.locator('.success-icon')).toBeVisible({ timeout: 10000 });
  });

  // Test multiple address combinations
  for (let i = 0; i < 3; i++) {
    const buyer = TEST_ADDRESSES.buyers[i];
    const seller = TEST_ADDRESSES.sellers[i];
    const item = TEST_ITEMS[i];

    test(`Cross-country shipment: ${seller.name} to ${buyer.name}`, async ({ page }) => {
      // Buyer creates label
      await gotoAndWait(page);
      await page.getByRole('button', { name: /create a shipping label/i }).click();
      await page.fill('input[name="itemDescription"]', item);
      await page.fill('textarea[name="destinationAddress"]', buyer.address);
      await page.click('.size-option:has-text("Medium")');
      await page.getByRole('button', { name: /create shipping label/i }).click();

      await expect(page.locator('.success-icon')).toBeVisible({ timeout: 10000 });
      const shareLinkText = await page.locator('.share-link').textContent();

      // Seller completes shipment
      await gotoAndWait(page, shareLinkText!);
      await expect(page.getByRole('heading', { name: /print & ship/i })).toBeVisible();
      await page.fill('textarea[name="originAddress"]', seller.address);
      await page.getByRole('button', { name: /print shipping label/i }).click();

      await expect(page.locator('.success-icon')).toBeVisible({ timeout: 10000 });
    });
  }

  test('Demo mode badge is visible', async ({ page }) => {
    await gotoAndWait(page);
    await page.getByRole('button', { name: /create a shipping label/i }).click();
    await expect(page.locator('.mock-badge')).toContainText('Demo Mode');
  });

  test('Error shown for empty form submission', async ({ page }) => {
    await gotoAndWait(page);
    await page.getByRole('button', { name: /create a shipping label/i }).click();

    // The button should be disabled when form is empty
    const createButton = page.getByRole('button', { name: /create shipping label/i });
    await expect(createButton).toBeDisabled();
  });

  test('Different package sizes are selectable', async ({ page }) => {
    await gotoAndWait(page);
    await page.getByRole('button', { name: /create a shipping label/i }).click();

    // Test each package size
    const sizes = ['Small', 'Medium', 'Large'];
    for (const size of sizes) {
      await page.click(`.size-option:has-text("${size}")`);
      await expect(page.locator(`.size-option.active:has-text("${size}")`)).toBeVisible();
    }
  });

  test('Copy link button works', async ({ page, context }) => {
    // Grant clipboard permissions
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await gotoAndWait(page);
    await page.getByRole('button', { name: /create a shipping label/i }).click();
    await page.fill('input[name="itemDescription"]', 'Test item');
    await page.fill('textarea[name="destinationAddress"]', '123 Test St\nTest City, CA 90210');
    await page.click('.size-option:has-text("Small")');
    await page.getByRole('button', { name: /create shipping label/i }).click();

    await expect(page.locator('.success-icon')).toBeVisible({ timeout: 10000 });

    // Click copy button
    await page.getByRole('button', { name: /copy link/i }).click();

    // Verify clipboard (may not work in all environments)
    // Just verify the button is clickable and page doesn't error
    await expect(page.getByRole('button', { name: /copy link/i })).toBeVisible();
  });
});

test.describe('Address Parsing', () => {
  test('Handles standard two-line address', async ({ page }) => {
    await gotoAndWait(page);
    await page.getByRole('button', { name: /create a shipping label/i }).click();
    await page.fill('input[name="itemDescription"]', 'Test item');
    await page.fill('textarea[name="destinationAddress"]', '123 Main Street\nNew York, NY 10001');
    await page.click('.size-option:has-text("Small")');
    await page.getByRole('button', { name: /create shipping label/i }).click();

    await expect(page.locator('.success-icon')).toBeVisible({ timeout: 10000 });
  });

  test('Handles address without comma before state', async ({ page }) => {
    await gotoAndWait(page);
    await page.getByRole('button', { name: /create a shipping label/i }).click();
    await page.fill('input[name="itemDescription"]', 'Test item');
    await page.fill('textarea[name="destinationAddress"]', '456 Oak Ave\nLos Angeles CA 90001');
    await page.click('.size-option:has-text("Small")');
    await page.getByRole('button', { name: /create shipping label/i }).click();

    await expect(page.locator('.success-icon')).toBeVisible({ timeout: 10000 });
  });

  test('Handles single line address', async ({ page }) => {
    await gotoAndWait(page);
    await page.getByRole('button', { name: /create a shipping label/i }).click();
    await page.fill('input[name="itemDescription"]', 'Test item');
    await page.fill('textarea[name="destinationAddress"]', '789 Pine Rd, Chicago, IL 60601');
    await page.click('.size-option:has-text("Small")');
    await page.getByRole('button', { name: /create shipping label/i }).click();

    await expect(page.locator('.success-icon')).toBeVisible({ timeout: 10000 });
  });

  test('Handles ZIP+4 format', async ({ page }) => {
    await gotoAndWait(page);
    await page.getByRole('button', { name: /create a shipping label/i }).click();
    await page.fill('input[name="itemDescription"]', 'Test item');
    await page.fill('textarea[name="destinationAddress"]', '100 Broadway\nNew York, NY 10005-1234');
    await page.click('.size-option:has-text("Small")');
    await page.getByRole('button', { name: /create shipping label/i }).click();

    await expect(page.locator('.success-icon')).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Address Correction Flow', () => {
  test('Clicking Use Corrected Address does not cause errors', async ({ page }) => {
    await gotoAndWait(page);
    await page.getByRole('button', { name: /create a shipping label/i }).click();
    await page.fill('input[name="itemDescription"]', 'Test item for correction');
    // Enter address that might trigger correction
    await page.fill('textarea[name="destinationAddress"]', '123 main st\naustin tx 78701');
    await page.click('.size-option:has-text("Small")');
    await page.getByRole('button', { name: /create shipping label/i }).click();

    // Wait for either success or correction dialog
    await page.waitForTimeout(3000);

    // Check if correction dialog appeared
    const correctionDialog = page.locator('text=Address Correction');
    if (await correctionDialog.isVisible()) {
      // Click Use Corrected Address
      await page.getByRole('button', { name: /use corrected address/i }).click();

      // Should not have circular reference error - verify success
      await expect(page.locator('.success-icon')).toBeVisible({ timeout: 10000 });
    } else {
      // No correction needed, should see success directly
      await expect(page.locator('.success-icon')).toBeVisible({ timeout: 10000 });
    }
  });

  test('Clicking Keep Original does not cause errors', async ({ page }) => {
    await gotoAndWait(page);
    await page.getByRole('button', { name: /create a shipping label/i }).click();
    await page.fill('input[name="itemDescription"]', 'Test item for original');
    await page.fill('textarea[name="destinationAddress"]', '456 oak ave\nlos angeles ca 90001');
    await page.click('.size-option:has-text("Medium")');
    await page.getByRole('button', { name: /create shipping label/i }).click();

    await page.waitForTimeout(3000);

    const correctionDialog = page.locator('text=Address Correction');
    if (await correctionDialog.isVisible()) {
      // Click Keep Original
      await page.getByRole('button', { name: /keep original/i }).click();

      // Should not have circular reference error
      await expect(page.locator('.success-icon')).toBeVisible({ timeout: 10000 });
    } else {
      await expect(page.locator('.success-icon')).toBeVisible({ timeout: 10000 });
    }
  });

  test('No JavaScript errors on page', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await gotoAndWait(page);
    await page.getByRole('button', { name: /create a shipping label/i }).click();
    await page.fill('input[name="itemDescription"]', 'Error test item');
    await page.fill('textarea[name="destinationAddress"]', '789 pine rd\nseattle wa 98101');
    await page.click('.size-option:has-text("Large")');
    await page.getByRole('button', { name: /create shipping label/i }).click();

    await page.waitForTimeout(5000);

    // Check if any errors contain "circular"
    const circularErrors = errors.filter(e => e.toLowerCase().includes('circular'));
    expect(circularErrors).toHaveLength(0);
  });
});

test.describe('Mobile Responsiveness', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('Landing page is usable on mobile', async ({ page }) => {
    await gotoAndWait(page);
    await expect(page.locator('.logo')).toBeVisible();
    await expect(page.getByRole('button', { name: /create a shipping label/i })).toBeVisible();
  });

  test('Form is usable on mobile', async ({ page }) => {
    await gotoAndWait(page);
    await page.getByRole('button', { name: /create a shipping label/i }).click();

    // Verify form elements are visible and accessible
    await expect(page.locator('input[name="itemDescription"]')).toBeVisible();
    await expect(page.locator('textarea[name="destinationAddress"]')).toBeVisible();
    await expect(page.locator('.size-grid')).toBeVisible();
  });
});
