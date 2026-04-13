import { json } from '@sveltejs/kit';
import { requireRole, resolveStoreScope } from '$lib/server/auth';
import { getPosBindings } from '$lib/server/env';
import { dispatchLowStockAlert } from '$lib/server/inventory';
import { DEFAULT_STORE_ID, toApiError } from '$lib/server/pos';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	try {
		const env = getPosBindings(event.platform);
		const user = requireRole(event, ['admin', 'store_manager']);
		const storeId = resolveStoreScope(
			user,
			event.url.searchParams.get('storeId'),
			user.storeId ?? DEFAULT_STORE_ID
		);
		const response = await dispatchLowStockAlert(env, storeId);

		return json(response, { status: 200 });
	} catch (error) {
		const apiError = toApiError(error);
		return json(apiError.body, { status: apiError.status });
	}
};
