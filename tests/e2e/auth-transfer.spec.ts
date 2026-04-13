import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from '@playwright/test';

const RESET_SQL = `
	DELETE FROM transaction_items;
	DELETE FROM transactions;
	DELETE FROM transfer_items;
	DELETE FROM transfers;
	DELETE FROM stock_movements;
	UPDATE store_stock
	SET stock_quantity = CASE
		WHEN store_id = 'store-hq' AND product_id = 'prod-arabica-1kg' THEN 18
		WHEN store_id = 'store-hq' AND product_id = 'prod-milk-1l' THEN 32
		WHEN store_id = 'store-hq' AND product_id = 'prod-croissant' THEN 20
		WHEN store_id = 'store-hq' AND product_id = 'prod-water' THEN 28
		WHEN store_id = 'store-hq' AND product_id = 'prod-muffin' THEN 14
		WHEN store_id = 'store-hq' AND product_id = 'prod-juice' THEN 11
		WHEN store_id = 'store-downtown' AND product_id = 'prod-arabica-1kg' THEN 7
		WHEN store_id = 'store-downtown' AND product_id = 'prod-milk-1l' THEN 14
		WHEN store_id = 'store-downtown' AND product_id = 'prod-croissant' THEN 9
		WHEN store_id = 'store-downtown' AND product_id = 'prod-water' THEN 6
		WHEN store_id = 'store-downtown' AND product_id = 'prod-muffin' THEN 5
		WHEN store_id = 'store-downtown' AND product_id = 'prod-juice' THEN 4
		ELSE stock_quantity
	END,
	updated_at = '2026-04-10T00:00:00.000Z';
`;

test('cashier is denied inventory access and manager/admin complete transfer approval flow', async ({
	page
}) => {
	resetLocalD1();

	await loginAs(page, 'cashier@nextpos.test', 'Cashier#123');
	await page.goto('/inventory/stock-take');
	await expect(page.getByText('Request blocked')).toBeVisible();

	const deniedScreenshot = resolve('artifacts/step4-permission-denied.png');
	ensureDirectory(deniedScreenshot);
	await page.screenshot({ path: deniedScreenshot });

	await clearSession(page);
	await loginAs(page, 'manager@nextpos.test', 'Manager#123');
	await page.goto('/transfers');
	await expect(page.locator('.shell')).toHaveAttribute('data-ready', 'true');
	const transferForm = page.getByTestId('transfer-form-panel');
	await transferForm.getByLabel('Transfer product').selectOption('prod-water');
	await transferForm.getByLabel('Destination store').selectOption('store-downtown');
	await transferForm.getByLabel('Transfer quantity').fill('5');
	await transferForm.getByLabel('Transfer note').fill('Downtown replenishment');
	await page.getByTestId('transfer-submit').click();
	await expect(page.getByTestId('transfer-list-panel')).toContainText('requested');

	const managerTransferScreenshot = resolve('artifacts/step4-transfer-request.png');
	ensureDirectory(managerTransferScreenshot);
	await page.getByTestId('transfer-list-panel').screenshot({ path: managerTransferScreenshot });

	const transferNumber = await page.locator('[data-testid^="transfer-number-"]').first().textContent();

	await clearSession(page);
	await loginAs(page, 'admin@nextpos.test', 'Admin#123');
	await page.goto('/transfers');
	await expect(page.locator('.shell')).toHaveAttribute('data-ready', 'true');
	await page.locator('[data-testid^="approve-transfer-"]').first().click();
	await expect(page.getByTestId('transfer-list-panel')).toContainText('approved');

	expect(readStoreStock('store-hq', 'prod-water')).toBe(23);
	expect(readStoreStock('store-downtown', 'prod-water')).toBe(11);

	const approvedScreenshot = resolve('artifacts/step4-transfer-approved.png');
	ensureDirectory(approvedScreenshot);
	await page.getByTestId('transfer-list-panel').screenshot({ path: approvedScreenshot });

	expect(transferNumber).toContain('TR-');
});

async function loginAs(page: Page, email: string, password: string) {
	await page.goto('/login');
	await expect(page.locator('.login-shell')).toHaveAttribute('data-ready', 'true');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByTestId('login-submit').click();
	await expect(page).toHaveURL(/\/$/);
}

async function clearSession(page: Page) {
	await page.context().clearCookies();
	await page.evaluate(() => {
		localStorage.clear();
		sessionStorage.clear();
	});
}

function resetLocalD1() {
	withLocalD1((database) => {
		database.exec('PRAGMA foreign_keys = ON;');
		database.exec(RESET_SQL);
	});
}

function readStoreStock(storeId: string, productId: string) {
	return withLocalD1((database) => {
		const row = database
			.prepare('SELECT stock_quantity FROM store_stock WHERE store_id = ? AND product_id = ?')
			.get(storeId, productId) as { stock_quantity: number } | undefined;
		return Number(row?.stock_quantity ?? 0);
	});
}

function withLocalD1<T>(callback: (database: DatabaseSync) => T) {
	const databasePath = resolveLocalD1Path();
	const database = new DatabaseSync(databasePath);

	try {
		return callback(database);
	} finally {
		database.close();
	}
}

function resolveLocalD1Path() {
	const d1Directory = resolve('.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
	const sqliteFile = readdirSync(d1Directory).find(
		(entry) => entry.endsWith('.sqlite') && !entry.startsWith('metadata')
	);

	if (!sqliteFile) {
		throw new Error('Local D1 sqlite file not found. Start the dev server before running Playwright.');
	}

	return resolve(d1Directory, sqliteFile);
}

function ensureDirectory(filePath: string) {
	mkdirSync(dirname(filePath), { recursive: true });
}
