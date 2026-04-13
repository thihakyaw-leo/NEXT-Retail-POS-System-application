import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from '@playwright/test';

type InventoryQueueRecord = {
	localId: string;
	actionType: 'purchase_order' | 'stock_adjustment';
	status: 'pending' | 'syncing' | 'synced' | 'conflict';
	summary: string;
	lastError: string | null;
	productId?: string;
	quantityDelta?: number;
};

const RESET_SQL = `
	DELETE FROM transaction_items;
	DELETE FROM transactions;
	DELETE FROM po_items;
	DELETE FROM purchase_orders;
	DELETE FROM stock_movements;
	DELETE FROM batches;
	DELETE FROM email_deliveries;
	UPDATE store_stock
	SET stock_quantity = CASE product_id
		WHEN 'prod-arabica-1kg' THEN 18
		WHEN 'prod-milk-1l' THEN 32
		WHEN 'prod-croissant' THEN 20
		WHEN 'prod-water' THEN 28
		WHEN 'prod-muffin' THEN 14
		WHEN 'prod-juice' THEN 11
		ELSE stock_quantity
	END,
	updated_at = '2026-04-10T00:00:00.000Z'
	WHERE store_id = 'store-hq';
`;

test('inventory team can receive a PO online and sync an offline stock adjustment', async ({
	page
}) => {
	resetLocalD1();

	await loginAs(page, 'manager@nextpos.test', 'Manager#123');
	await page.goto('/inventory');
	await expect(page.locator('.inventory-shell')).toHaveAttribute('data-ready', 'true');
	await expect(page.getByTestId('po-form-panel')).toBeVisible();
	await waitForServiceWorker(page);
	await expect(page.getByTestId('inventory-product-stock-prod-juice')).toContainText('11 on hand');
	const purchaseOrderPanel = page.getByTestId('po-form-panel');

	await purchaseOrderPanel.getByLabel('Supplier').selectOption('sup-harbor-beans');
	await purchaseOrderPanel.getByLabel('Product').selectOption('prod-juice');
	await purchaseOrderPanel.getByLabel('Quantity').fill('6');
	await purchaseOrderPanel.getByLabel('Unit cost (cents)').fill('420');
	await purchaseOrderPanel.getByLabel('Batch code').fill('OJ-E2E-01');
	await page.getByTestId('po-submit-button').click();

	await expect(page.getByTestId('last-po-card')).toContainText('PO-');
	await expect(page.getByTestId('inventory-product-stock-prod-juice')).toContainText('17 on hand');

	const poScreenshotPath = resolve('artifacts/step3-po-received.png');
	ensureDirectory(poScreenshotPath);
	await page.getByTestId('po-form-panel').screenshot({ path: poScreenshotPath });

	await page.goto('/inventory/stock-take');
	await expect(page.locator('.stock-shell')).toHaveAttribute('data-offline-ready', 'true');
	await expect(page.getByTestId('stock-adjust-queue-panel')).toBeVisible();
	await waitForServiceWorker(page);
	await expect(page.getByTestId('stock-adjust-product-stock-prod-water')).toContainText('28 on hand');

	await page.context().setOffline(true);
	await page.evaluate(() => {
		window.dispatchEvent(new Event('offline'));
	});

	await page.getByLabel('Product').selectOption('prod-water');
	await page.getByLabel('Quantity delta').fill('-4');
	await page.getByLabel('Reason').fill('Cycle count shrinkage');
	await page.getByTestId('stock-adjust-submit-button').click();

	await expect(page.getByTestId('stock-adjust-product-stock-prod-water')).toContainText('24 on hand');
	await expect(page.getByTestId('stock-adjust-queue-panel')).toContainText('Sparkling Water: -4');

	await expect
		.poll(async () => {
			const records = await readInventoryQueue(page);
			return records.filter((record) => record.actionType === 'stock_adjustment').length;
		})
		.toBe(1);

	const [queuedAdjustment] = await readInventoryQueue(page);
	expect(queuedAdjustment.status).toBe('pending');
	expect(queuedAdjustment.productId).toBe('prod-water');

	const beforeSyncPath = resolve('artifacts/step3-stock-adjust-before-sync.png');
	ensureDirectory(beforeSyncPath);
	await page.getByTestId('stock-adjust-queue-panel').screenshot({ path: beforeSyncPath });

	await page.context().setOffline(false);
	await page.evaluate(() => {
		window.dispatchEvent(new Event('online'));
	});

	await expect.poll(async () => {
		const record = (await readInventoryQueue(page)).find(
			(entry) => entry.localId === queuedAdjustment.localId
		);
		return record?.status ?? 'missing';
	}, { timeout: 15_000 }).toBe('synced');

	expect(readStockQuantity('prod-juice')).toBe(17);
	expect(readStockQuantity('prod-water')).toBe(24);

	const afterSyncPath = resolve('artifacts/step3-stock-adjust-after-sync.png');
	ensureDirectory(afterSyncPath);
	await page.getByTestId('stock-adjust-queue-panel').screenshot({ path: afterSyncPath });
});

async function loginAs(page: Page, email: string, password: string) {
	await page.goto('/login');
	await expect(page.locator('.login-shell')).toHaveAttribute('data-ready', 'true');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByTestId('login-submit').click();
	await expect(page).toHaveURL(/\/$/);
}

async function waitForServiceWorker(page: Page) {
	await page.evaluate(async () => {
		if ('serviceWorker' in navigator) {
			await navigator.serviceWorker.ready;
		}
	});
}

async function readInventoryQueue(page: Page) {
	return page.evaluate(
		async ({ databaseName, storeName }) =>
			await new Promise<InventoryQueueRecord[]>((resolve, reject) => {
				const request = indexedDB.open(databaseName);

				request.onerror = () => reject(new Error(request.error?.message ?? 'IndexedDB open failed.'));
				request.onsuccess = () => {
					const database = request.result;

					if (!database.objectStoreNames.contains(storeName)) {
						database.close();
						resolve([]);
						return;
					}

					const transaction = database.transaction(storeName, 'readonly');
					const store = transaction.objectStore(storeName);
					const getAllRequest = store.getAll();

					getAllRequest.onerror = () =>
						reject(new Error(getAllRequest.error?.message ?? 'IndexedDB read failed.'));
					getAllRequest.onsuccess = () => {
						database.close();
						resolve(
							getAllRequest.result.sort((left, right) =>
								right.createdAt.localeCompare(left.createdAt)
							)
						);
					};
				};
			}),
		{
			databaseName: 'retail-pos-offline',
			storeName: 'pending_inventory_actions'
		}
	);
}

function resetLocalD1() {
	withLocalD1((database) => {
		database.exec('PRAGMA foreign_keys = ON;');
		database.exec(RESET_SQL);
	});
}

function readStockQuantity(productId: string) {
	return withLocalD1((database) => {
		const row = database
			.prepare("SELECT stock_quantity FROM store_stock WHERE product_id = ? AND store_id = 'store-hq'")
			.get(productId) as { stock_quantity: number } | undefined;
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
