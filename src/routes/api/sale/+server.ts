import { json } from '@sveltejs/kit';
import { getPosBindings } from '$lib/server/env';
import { createSale, toApiError } from '$lib/server/pos';
import type { SaleRequest } from '$lib/types';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ platform, request }) => {
	try {
		const env = getPosBindings(platform);
		const payload = (await request.json()) as SaleRequest;
		const response = await createSale(env, payload);

		return json(response, { status: 201 });
	} catch (error) {
		const apiError = toApiError(error);
		return json(apiError.body, { status: apiError.status });
	}
};
