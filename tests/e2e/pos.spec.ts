import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

test('cashier can complete a sale and see the receipt preview', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('.shell')).toHaveAttribute('data-ready', 'true');
	await expect(page.getByTestId('product-grid')).toBeVisible();

	await page.locator('button[aria-label="Add Arabica Beans 1kg"]').click();
	await page.locator('button[aria-label="Add Whole Milk 1L"]').click();
	await page.locator('button[aria-label="Add Chocolate Croissant"]').click();

	await expect(page.getByTestId('cart-count')).toHaveText('3 items');
	await page.getByLabel('Cash received').fill('40');
	await page.getByRole('button', { name: 'Complete sale' }).click();

	await expect(page.getByTestId('receipt-preview')).toContainText('Receipt issued');
	await expect(page.getByTestId('receipt-preview')).toContainText('SALE-');

	const screenshotPath = resolve('artifacts/step1-receipt-preview.png');
	mkdirSync(dirname(screenshotPath), { recursive: true });
	await page.getByTestId('receipt-preview').screenshot({ path: screenshotPath });
});
