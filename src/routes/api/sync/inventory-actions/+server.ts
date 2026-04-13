import { json } from '@sveltejs/kit';
import { requireRole, resolveStoreScope } from '$lib/server/auth';
import { getPosBindings } from '$lib/server/env';
import { syncInventoryActions } from '$lib/server/inventory';
import { DEFAULT_STORE_ID, toApiError } from '$lib/server/pos';
import type { InventorySyncRequest } from '$lib/types';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	try {
		const env = getPosBindings(event.platform);
		const user = requireRole(event, ['admin', 'store_manager']);
		const payload = (await event.request.json()) as InventorySyncRequest;
		const actions = (payload.actions ?? []).map((action) => ({
			...action,
			storeId: resolveStoreScope(user, action.storeId, user.storeId ?? DEFAULT_STORE_ID)
		}));
		const response = await syncInventoryActions(env, { actions });

		return json(response, { status: 200 });
	} catch (error) {
		const apiError = toApiError(error);
		return json(apiError.body, { status: apiError.status });
	}
};
