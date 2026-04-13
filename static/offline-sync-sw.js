const DB_NAME = 'retail-pos-offline';
const SALES_STORE = 'pending_transactions';
const INVENTORY_STORE = 'pending_inventory_actions';
const SYNC_TAG = 'offline-sales-sync';

self.addEventListener('install', (event) => {
	event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener('sync', (event) => {
	if (event.tag === SYNC_TAG) {
		event.waitUntil(syncAllOfflineWork());
	}
});

self.addEventListener('message', (event) => {
	if (!event.data || typeof event.data !== 'object') {
		return;
	}

	if (
		event.data.type === 'SYNC_OFFLINE_SALES' ||
		event.data.type === 'SYNC_OFFLINE_INVENTORY' ||
		event.data.type === 'SYNC_ALL_OFFLINE_WORK'
	) {
		event.waitUntil(syncAllOfflineWork());
	}
});

async function syncAllOfflineWork() {
	await syncPendingTransactions();
	await syncPendingInventoryActions();
}

async function syncPendingTransactions() {
	const pending = await getRecordsByStatus(SALES_STORE, ['pending', 'syncing']);

	if (pending.length === 0) {
		await notifyClients({
			type: 'OFFLINE_SYNC_RESULT',
			accepted: [],
			rejected: [],
			updatedProducts: []
		});
		return;
	}

	await updateRecords(
		SALES_STORE,
		pending.map((record) => ({
			localId: record.localId,
			changes: {
				status: 'syncing',
				lastError: null
			}
		}))
	);

	try {
		const response = await fetch('/api/sync/offline-sales', {
			method: 'POST',
			headers: {
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				sales: pending.map((record) => ({
					localId: record.localId,
					storeId: record.storeId,
					cashReceivedCents: record.cashReceivedCents,
					items: record.items,
					createdAt: record.createdAt,
					receiptNumber: record.receiptNumber,
					subtotalCents: record.subtotalCents,
					totalAmountCents: record.totalAmountCents,
					changeDueCents: record.changeDueCents,
					itemCount: record.itemCount
				}))
			})
		});
		const payload = await response.json();

		if (!response.ok) {
			throw new Error(payload?.message ?? 'Offline sale sync failed.');
		}

		const accepted = Array.isArray(payload.accepted) ? payload.accepted : [];
		const rejected = Array.isArray(payload.rejected) ? payload.rejected : [];
		const updatedProducts = Array.isArray(payload.updatedProducts) ? payload.updatedProducts : [];
		const now = new Date().toISOString();

		await updateRecords(SALES_STORE, [
			...accepted.map((entry) => ({
				localId: entry.localId,
				changes: {
					status: 'synced',
					syncedAt: entry.syncedAt ?? now,
					conflictAt: null,
					serverTransactionId: entry.transactionId ?? null,
					serverReceiptNumber: entry.receiptNumber ?? null,
					lastError: null
				}
			})),
			...rejected.map((entry) => ({
				localId: entry.localId,
				changes: {
					status: 'conflict',
					syncedAt: null,
					conflictAt: now,
					lastError: entry.message ?? 'Offline sale requires review.'
				}
			}))
		]);

		await notifyClients({
			type: 'OFFLINE_SYNC_RESULT',
			accepted,
			rejected,
			updatedProducts
		});
	} catch (error) {
		await updateRecords(
			SALES_STORE,
			pending.map((record) => ({
				localId: record.localId,
				changes: {
					status: 'pending',
					lastError: error instanceof Error ? error.message : 'Offline sale sync failed.'
				}
			}))
		);

		await notifyClients({
			type: 'OFFLINE_SYNC_ERROR',
			message: error instanceof Error ? error.message : 'Offline sale sync failed.'
		});
	}
}

async function syncPendingInventoryActions() {
	const pending = await getRecordsByStatus(INVENTORY_STORE, ['pending', 'syncing']);

	if (pending.length === 0) {
		await notifyClients({
			type: 'OFFLINE_INVENTORY_SYNC_RESULT',
			accepted: [],
			rejected: [],
			updatedProducts: []
		});
		return;
	}

	await updateRecords(
		INVENTORY_STORE,
		pending.map((record) => ({
			localId: record.localId,
			changes: {
				status: 'syncing',
				lastError: null
			}
		}))
	);

	try {
		const response = await fetch('/api/sync/inventory-actions', {
			method: 'POST',
			headers: {
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				actions: pending.map((record) => {
					const action = {
						localId: record.localId,
						storeId: record.storeId,
						actionType: record.actionType,
						createdAt: record.createdAt,
						summary: record.summary
					};

					if (record.actionType === 'purchase_order') {
						return {
							...action,
							supplierId: record.supplierId,
							notes: record.notes,
							receiveNow: record.receiveNow,
							items: record.items
						};
					}

					return {
						...action,
						productId: record.productId,
						quantityDelta: record.quantityDelta,
						reason: record.reason,
						batchCode: record.batchCode,
						expiryDate: record.expiryDate
					};
				})
			})
		});
		const payload = await response.json();

		if (!response.ok) {
			throw new Error(payload?.message ?? 'Offline inventory sync failed.');
		}

		const accepted = Array.isArray(payload.accepted) ? payload.accepted : [];
		const rejected = Array.isArray(payload.rejected) ? payload.rejected : [];
		const updatedProducts = Array.isArray(payload.updatedProducts) ? payload.updatedProducts : [];
		const now = new Date().toISOString();

		await updateRecords(INVENTORY_STORE, [
			...accepted.map((entry) => ({
				localId: entry.localId,
				changes: {
					status: 'synced',
					syncedAt: entry.syncedAt ?? now,
					conflictAt: null,
					serverEntityId: entry.entityId ?? null,
					serverReference: entry.referenceNumber ?? null,
					lastError: null
				}
			})),
			...rejected.map((entry) => ({
				localId: entry.localId,
				changes: {
					status: 'conflict',
					syncedAt: null,
					conflictAt: now,
					lastError: entry.message ?? 'Offline inventory action requires review.'
				}
			}))
		]);

		await notifyClients({
			type: 'OFFLINE_INVENTORY_SYNC_RESULT',
			accepted,
			rejected,
			updatedProducts
		});
	} catch (error) {
		await updateRecords(
			INVENTORY_STORE,
			pending.map((record) => ({
				localId: record.localId,
				changes: {
					status: 'pending',
					lastError: error instanceof Error ? error.message : 'Offline inventory sync failed.'
				}
			}))
		);

		await notifyClients({
			type: 'OFFLINE_INVENTORY_SYNC_ERROR',
			message: error instanceof Error ? error.message : 'Offline inventory sync failed.'
		});
	}
}

async function notifyClients(message) {
	const clients = await self.clients.matchAll({
		type: 'window',
		includeUncontrolled: true
	});

	for (const client of clients) {
		client.postMessage(message);
	}
}

function openDatabase() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 2);

		request.onerror = () => reject(request.error);
		request.onupgradeneeded = () => {
			const database = request.result;

			ensureStore(database, SALES_STORE);
			ensureStore(database, INVENTORY_STORE, [['actionType', 'actionType']]);
		};
		request.onsuccess = () => resolve(request.result);
	});
}

function ensureStore(database, storeName, extraIndexes = []) {
	if (database.objectStoreNames.contains(storeName)) {
		return;
	}

	const store = database.createObjectStore(storeName, {
		keyPath: 'localId'
	});
	store.createIndex('status', 'status', { unique: false });
	store.createIndex('createdAt', 'createdAt', { unique: false });
	store.createIndex('syncedAt', 'syncedAt', { unique: false });
	store.createIndex('conflictAt', 'conflictAt', { unique: false });

	for (const [name, keyPath] of extraIndexes) {
		store.createIndex(name, keyPath, { unique: false });
	}
}

async function getRecordsByStatus(storeName, statuses) {
	const database = await openDatabase();

	return new Promise((resolve, reject) => {
		const transaction = database.transaction(storeName, 'readonly');
		const store = transaction.objectStore(storeName);
		const request = store.getAll();

		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			database.close();
			resolve(
				request.result
					.filter((entry) => statuses.includes(entry.status))
					.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
			);
		};
	});
}

async function updateRecords(storeName, updates) {
	if (updates.length === 0) {
		return;
	}

	const database = await openDatabase();

	await new Promise((resolve, reject) => {
		const transaction = database.transaction(storeName, 'readwrite');
		const store = transaction.objectStore(storeName);

		transaction.oncomplete = () => {
			database.close();
			resolve(undefined);
		};
		transaction.onerror = () => reject(transaction.error);

		for (const update of updates) {
			const getRequest = store.get(update.localId);

			getRequest.onsuccess = () => {
				const existing = getRequest.result;

				if (!existing) {
					return;
				}

				store.put({
					...existing,
					...update.changes
				});
			};
		}
	});
}
