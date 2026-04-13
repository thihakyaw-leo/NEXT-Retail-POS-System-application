import { listAccessibleStores, requirePageRole, resolveStoreScope } from '$lib/server/auth';
import { getPosBindings } from '$lib/server/env';
import { listLowStockReport, listRecentStockMovements } from '$lib/server/inventory';
import { DEFAULT_STORE_ID, getStoreSummary, listProducts } from '$lib/server/pos';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const user = requirePageRole(event, ['admin', 'store_manager']);
	const env = getPosBindings(event.platform);
	const stores = await listAccessibleStores(env, user);
	const fallbackStoreId = user.storeId ?? stores[0]?.id ?? DEFAULT_STORE_ID;
	const storeId = resolveStoreScope(user, event.url.searchParams.get('storeId'), fallbackStoreId);
	const [store, products, lowStockReport, recentMovements] = await Promise.all([
		getStoreSummary(env, storeId),
		listProducts(env, {
			storeId,
			pageSize: 36
		}),
		listLowStockReport(env, storeId),
		listRecentStockMovements(env, storeId, 12)
	]);

	return {
		user,
		stores,
		selectedStoreId: storeId,
		store,
		products: products.items,
		lowStockReport,
		recentMovements
	};
};
