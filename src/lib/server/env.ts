import type { D1Database, R2Bucket } from '$lib/server/cloudflare';

export interface PosBindings {
	DB: D1Database;
	PRODUCT_IMAGES: R2Bucket;
}

export function getPosBindings(platform: App.Platform | undefined): PosBindings {
	const env = platform?.env;

	if (!env?.DB || !env?.PRODUCT_IMAGES) {
		throw new Error('Cloudflare bindings are unavailable. Check wrangler.toml and local platform emulation.');
	}

	return env;
}
