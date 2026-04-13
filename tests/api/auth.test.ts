import { describe, expect, it } from 'vitest';
import { POST as postLogin } from '../../src/routes/api/auth/login/+server';
import { GET as getMe } from '../../src/routes/api/me/+server';
import { GET as getProducts } from '../../src/routes/api/products/+server';
import {
	createAuthHeaders,
	createAuthLocals,
	createPlatform,
	createRequestEvent,
	createTestBindings
} from '../helpers/cloudflare';

describe('auth and RBAC', () => {
	it('logs in and returns the authenticated user profile', async () => {
		const context = await createTestBindings();

		try {
			const platform = createPlatform(context.env);
			const loginResponse = await postLogin(
				createRequestEvent({
					platform,
					method: 'POST',
					url: 'http://localhost/api/auth/login',
					json: {
						email: 'manager@nextpos.test',
						password: 'Manager#123'
					}
				}) as Parameters<typeof postLogin>[0]
			);

			expect(loginResponse.status).toBe(200);
			const loginPayload = (await loginResponse.json()) as {
				token: string;
				user: { role: string; email: string };
				stores: Array<{ id: string }>;
			};
			expect(loginPayload.user.role).toBe('store_manager');
			expect(loginPayload.stores[0].id).toBe('store-hq');

			const locals = await createAuthLocals(context.env, 'manager@nextpos.test', 'Manager#123');
			const headers = await createAuthHeaders(context.env, 'manager@nextpos.test', 'Manager#123');
			const meResponse = await getMe(
				createRequestEvent({
					platform,
					url: 'http://localhost/api/me',
					headers,
					locals
				}) as Parameters<typeof getMe>[0]
			);

			expect(meResponse.status).toBe(200);
			const mePayload = (await meResponse.json()) as { user: { email: string } };
			expect(mePayload.user.email).toBe('manager@nextpos.test');
		} finally {
			await context.dispose();
		}
	});

	it('rejects another store access with an invalid JWT', async () => {
		const context = await createTestBindings();

		try {
			const platform = createPlatform(context.env);
			const response = await getProducts(
				createRequestEvent({
					platform,
					url: 'http://localhost/api/products?storeId=store-downtown',
					headers: {
						authorization: 'Bearer invalid.jwt.token'
					},
					locals: {
						user: null
					}
				}) as Parameters<typeof getProducts>[0]
			);

			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({
				message: 'Authentication required.'
			});
		} finally {
			await context.dispose();
		}
	});

	it('blocks cross-store access for manager with valid JWT but wrong store', async () => {
		const context = await createTestBindings();

		try {
			const platform = createPlatform(context.env);
			const headers = await createAuthHeaders(context.env, 'manager@nextpos.test', 'Manager#123');
			const locals = await createAuthLocals(context.env, 'manager@nextpos.test', 'Manager#123');

			const response = await getProducts(
				createRequestEvent({
					platform,
					url: 'http://localhost/api/products?storeId=store-downtown',
					headers,
					locals
				}) as Parameters<typeof getProducts>[0]
			);

			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				message: 'You cannot access another store.'
			});
		} finally {
			await context.dispose();
		}
	});
});

