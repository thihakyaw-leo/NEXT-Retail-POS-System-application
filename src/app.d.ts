import type { D1Database, R2Bucket } from '$lib/server/cloudflare';

declare global {
	namespace App {
		interface Platform {
			env: {
				DB: D1Database;
				PRODUCT_IMAGES: R2Bucket;
			};
			ctx: {
				waitUntil(promise: Promise<unknown>): void;
				passThroughOnException?(): void;
			};
			caches: CacheStorage;
			cf: Record<string, unknown>;
		}
	}
}

export {};
