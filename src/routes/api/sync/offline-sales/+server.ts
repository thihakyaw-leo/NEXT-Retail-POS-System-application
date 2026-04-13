import { json } from '@sveltejs/kit';
import { requireUser, resolveStoreScope } from '$lib/server/auth';
import { getPosBindings } from '$lib/server/env';
import { DEFAULT_STORE_ID, syncOfflineSales, toApiError } from '$lib/server/pos';
import type { OfflineSyncRequest } from '$lib/types';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	try {
		const env = getPosBindings(event.platform);
		const user = requireUser(event);
		const payload = (await event.request.json()) as OfflineSyncRequest;
		const sales = (payload.sales ?? []).map((sale) => ({
			...sale,
			storeId: resolveStoreScope(user, sale.storeId, user.storeId ?? DEFAULT_STORE_ID),
			userId: user.id
		}));
		const securedResponse = await syncOfflineSales(env, { sales });

		return json(securedResponse, { status: 200 });
	} catch (error) {
		const apiError = toApiError(error);
		return json(apiError.body, { status: apiError.status });
	}
};
