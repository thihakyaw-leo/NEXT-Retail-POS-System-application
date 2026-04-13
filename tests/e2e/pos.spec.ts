import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from '@playwright/test';

type IndexedDbQueueRecord = {
	localId: string;
	storeId: string;
	userId: string;
	receiptNumber: string;
	status: 'pending' | 'syncing' | 'synced' | 'conflict';
	lastError: string | null;
	items: Array<{
		productId: string;
		quantity: number;
	}>;
	itemCount: number;
	totalAmountCents: number;
};

const INITIAL_STOCK_SQL = `
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

test('cashier can queue offline sales, sync them, and mark conflicts for review', async ({
	page
}) => {
	resetLocalD1();

	await loginAs(page, 'cashier@nextpos.test', 'Cashier#123');
	await expect
		.poll(() => page.evaluate(() => Boolean(localStorage.getItem('pos_session'))))
		.toBe(true);
	await expect(page.locator('.shell')).toHaveAttribute('data-ready', 'true');
	await expect(page.getByTestId('product-grid')).toBeVisible();
	await waitForServiceWorker(page);

	await page.context().setOffline(true);
	await expect(page.getByTestId('network-status')).toHaveText('Offline');

	await page.locator('button[aria-label="Add Sparkling Water"]').click();
	await expect(page.getByTestId('cart-count')).toHaveText('1 items');
	await page.getByLabel('Cash received').fill('5');
	await page.getByTestId('checkout-button').click();

	await expect(page.getByTestId('receipt-preview')).toContainText('Queued offline receipt');
	await expect(page.getByTestId('sync-message')).toContainText('Sale saved offline');

	await expect.poll(() => readIndexedDbQueue(page).then((records) => records.length)).toBe(1);
	const [queuedSale] = await readIndexedDbQueue(page);
	expect(queuedSale.status).toBe('pending');
	expect(queuedSale.storeId).toBe('store-hq');
	expect(queuedSale.userId).toBe('user-cashier-hq');
	expect(queuedSale.items).toEqual([{ productId: 'prod-water', quantity: 1 }]);

	const beforeSyncPath = resolve('artifacts/step2-indexeddb-before-sync.png');
	ensureDirectory(beforeSyncPath);
	await page.getByTestId('offline-queue-panel').screenshot({ path: beforeSyncPath });

	await page.context().setOffline(false);
	await expect(page.getByTestId('network-status')).toHaveText('Online');

	await expect.poll(async () => {
		const record = (await readIndexedDbQueue(page)).find((entry) => entry.localId === queuedSale.localId);
		return record?.status ?? 'missing';
	}, { timeout: 15_000 }).toBe('synced');
	await expect(page.getByTestId('sync-message')).toContainText('synced');

	expect(readTransactionCount(queuedSale.receiptNumber)).toBe(1);
	expect(readStockQuantity('prod-water')).toBe(27);

	const afterSyncPath = resolve('artifacts/step2-indexeddb-after-sync.png');
	ensureDirectory(afterSyncPath);
	await page.getByTestId('offline-queue-panel').screenshot({ path: afterSyncPath });

	updateProductStock('prod-water', 0);

	await page.context().setOffline(true);
	await expect(page.getByTestId('network-status')).toHaveText('Offline');

	await page.locator('button[aria-label="Add Sparkling Water"]').click();
	await expect(page.getByTestId('cart-count')).toHaveText('1 items');
	await page.getByLabel('Cash received').fill('5');
	await page.getByTestId('checkout-button').click();
	await expect(page.getByTestId('receipt-preview')).toContainText('Queued offline receipt');

	let pendingConflictSale: IndexedDbQueueRecord | undefined;
	await expect
		.poll(async () => {
			const records = await readIndexedDbQueue(page);
			pendingConflictSale = records.find(
				(entry) => entry.localId !== queuedSale.localId && entry.status === 'pending'
			);
			return pendingConflictSale?.localId ?? 'missing';
		}, { timeout: 10_000 })
		.not.toBe('missing');

	await page.context().setOffline(false);
	await expect(page.getByTestId('network-status')).toHaveText('Online');

	await expect.poll(async () => {
		const record = (await readIndexedDbQueue(page)).find(
			(entry) => entry.localId === pendingConflictSale?.localId
		);
		return record?.status ?? 'missing';
	}, { timeout: 15_000 }).toBe('conflict');

	const queueAfterConflict = await readIndexedDbQueue(page);
	const conflictRecord = queueAfterConflict.find(
		(entry) => entry.localId === pendingConflictSale?.localId
	);

	expect(conflictRecord?.lastError).toContain('only has 0 unit(s) available for sync.');
	expect(readTransactionCount(pendingConflictSale?.receiptNumber ?? '')).toBe(0);
	expect(readStockQuantity('prod-water')).toBe(0);
	await expect(page.getByTestId('queue-conflict-count')).toContainText('Review 1');

	const conflictPath = resolve('artifacts/step2-conflict-review.png');
	ensureDirectory(conflictPath);
	await page.getByTestId('offline-queue-panel').screenshot({ path: conflictPath });
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

async function readIndexedDbQueue(page: Page) {
	return page.evaluate(
		async ({ databaseName, storeName }) =>
			await new Promise<IndexedDbQueueRecord[]>((resolve, reject) => {
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
			storeName: 'pending_transactions'
		}
	);
}

function resetLocalD1() {
	withLocalD1((database) => {
		database.exec('PRAGMA foreign_keys = ON;');
		database.exec('DELETE FROM transaction_items;');
		database.exec('DELETE FROM transactions;');
		database.exec(INITIAL_STOCK_SQL);
	});
}

function updateProductStock(productId: string, stockQuantity: number) {
	withLocalD1((database) => {
		database
			.prepare(
				`UPDATE store_stock
				SET stock_quantity = ?, updated_at = '2026-04-10T12:00:00.000Z'
				WHERE store_id = 'store-hq' AND product_id = ?`
			)
			.run(stockQuantity, productId);
	});
}

function readTransactionCount(receiptNumber: string) {
	return withLocalD1((database) => {
		const row = database
			.prepare('SELECT COUNT(*) AS total FROM transactions WHERE receipt_number = ?')
			.get(receiptNumber) as { total: number } | undefined;
		return Number(row?.total ?? 0);
	});
}

function readStockQuantity(productId: string) {
	return withLocalD1((database) => {
		const row = database
			.prepare(
				"SELECT stock_quantity FROM store_stock WHERE store_id = 'store-hq' AND product_id = ?"
			)
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
