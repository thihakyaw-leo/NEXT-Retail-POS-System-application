import { json } from '@sveltejs/kit';
import { getPosBindings } from '$lib/server/env';
import { toApiError, uploadProductImage } from '$lib/server/pos';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, platform, request }) => {
	try {
		const env = getPosBindings(platform);
		const formData = await request.formData();
		const image = formData.get('image');

		if (!(image instanceof File)) {
			return json({ message: 'Provide an image file.' }, { status: 400 });
		}

		const product = await uploadProductImage(env, params.productId, image);
		return json({ product }, { status: 201 });
	} catch (error) {
		const apiError = toApiError(error);
		return json(apiError.body, { status: apiError.status });
	}
};
