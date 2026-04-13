import { listAccessibleStores, requirePageRole, resolveStoreScope } from '$lib/server/auth';
import { getPosBindings } from '$lib/server/env';
import { listTransfers } from '$lib/server/transfers';
import { DEFAULT_STORE_ID, listProducts } from '$lib/server/pos';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const user = requirePageRole(event, ['admin', 'store_manager']);
	const env = getPosBindings(event.platform);
	const sourceStores = await listAccessibleStores(env, user);
	const allStoresResult = await env.DB.prepare(
		`SELECT id, name, address, currency_code
		FROM stores
		ORDER BY name COLLATE NOCASE ASC`
	).all<{
		id: string;
		name: string;
		address: string | null;
		currency_code: string;
	}>();
	const stores = allStoresResult.results.map((store) => ({
		id: store.id,
		name: store.name,
		address: store.address,
		currencyCode: store.currency_code
	}));
	const fallbackStoreId = user.storeId ?? sourceStores[0]?.id ?? DEFAULT_STORE_ID;
	const selectedStoreId = resolveStoreScope(user, event.url.searchParams.get('storeId'), fallbackStoreId);
	const [products, transfers] = await Promise.all([
		listProducts(env, {
			storeId: selectedStoreId,
			pageSize: 100
		}),
		listTransfers(env, user)
	]);

	return {
		user,
		stores,
		sourceStores,
		selectedStoreId,
		products: products.items,
		transfers
	};
};
