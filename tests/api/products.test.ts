import { describe, expect, it } from 'vitest';
import { GET as getProducts } from '../../src/routes/api/products/+server';
import { GET as getProductImage } from '../../src/routes/api/product-images/[...key]/+server';
import { POST as uploadProductImage } from '../../src/routes/api/products/[productId]/image/+server';
import type { ProductsResponse } from '../../src/lib/types';
import {
	createPlatform,
	createRequestEvent,
	createTestBindings
} from '../helpers/cloudflare';

describe('GET /api/products', () => {
	it('supports pagination and search by name or barcode', async () => {
		const context = await createTestBindings();

		try {
			const platform = createPlatform(context.env);
			const response = await getProducts(
				createRequestEvent({
					platform,
					url: 'http://localhost/api/products?page=1&pageSize=2&search=milk'
				}) as Parameters<typeof getProducts>[0]
			);

			expect(response.status).toBe(200);

			const payload = (await response.json()) as ProductsResponse;
			expect(payload.items).toHaveLength(1);
			expect(payload.items[0].name).toBe('Whole Milk 1L');
			expect(payload.pagination.totalItems).toBe(1);
		} finally {
			await context.dispose();
		}
	});
});

describe('POST /api/products/:productId/image', () => {
	it('uploads a product image to R2 and serves it back', async () => {
		const context = await createTestBindings();

		try {
			const platform = createPlatform(context.env);
			const formData = new FormData();
			formData.set(
				'image',
				new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'beans.png', {
					type: 'image/png'
				})
			);

			const uploadResponse = await uploadProductImage(
				createRequestEvent({
					platform,
					method: 'POST',
					url: 'http://localhost/api/products/prod-arabica-1kg/image',
					formData,
					params: {
						productId: 'prod-arabica-1kg'
					}
				}) as Parameters<typeof uploadProductImage>[0]
			);

			expect(uploadResponse.status).toBe(201);
			const payload = (await uploadResponse.json()) as {
				product: {
					imageKey: string;
					imageUrl: string;
				};
			};
			expect(payload.product.imageKey).toContain('products/prod-arabica-1kg/');

			const imageResponse = await getProductImage(
				createRequestEvent({
					platform,
					url: `http://localhost${payload.product.imageUrl}`,
					params: {
						key: payload.product.imageKey
					}
				}) as Parameters<typeof getProductImage>[0]
			);

			expect(imageResponse.status).toBe(200);
			expect(imageResponse.headers.get('content-type')).toBe('image/png');
			expect(new Uint8Array(await imageResponse.arrayBuffer()).byteLength).toBeGreaterThan(0);
		} finally {
			await context.dispose();
		}
	});
});
