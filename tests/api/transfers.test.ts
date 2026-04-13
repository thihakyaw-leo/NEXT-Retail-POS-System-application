import { describe, expect, it } from 'vitest';
import { POST as postTransfer } from '../../src/routes/api/transfers/+server';
import { PUT as putApproveTransfer } from '../../src/routes/api/transfers/[id]/approve/+server';
import type { TransferResponse } from '../../src/lib/types';
import {
	createAuthHeaders,
	createAuthLocals,
	createPlatform,
	createRequestEvent,
	createTestBindings,
	queryNumber
} from '../helpers/cloudflare';

describe('transfer workflow', () => {
	it('creates and approves an inter-store transfer', async () => {
		const context = await createTestBindings();

		try {
			const platform = createPlatform(context.env);
			const managerHeaders = await createAuthHeaders(context.env, 'manager@nextpos.test', 'Manager#123');
			const managerLocals = await createAuthLocals(context.env, 'manager@nextpos.test', 'Manager#123');
			const createResponse = await postTransfer(
				createRequestEvent({
					platform,
					method: 'POST',
					url: 'http://localhost/api/transfers',
					headers: managerHeaders,
					locals: managerLocals,
					json: {
						fromStoreId: 'store-hq',
						toStoreId: 'store-downtown',
						note: 'Restock downtown water',
						items: [{ productId: 'prod-water', quantity: 5 }]
					}
				}) as Parameters<typeof postTransfer>[0]
			);

			expect(createResponse.status).toBe(201);
			const created = (await createResponse.json()) as TransferResponse;
			expect(created.transfer.status).toBe('requested');

			const adminHeaders = await createAuthHeaders(context.env, 'admin@nextpos.test', 'Admin#123');
			const adminLocals = await createAuthLocals(context.env, 'admin@nextpos.test', 'Admin#123');
			const approveResponse = await putApproveTransfer(
				createRequestEvent({
					platform,
					method: 'PUT',
					url: `http://localhost/api/transfers/${created.transfer.id}/approve`,
					headers: adminHeaders,
					locals: adminLocals,
					params: {
						id: created.transfer.id
					}
				}) as Parameters<typeof putApproveTransfer>[0]
			);

			expect(approveResponse.status).toBe(200);
			const approved = (await approveResponse.json()) as TransferResponse;
			expect(approved.transfer.status).toBe('approved');
			expect(
				queryNumber(
					context.sqlite,
					'SELECT stock_quantity FROM store_stock WHERE store_id = ? AND product_id = ?',
					['store-hq', 'prod-water']
				)
			).toBe(23);
			expect(
				queryNumber(
					context.sqlite,
					'SELECT stock_quantity FROM store_stock WHERE store_id = ? AND product_id = ?',
					['store-downtown', 'prod-water']
				)
			).toBe(11);
		} finally {
			await context.dispose();
		}
	});
});
