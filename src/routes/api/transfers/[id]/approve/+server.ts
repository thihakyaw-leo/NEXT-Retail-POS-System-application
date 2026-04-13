import { json } from '@sveltejs/kit';
import { requireRole } from '$lib/server/auth';
import { getPosBindings } from '$lib/server/env';
import { toApiError } from '$lib/server/pos';
import { approveTransfer } from '$lib/server/transfers';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async (event) => {
	try {
		const env = getPosBindings(event.platform);
		const user = requireRole(event, ['admin']);
		const response = await approveTransfer(env, event.params.id, user);

		return json(response, { status: 200 });
	} catch (error) {
		const apiError = toApiError(error);
		return json(apiError.body, { status: apiError.status });
	}
};
