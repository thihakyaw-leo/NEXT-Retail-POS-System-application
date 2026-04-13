import { json } from '@sveltejs/kit';
import { requireUser, resolveStoreScope } from '$lib/server/auth';
import { getPosBindings } from '$lib/server/env';
import { DEFAULT_STORE_ID, createSale, toApiError } from '$lib/server/pos';
import type { SaleRequest } from '$lib/types';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	try {
		const env = getPosBindings(event.platform);
		const user = requireUser(event);
		const payload = (await event.request.json()) as SaleRequest;
		const storeId = resolveStoreScope(user, payload.storeId, user.storeId ?? DEFAULT_STORE_ID);
		const response = await createSale(env, {
			...payload,
			storeId,
			userId: user.id
		});

		return json(response, { status: 201 });
	} catch (error) {
		const apiError = toApiError(error);
		return json(apiError.body, { status: apiError.status });
	}
};
