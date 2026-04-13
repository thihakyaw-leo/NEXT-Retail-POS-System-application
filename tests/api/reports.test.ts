import { describe, expect, it } from 'vitest';
import { GET as getLowStock } from '../../src/routes/api/reports/low-stock/+server';
import { POST as postLowStockDispatch } from '../../src/routes/api/reports/low-stock/dispatch/+server';
import type { LowStockDispatchResponse, LowStockReportResponse } from '../../src/lib/types';
import {
	createAuthHeaders,
	createAuthLocals,
	createPlatform,
	createRequestEvent,
	createTestBindings,
	queryNumber
} from '../helpers/cloudflare';

describe('GET /api/reports/low-stock', () => {
	it('returns products at or below their reorder point', async () => {
		const context = await createTestBindings();

		try {
			const platform = createPlatform(context.env);
			const headers = await createAuthHeaders(context.env, 'manager@nextpos.test', 'Manager#123');
			const locals = await createAuthLocals(context.env, 'manager@nextpos.test', 'Manager#123');
			const response = await getLowStock(
				createRequestEvent({
					platform,
					url: 'http://localhost/api/reports/low-stock',
					headers,
					locals
				}) as Parameters<typeof getLowStock>[0]
			);

			expect(response.status).toBe(200);

			const payload = (await response.json()) as LowStockReportResponse;
			expect(payload.items.some((item) => item.productId === 'prod-juice')).toBe(true);
			expect(payload.items.some((item) => item.productId === 'prod-muffin')).toBe(true);
		} finally {
			await context.dispose();
		}
	});
});

describe('POST /api/reports/low-stock/dispatch', () => {
	it('writes a mock low stock email delivery for manual cron verification', async () => {
		const context = await createTestBindings();

		try {
			const platform = createPlatform(context.env);
			const headers = await createAuthHeaders(context.env, 'admin@nextpos.test', 'Admin#123');
			const locals = await createAuthLocals(context.env, 'admin@nextpos.test', 'Admin#123');
			const response = await postLowStockDispatch(
				createRequestEvent({
					platform,
					method: 'POST',
					url: 'http://localhost/api/reports/low-stock/dispatch',
					headers,
					locals
				}) as Parameters<typeof postLowStockDispatch>[0]
			);

			expect(response.status).toBe(200);

			const payload = (await response.json()) as LowStockDispatchResponse;
			expect(payload.delivery.transport).toBe('mock');
			expect(payload.delivery.recipient).toBe('ops@retail-pos.example');
			expect(queryNumber(context.sqlite, 'SELECT COUNT(*) FROM email_deliveries')).toBe(1);
		} finally {
			await context.dispose();
		}
	});
});
