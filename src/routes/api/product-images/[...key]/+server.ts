import { getPosBindings } from '$lib/server/env';
import { fetchProductImage } from '$lib/server/pos';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, platform }) => {
	const key = params.key;

	if (!key) {
		return new Response('Image key is required.', { status: 400 });
	}

	const env = getPosBindings(platform);
	const response = await fetchProductImage(env, key);

	if (!response) {
		return new Response('Image not found.', { status: 404 });
	}

	return response;
};
