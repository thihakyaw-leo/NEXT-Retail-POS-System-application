import { json } from '@sveltejs/kit';
import { applyAuthCookie, authenticateUser, issueAuthToken, listAccessibleStores } from '$lib/server/auth';
import { getPosBindings } from '$lib/server/env';
import { toApiError, PosHttpError } from '$lib/server/pos';
import type { AuthLoginRequest } from '$lib/types';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ platform, request, cookies }) => {
	try {
		const env = getPosBindings(platform);
		const payload = (await request.json()) as AuthLoginRequest;
		const user = await authenticateUser(env, payload.email, payload.password);

		if (!user) {
			throw new PosHttpError(401, 'Invalid email or password.');
		}

		const [token, stores] = await Promise.all([
			issueAuthToken(env, user),
			listAccessibleStores(env, user)
		]);
		applyAuthCookie(cookies, token);

		return json({
			token,
			user,
			stores
		});
	} catch (error) {
		const apiError = toApiError(error);
		return json(apiError.body, { status: apiError.status });
	}
};
