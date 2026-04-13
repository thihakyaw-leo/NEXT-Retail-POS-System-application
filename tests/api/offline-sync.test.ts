import { describe, expect, it } from 'vitest';
import { POST as postOfflineSync } from '../../src/routes/api/sync/offline-sales/+server';
import type { OfflineSaleSubmission, OfflineSyncResponse } from '../../src/lib/types';
import {
	createAuthHeaders,
	createAuthLocals,
	createPlatform,
	createRequestEvent,
	createTestBindings,
	queryNumber
} from '../helpers/cloudflare';

function buildOfflineSale(overrides: Partial<OfflineSaleSubmission> = {}): OfflineSaleSubmission {
	return {
		localId: overrides.localId ?? 'local-sale-001',
		storeId: overrides.storeId ?? 'store-hq',
		userId: overrides.userId ?? 'user-cashier-hq',
		cashReceivedCents: overrides.cashReceivedCents ?? 500,
		items: overrides.items ?? [{ productId: 'prod-water', quantity: 1 }],
		createdAt: overrides.createdAt ?? '2026-04-10T10:00:00.000Z',
		receiptNumber: overrides.receiptNumber ?? 'OFF-20260410-LOCAL1',
		subtotalCents: overrides.subtotalCents ?? 225,
		totalAmountCents: overrides.totalAmountCents ?? 225,
		changeDueCents: overrides.changeDueCents ?? 275,
		itemCount: overrides.itemCount ?? 1
	};
}

function createSyncPayload(sale: OfflineSaleSubmission) {
	return {
		sales: [sale]
	};
}

describe('POST /api/sync/offline-sales', () => {
	it('persists queued sales and deducts stock in batch', async () => {
		const context = await createTestBindings();

		try {
			const platform = createPlatform(context.env);
			const headers = await createAuthHeaders(context.env, 'cashier@nextpos.test', 'Cashier#123');
			const locals = await createAuthLocals(context.env, 'cashier@nextpos.test', 'Cashier#123');
			const sale = buildOfflineSale();
			const response = await postOfflineSync(
				createRequestEvent({
					platform,
					method: 'POST',
					url: 'http://localhost/api/sync/offline-sales',
					headers,
					locals,
					json: createSyncPayload(sale)
				}) as Parameters<typeof postOfflineSync>[0]
			);

			expect(response.status).toBe(200);

			const payload = (await response.json()) as OfflineSyncResponse;
			expect(payload.accepted).toHaveLength(1);
			expect(payload.rejected).toHaveLength(0);
			expect(payload.accepted[0].localId).toBe(sale.localId);
			expect(
				queryNumber(context.sqlite, 'SELECT COUNT(*) FROM transactions WHERE receipt_number = ?', [
					sale.receiptNumber
				])
			).toBe(1);
			expect(queryNumber(context.sqlite, 'SELECT COUNT(*) FROM transaction_items')).toBe(1);
			expect(
				queryNumber(
					context.sqlite,
					"SELECT stock_quantity FROM store_stock WHERE store_id = 'store-hq' AND product_id = ?",
					['prod-water']
				)
			).toBe(27);
		} finally {
			await context.dispose();
		}
	});

	it('rejects offline sales when stock conflicts are detected', async () => {
		const context = await createTestBindings();

		try {
			context.sqlite.exec(
				"UPDATE store_stock SET stock_quantity = 0, updated_at = '2026-04-10T10:05:00.000Z' WHERE store_id = 'store-hq' AND product_id = 'prod-water'"
			);

			const platform = createPlatform(context.env);
			const headers = await createAuthHeaders(context.env, 'cashier@nextpos.test', 'Cashier#123');
			const locals = await createAuthLocals(context.env, 'cashier@nextpos.test', 'Cashier#123');
			const sale = buildOfflineSale({
				localId: 'local-sale-conflict',
				receiptNumber: 'OFF-20260410-CONFLI'
			});
			const response = await postOfflineSync(
				createRequestEvent({
					platform,
					method: 'POST',
					url: 'http://localhost/api/sync/offline-sales',
					headers,
					locals,
					json: createSyncPayload(sale)
				}) as Parameters<typeof postOfflineSync>[0]
			);

			expect(response.status).toBe(200);

			const payload = (await response.json()) as OfflineSyncResponse;
			expect(payload.accepted).toHaveLength(0);
			expect(payload.rejected).toHaveLength(1);
			expect(payload.rejected[0]).toMatchObject({
				localId: sale.localId,
				reason: 'stock_conflict'
			});
			expect(payload.updatedProducts).toEqual([{ id: 'prod-water', stockQuantity: 0 }]);
			expect(queryNumber(context.sqlite, 'SELECT COUNT(*) FROM transactions')).toBe(0);
			expect(
				queryNumber(
					context.sqlite,
					"SELECT stock_quantity FROM store_stock WHERE store_id = 'store-hq' AND product_id = ?",
					['prod-water']
				)
			).toBe(0);
		} finally {
			await context.dispose();
		}
	});
});
