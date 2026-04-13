import type { D1Database, R2Bucket } from '$lib/server/cloudflare';

declare global {
	namespace App {
		interface Platform {
			env: {
				DB: D1Database;
				PRODUCT_IMAGES: R2Bucket;
				JWT_SECRET?: string;
				RESEND_API_KEY?: string;
				RESEND_API_BASE_URL?: string;
				LOW_STOCK_REPORT_TO?: string;
				LOW_STOCK_REPORT_FROM?: string;
				EMAIL_TRANSPORT?: 'mock' | 'resend';
			};
			ctx: {
				waitUntil(promise: Promise<unknown>): void;
				passThroughOnException?(): void;
			};
			caches: CacheStorage;
			cf: Record<string, unknown>;
		}

		interface Locals {
			user: import('$lib/types').CurrentUser | null;
		}
	}
}

export {};
