import { getPosBindings } from '$lib/server/env';
import { DEFAULT_STORE_ID, getStoreSummary, listProducts } from '$lib/server/pos';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	const env = getPosBindings(platform);
	const [store, initialProducts] = await Promise.all([
		getStoreSummary(env, DEFAULT_STORE_ID),
		listProducts(env, {
			storeId: DEFAULT_STORE_ID
		})
	]);

	return {
		store,
		initialProducts
	};
};
