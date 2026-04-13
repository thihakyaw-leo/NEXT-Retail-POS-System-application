import { describe, expect, it } from 'vitest';
import { POST as postStockAdjust } from '../../src/routes/api/stock/adjust/+server';
import type { StockAdjustmentResponse } from '../../src/lib/types';
import {
	createAuthHeaders,
	createAuthLocals,
	createPlatform,
	createRequestEvent,
	createTestBindings,
	queryNumber
} from '../helpers/cloudflare';

describe('POST /api/stock/adjust', () => {
	it('applies a single adjustment and records the movement', async () => {
		const context = await createTestBindings();

		try {
			const platform = createPlatform(context.env);
			const headers = await createAuthHeaders(context.env, 'manager@nextpos.test', 'Manager#123');
			const locals = await createAuthLocals(context.env, 'manager@nextpos.test', 'Manager#123');
			const response = await postStockAdjust(
				createRequestEvent({
					platform,
					method: 'POST',
					url: 'http://localhost/api/stock/adjust',
					headers,
					locals,
					json: {
						storeId: 'store-hq',
						productId: 'prod-water',
						quantityDelta: -3,
						reason: 'Broken bottles'
					}
				}) as Parameters<typeof postStockAdjust>[0]
			);

			expect(response.status).toBe(201);

			const payload = (await response.json()) as StockAdjustmentResponse;
			expect(payload.movement.quantityDelta).toBe(-3);
			expect(payload.updatedProduct.stockQuantity).toBe(25);
			expect(
				queryNumber(
					context.sqlite,
					"SELECT stock_quantity FROM store_stock WHERE product_id = ? AND store_id = 'store-hq'",
					['prod-water']
				)
			).toBe(25);
			expect(queryNumber(context.sqlite, 'SELECT COUNT(*) FROM stock_movements')).toBe(1);
		} finally {
			await context.dispose();
		}
	});

	it('handles 20 concurrent adjustments without deadlocking', async () => {
		const context = await createTestBindings();

		try {
			const platform = createPlatform(context.env);
			const headers = await createAuthHeaders(context.env, 'manager@nextpos.test', 'Manager#123');
			const locals = await createAuthLocals(context.env, 'manager@nextpos.test', 'Manager#123');
			const responses = await Promise.all(
				Array.from({ length: 20 }, () =>
					postStockAdjust(
						createRequestEvent({
							platform,
							method: 'POST',
							url: 'http://localhost/api/stock/adjust',
							headers,
							locals,
							json: {
								storeId: 'store-hq',
								productId: 'prod-water',
								quantityDelta: 1,
								reason: 'Load test increment'
							}
						}) as Parameters<typeof postStockAdjust>[0]
					)
				)
			);

			expect(responses.every((response) => response.status === 201)).toBe(true);
			expect(
				queryNumber(
					context.sqlite,
					"SELECT stock_quantity FROM store_stock WHERE product_id = ? AND store_id = 'store-hq'",
					['prod-water']
				)
			).toBe(48);
			expect(queryNumber(context.sqlite, 'SELECT COUNT(*) FROM stock_movements')).toBe(20);
		} finally {
			await context.dispose();
		}
	});
});
