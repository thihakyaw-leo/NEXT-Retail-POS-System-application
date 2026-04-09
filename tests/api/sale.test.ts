import { describe, expect, it } from 'vitest';
import { POST as postSale } from '../../src/routes/api/sale/+server';
import type { SaleResponse } from '../../src/lib/types';
import {
	createPlatform,
	createRequestEvent,
	createTestBindings,
	queryNumber
} from '../helpers/cloudflare';

describe('POST /api/sale', () => {
	it('deducts stock and persists the transaction', async () => {
		const context = await createTestBindings();

		try {
			const platform = createPlatform(context.env);
			const response = await postSale(
				createRequestEvent({
					platform,
					method: 'POST',
					url: 'http://localhost/api/sale',
					json: {
						storeId: 'store-hq',
						cashReceivedCents: 4000,
						items: [
							{ productId: 'prod-arabica-1kg', quantity: 1 },
							{ productId: 'prod-milk-1l', quantity: 1 },
							{ productId: 'prod-croissant', quantity: 1 }
						]
					}
				}) as Parameters<typeof postSale>[0]
			);

			expect(response.status).toBe(201);

			const payload = (await response.json()) as SaleResponse;
			expect(payload.receipt.totalAmountCents).toBe(3200);
			expect(payload.receipt.changeDueCents).toBe(800);
			expect(
				queryNumber(context.sqlite, 'SELECT stock_quantity FROM products WHERE id = ?', [
					'prod-arabica-1kg'
				])
			).toBe(17);
			expect(queryNumber(context.sqlite, 'SELECT COUNT(*) FROM transactions')).toBe(1);
			expect(queryNumber(context.sqlite, 'SELECT COUNT(*) FROM transaction_items')).toBe(3);
		} finally {
			await context.dispose();
		}
	});
});
