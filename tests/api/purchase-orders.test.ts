import { describe, expect, it } from 'vitest';
import { POST as postPurchaseOrder } from '../../src/routes/api/purchase-orders/+server';
import type { PurchaseOrderResponse } from '../../src/lib/types';
import {
	createAuthHeaders,
	createAuthLocals,
	createPlatform,
	createRequestEvent,
	createTestBindings,
	queryNumber
} from '../helpers/cloudflare';

describe('POST /api/purchase-orders', () => {
	it('creates a received purchase order and increases stock', async () => {
		const context = await createTestBindings();

		try {
			const platform = createPlatform(context.env);
			const headers = await createAuthHeaders(context.env, 'manager@nextpos.test', 'Manager#123');
			const locals = await createAuthLocals(context.env, 'manager@nextpos.test', 'Manager#123');
			const response = await postPurchaseOrder(
				createRequestEvent({
					platform,
					method: 'POST',
					url: 'http://localhost/api/purchase-orders',
					headers,
					locals,
					json: {
						storeId: 'store-hq',
						supplierId: 'sup-harbor-beans',
						notes: 'Emergency replenishment',
						receiveNow: true,
						items: [
							{
								productId: 'prod-juice',
								quantity: 6,
								unitCostCents: 420,
								batchCode: 'OJ-APR-01',
								expiryDate: '2026-05-31'
							}
						]
					}
				}) as Parameters<typeof postPurchaseOrder>[0]
			);

			expect(response.status).toBe(201);

			const payload = (await response.json()) as PurchaseOrderResponse;
			expect(payload.purchaseOrder.status).toBe('received');
			expect(payload.purchaseOrder.items).toHaveLength(1);
			expect(payload.purchaseOrder.batches[0].batchCode).toBe('OJ-APR-01');
			expect(
				queryNumber(
					context.sqlite,
					"SELECT stock_quantity FROM store_stock WHERE product_id = ? AND store_id = 'store-hq'",
					['prod-juice']
				)
			).toBe(17);
			expect(queryNumber(context.sqlite, 'SELECT COUNT(*) FROM purchase_orders')).toBe(1);
			expect(queryNumber(context.sqlite, 'SELECT COUNT(*) FROM po_items')).toBe(1);
			expect(queryNumber(context.sqlite, 'SELECT COUNT(*) FROM batches')).toBe(1);
			expect(queryNumber(context.sqlite, 'SELECT COUNT(*) FROM stock_movements')).toBe(1);
		} finally {
			await context.dispose();
		}
	});
});
