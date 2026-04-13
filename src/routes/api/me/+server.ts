import { json } from '@sveltejs/kit';
import { listAccessibleStores, requireUser } from '$lib/server/auth';
import { getPosBindings } from '$lib/server/env';
import { toApiError } from '$lib/server/pos';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	try {
		const env = getPosBindings(event.platform);
		const user = requireUser(event);
		const stores = await listAccessibleStores(env, user);

		return json({
			user,
			stores
		});
	} catch (error) {
		const apiError = toApiError(error);
		return json(apiError.body, { status: apiError.status });
	}
};
