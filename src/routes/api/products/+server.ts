import { json } from '@sveltejs/kit';
import { getPosBindings } from '$lib/server/env';
import { DEFAULT_STORE_ID, listProducts, parseProductsRequest, toApiError } from '$lib/server/pos';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ platform, url }) => {
	try {
		const env = getPosBindings(platform);
		const query = parseProductsRequest(url);
		const response = await listProducts(env, {
			storeId: DEFAULT_STORE_ID,
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
