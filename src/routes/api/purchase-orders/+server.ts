import { json } from '@sveltejs/kit';
import { requireRole, resolveStoreScope } from '$lib/server/auth';
import { createPurchaseOrder } from '$lib/server/inventory';
import { getPosBindings } from '$lib/server/env';
import { DEFAULT_STORE_ID, toApiError } from '$lib/server/pos';
import type { PurchaseOrderRequest } from '$lib/types';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	try {
		const env = getPosBindings(event.platform);
		const user = requireRole(event, ['admin', 'store_manager']);
		const payload = (await event.request.json()) as PurchaseOrderRequest;
		const response = await createPurchaseOrder(env, {
			...payload,
			storeId: resolveStoreScope(user, payload.storeId, user.storeId ?? DEFAULT_STORE_ID)
		});

		return json(response, { status: 201 });
	} catch (error) {
		const apiError = toApiError(error);
		return json(apiError.body, { status: apiError.status });
	}
};
