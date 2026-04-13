import { json } from '@sveltejs/kit';
import { requireUser, resolveStoreScope } from '$lib/server/auth';
import { getPosBindings } from '$lib/server/env';
import { DEFAULT_STORE_ID, listProducts, parseProductsRequest, toApiError } from '$lib/server/pos';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	try {
		const env = getPosBindings(event.platform);
		const user = requireUser(event);
		const query = parseProductsRequest(event.url);
		const storeId = resolveStoreScope(
			user,
			event.url.searchParams.get('storeId'),
			user.storeId ?? DEFAULT_STORE_ID
		);
		const response = await listProducts(env, {
			storeId,
			page: query.page,
			pageSize: query.pageSize,
			search: query.search
		});

		return json(response);
	} catch (error) {
		const apiError = toApiError(error);
		return json(apiError.body, { status: apiError.status });
	}
};
