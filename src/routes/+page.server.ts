import { listAccessibleStores, requirePageUser, resolveStoreScope } from '$lib/server/auth';
import { getPosBindings } from '$lib/server/env';
import { DEFAULT_STORE_ID, getStoreSummary, listProducts } from '$lib/server/pos';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const user = requirePageUser(event);
	const env = getPosBindings(event.platform);
	const stores = await listAccessibleStores(env, user);
	const fallbackStoreId = user.storeId ?? stores[0]?.id ?? DEFAULT_STORE_ID;
	const selectedStoreId = resolveStoreScope(user, event.url.searchParams.get('storeId'), fallbackStoreId);
	const [store, initialProducts] = await Promise.all([
		getStoreSummary(env, selectedStoreId),
		listProducts(env, {
			storeId: selectedStoreId
		})
	]);

	return {
		user,
		stores,
		selectedStoreId,
		store,
		initialProducts
	};
};
