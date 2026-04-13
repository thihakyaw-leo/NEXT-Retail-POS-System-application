import type { Handle } from '@sveltejs/kit';
import { loadCurrentUser } from '$lib/server/auth';
import { getPosBindings } from '$lib/server/env';

export const handle: Handle = async ({ event, resolve }) => {
	try {
		const env = getPosBindings(event.platform);
		event.locals.user = await loadCurrentUser(env, event.request, event.cookies);
	} catch {
		event.locals.user = null;
	}

	return resolve(event);
};
