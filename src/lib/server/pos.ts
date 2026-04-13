import type { D1PreparedStatement } from '$lib/server/cloudflare';
import type {
	OfflineSaleSubmission,
	OfflineSyncAccepted,
	OfflineSyncRejected,
	OfflineSyncRequest,
	OfflineSyncResponse,
	PaginationMeta,
	ProductSummary,
	ProductsResponse,
	Receipt,
	ReceiptItem,
	SaleRequest,
	SaleRequestItem,
	SaleResponse,
	StoreSummary
} from '$lib/types';
import type { PosBindings } from '$lib/server/env';

export const DEFAULT_STORE_ID = 'store-hq';
const DEFAULT_PAGE_SIZE = 12;
const MAX_PAGE_SIZE = 36;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

type ProductRow = {
	id: string;
	store_id: string;
	name: string;
	barcode: string;
	description: string | null;
	price_cents: number;
	stock_quantity: number;
	reorder_point: number;
	image_key: string | null;
};

type StoreRow = {
	id: string;
	name: string;
	address: string | null;
	currency_code: string;
};

export class PosHttpError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export function parseProductsRequest(url: URL) {
	return {
		page: clampPositiveInteger(url.searchParams.get('page'), 1),
		pageSize: clampPositiveInteger(url.searchParams.get('pageSize'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
		search: (url.searchParams.get('search') ?? url.searchParams.get('q') ?? '').trim()
	};
}

export async function getStoreSummary(
	env: PosBindings,
	storeId = DEFAULT_STORE_ID
): Promise<StoreSummary> {
	const store = await env.DB.prepare(
		`SELECT id, name, address, currency_code
		FROM stores
		WHERE id = ?`
	)
		.bind(storeId)
		.first<StoreRow>();

	if (!store) {
		throw new PosHttpError(404, 'Store not found.');
	}

	return {
		id: store.id,
		name: store.name,
		address: store.address,
		currencyCode: store.currency_code
	};
}

export async function listProducts(
	env: PosBindings,
	options: {
		storeId?: string;
		page?: number;
		pageSize?: number;
		search?: string;
	}
): Promise<ProductsResponse> {
	const storeId = options.storeId ?? DEFAULT_STORE_ID;
	const page = clampPositiveInteger(options.page, 1);
	const pageSize = clampPositiveInteger(options.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
	const search = (options.search ?? '').trim();
	const offset = (page - 1) * pageSize;
	const searchFilter = search ? `%${escapeLikeValue(search)}%` : null;

	const whereClause = search
		? `WHERE ss.store_id = ?
			AND p.is_active = 1
			AND (
				p.name LIKE ? ESCAPE '\\' COLLATE NOCASE
				OR p.barcode LIKE ? ESCAPE '\\'
			)`
		: `WHERE ss.store_id = ?
			AND p.is_active = 1`;
	const parameters = search ? [storeId, searchFilter, searchFilter] : [storeId];

	const totalItems =
		Number(
			await env.DB.prepare(
				`SELECT COUNT(*) AS total
				FROM products p
				INNER JOIN store_stock ss
					ON ss.product_id = p.id
				${whereClause}`
			)
				.bind(...parameters)
				.first('total')
		) || 0;

	const itemsResult = await env.DB.prepare(
		`SELECT
			p.id,
			ss.store_id,
			p.name,
			p.barcode,
			p.description,
			p.price_cents,
			ss.stock_quantity,
			ss.reorder_point,
			p.image_key
		FROM products p
		INNER JOIN store_stock ss
			ON ss.product_id = p.id
		${whereClause}
		ORDER BY p.name COLLATE NOCASE ASC
		LIMIT ? OFFSET ?`
	)
		.bind(...parameters, pageSize, offset)
		.all<ProductRow>();

	const pagination: PaginationMeta = {
		page,
		pageSize,
		totalItems,
		totalPages: Math.max(1, Math.ceil(totalItems / pageSize)),
		hasNextPage: offset + pageSize < totalItems,
		hasPreviousPage: page > 1
	};

	return {
		items: itemsResult.results.map(mapProductRow),
		pagination,
		search
	};
}

export async function createSale(env: PosBindings, payload: SaleRequest): Promise<SaleResponse> {
	const store = await getStoreSummary(env, payload.storeId ?? DEFAULT_STORE_ID);
	const aggregatedItems = aggregateItems(payload.items);

	if (aggregatedItems.length === 0) {
		throw new PosHttpError(400, 'At least one cart item is required.');
	}

	if (!payload.userId) {
		throw new PosHttpError(400, 'A user ID is required for the sale.');
	}

	if (!Number.isInteger(payload.cashReceivedCents) || payload.cashReceivedCents < 0) {
		throw new PosHttpError(400, 'Cash received must be a positive cent value.');
	}

	const session = env.DB.withSession('first-primary');
	const productIds = aggregatedItems.map((item) => item.productId);
	const placeholders = productIds.map(() => '?').join(', ');
	const productResult = await session
		.prepare(
			`SELECT
				p.id,
				ss.store_id,
				p.name,
				p.barcode,
				p.description,
				p.price_cents,
				ss.stock_quantity,
				ss.reorder_point,
				p.image_key
			FROM products p
			INNER JOIN store_stock ss
				ON ss.product_id = p.id
			WHERE ss.store_id = ? AND p.id IN (${placeholders})`
		)
		.bind(store.id, ...productIds)
		.all<ProductRow>();
	const productsById = new Map(productResult.results.map((product) => [product.id, product]));

	const receiptItems: ReceiptItem[] = aggregatedItems.map((item) => {
		const product = productsById.get(item.productId);

		if (!product) {
			throw new PosHttpError(404, 'One or more products could not be found.');
		}

		if (product.stock_quantity < item.quantity) {
			throw new PosHttpError(409, `${product.name} only has ${product.stock_quantity} unit(s) left.`);
		}

		return {
			productId: product.id,
			productName: product.name,
			barcode: product.barcode,
			quantity: item.quantity,
			unitPriceCents: product.price_cents,
			lineTotalCents: product.price_cents * item.quantity
		};
	});

	const subtotalCents = receiptItems.reduce((sum, item) => sum + item.lineTotalCents, 0);

	if (payload.cashReceivedCents < subtotalCents) {
		throw new PosHttpError(400, 'Cash received is lower than the sale total.');
	}

	const createdAt = new Date().toISOString();
	const transactionId = crypto.randomUUID();
	const receiptNumber = `SALE-${createdAt.slice(0, 10).replaceAll('-', '')}-${transactionId
		.slice(0, 6)
		.toUpperCase()}`;
	const changeDueCents = payload.cashReceivedCents - subtotalCents;

	const statements: D1PreparedStatement[] = [
		session
			.prepare(
				`INSERT INTO transactions (
					id,
					store_id,
					user_id,
					receipt_number,
					status,
					item_count,
					subtotal_cents,
					total_amount_cents,
					cash_received_cents,
					change_due_cents,
					created_at
				) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				transactionId,
				store.id,
				payload.userId,
				receiptNumber,
				receiptItems.reduce((count, item) => count + item.quantity, 0),
				subtotalCents,
				subtotalCents,
				payload.cashReceivedCents,
				changeDueCents,
				createdAt
			)
	];

	for (const item of receiptItems) {
		statements.push(
			session
				.prepare(
					`UPDATE store_stock
					SET stock_quantity = stock_quantity - ?, updated_at = ?
					WHERE store_id = ? AND product_id = ?`
				)
				.bind(item.quantity, createdAt, store.id, item.productId)
		);
	}

	for (const item of receiptItems) {
		statements.push(
			session
				.prepare(
					`INSERT INTO transaction_items (
						id,
						transaction_id,
						product_id,
						product_name_snapshot,
						barcode_snapshot,
						quantity,
						unit_price_cents,
						line_total_cents
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					crypto.randomUUID(),
					transactionId,
					item.productId,
					item.productName,
					item.barcode,
					item.quantity,
					item.unitPriceCents,
					item.lineTotalCents
				)
		);
	}

	try {
		await session.batch(statements);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to complete the sale.';

		if (message.includes('CHECK constraint failed')) {
			throw new PosHttpError(409, 'Stock changed during checkout. Refresh the catalog and try again.');
		}

		throw error;
	}

	const receipt: Receipt = {
		transactionId,
		receiptNumber,
		storeName: store.name,
		storeAddress: store.address,
		createdAt,
		itemCount: receiptItems.reduce((count, item) => count + item.quantity, 0),
		subtotalCents,
		totalAmountCents: subtotalCents,
		cashReceivedCents: payload.cashReceivedCents,
		changeDueCents,
		items: receiptItems
	};

	return {
		receipt,
		updatedProducts: receiptItems.map((item) => {
			const product = productsById.get(item.productId);

			return {
				id: item.productId,
				stockQuantity: (product?.stock_quantity ?? 0) - item.quantity
			};
		})
	};
}

export async function syncOfflineSales(
	env: PosBindings,
	payload: OfflineSyncRequest
): Promise<OfflineSyncResponse> {
	const sales = payload.sales ?? [];

	if (sales.length === 0) {
		return {
			accepted: [],
			rejected: [],
			updatedProducts: []
		};
	}

	const session = env.DB.withSession('first-primary');
	const uniqueStoreIds = Array.from(new Set(sales.map((sale) => sale.storeId || DEFAULT_STORE_ID)));
	const uniqueProductIds = Array.from(
		new Set(sales.flatMap((sale) => sale.items.map((item) => item.productId)))
	);

	const storesPlaceholders = uniqueStoreIds.map(() => '?').join(', ');
	const productsPlaceholders = uniqueProductIds.map(() => '?').join(', ');

	const storesResult = await session
		.prepare(
			`SELECT id, name, address, currency_code
			FROM stores
			WHERE id IN (${storesPlaceholders})`
		)
		.bind(...uniqueStoreIds)
		.all<StoreRow>();
	const productsResult =
		uniqueProductIds.length > 0
			? await session
					.prepare(
						`SELECT
							p.id,
							ss.store_id,
							p.name,
							p.barcode,
							p.description,
							p.price_cents,
							ss.stock_quantity,
							ss.reorder_point,
							p.image_key
						FROM products p
						INNER JOIN store_stock ss
							ON ss.product_id = p.id
						WHERE ss.store_id IN (${storesPlaceholders})
							AND p.id IN (${productsPlaceholders})`
					)
					.bind(...uniqueStoreIds, ...uniqueProductIds)
					.all<ProductRow>()
			: {
					results: []
				};

	const storesById = new Map(storesResult.results.map((store) => [store.id, store]));
	const productsById = new Map(
		productsResult.results.map((product) => [`${product.store_id}:${product.id}`, product])
	);
	const virtualStock = new Map(
		productsResult.results.map((product) => [`${product.store_id}:${product.id}`, product.stock_quantity])
	);
	const touchedProductIds = new Map<string, number>();
	const statements: D1PreparedStatement[] = [];
	const accepted: OfflineSyncAccepted[] = [];
	const rejected: OfflineSyncRejected[] = [];

	for (const sale of sales) {
		const storeId = sale.storeId || DEFAULT_STORE_ID;
		const store = storesById.get(storeId);

		if (!store) {
			rejected.push({
				localId: sale.localId,
				reason: 'invalid_sale',
				message: 'Store not found for the offline sale.'
			});
			continue;
		}

		let aggregatedItems: SaleRequestItem[];

		try {
			aggregatedItems = aggregateItems(sale.items);
		} catch (error) {
			rejected.push({
				localId: sale.localId,
				reason: 'invalid_sale',
				message: error instanceof Error ? error.message : 'The offline sale payload is invalid.'
			});
			continue;
		}

		if (aggregatedItems.length === 0) {
			rejected.push({
				localId: sale.localId,
				reason: 'invalid_sale',
				message: 'The offline sale does not contain any items.'
			});
			continue;
		}

		if (
			!sale.userId ||
			!Number.isInteger(sale.cashReceivedCents) ||
			!Number.isInteger(sale.totalAmountCents) ||
			sale.cashReceivedCents < sale.totalAmountCents
		) {
			rejected.push({
				localId: sale.localId,
				reason: 'invalid_sale',
				message: 'The offline sale has invalid cash totals.'
			});
			continue;
		}

		const receiptItems: ReceiptItem[] = [];
		let hasConflict = false;
		let conflictMessage = 'Stock conflict detected during offline sync.';

		for (const item of aggregatedItems) {
			const product = productsById.get(`${storeId}:${item.productId}`);

			if (!product || product.store_id !== storeId) {
				hasConflict = true;
				conflictMessage = 'One or more products no longer exist in this store.';
				break;
			}

			const remainingStock =
				virtualStock.get(`${storeId}:${item.productId}`) ?? product.stock_quantity;

			if (remainingStock < item.quantity) {
				hasConflict = true;
				conflictMessage = `${product.name} only has ${remainingStock} unit(s) available for sync.`;
				touchedProductIds.set(item.productId, remainingStock);
				break;
			}

			receiptItems.push({
				productId: product.id,
				productName: product.name,
				barcode: product.barcode,
				quantity: item.quantity,
				unitPriceCents: product.price_cents,
				lineTotalCents: product.price_cents * item.quantity
			});
		}

		if (hasConflict) {
			rejected.push({
				localId: sale.localId,
				reason: 'stock_conflict',
				message: conflictMessage
			});
			continue;
		}

		const calculatedTotal = receiptItems.reduce((total, item) => total + item.lineTotalCents, 0);

		if (
			calculatedTotal !== sale.subtotalCents ||
			calculatedTotal !== sale.totalAmountCents ||
			sale.changeDueCents !== sale.cashReceivedCents - sale.totalAmountCents
		) {
			rejected.push({
				localId: sale.localId,
				reason: 'invalid_sale',
				message: 'The offline sale total no longer matches the product catalog.'
			});
			continue;
		}

		const transactionId = crypto.randomUUID();
		const syncedAt = new Date().toISOString();

		statements.push(
			session
				.prepare(
				`INSERT INTO transactions (
						id,
						store_id,
						user_id,
						receipt_number,
						status,
						item_count,
						subtotal_cents,
						total_amount_cents,
						cash_received_cents,
						change_due_cents,
						created_at
					) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					transactionId,
					storeId,
					sale.userId,
					sale.receiptNumber,
					receiptItems.reduce((count, item) => count + item.quantity, 0),
					calculatedTotal,
					calculatedTotal,
					sale.cashReceivedCents,
					sale.changeDueCents,
					sale.createdAt
				)
		);

		for (const item of receiptItems) {
			const stockKey = `${storeId}:${item.productId}`;
			const nextStock = (virtualStock.get(stockKey) ?? 0) - item.quantity;
			virtualStock.set(stockKey, nextStock);
			touchedProductIds.set(item.productId, nextStock);

			statements.push(
				session
					.prepare(
						`UPDATE store_stock
						SET stock_quantity = stock_quantity - ?, updated_at = ?
						WHERE store_id = ? AND product_id = ?`
					)
					.bind(item.quantity, syncedAt, storeId, item.productId)
			);

			statements.push(
				session
					.prepare(
						`INSERT INTO transaction_items (
							id,
							transaction_id,
							product_id,
							product_name_snapshot,
							barcode_snapshot,
							quantity,
							unit_price_cents,
							line_total_cents
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
					)
					.bind(
						crypto.randomUUID(),
						transactionId,
						item.productId,
						item.productName,
						item.barcode,
						item.quantity,
						item.unitPriceCents,
						item.lineTotalCents
					)
			);
		}

		accepted.push({
			localId: sale.localId,
			transactionId,
			receiptNumber: sale.receiptNumber,
			syncedAt
		});
	}

	if (statements.length > 0) {
		try {
			await session.batch(statements);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to sync offline sales.';

			if (message.includes('CHECK constraint failed')) {
				throw new PosHttpError(409, 'Stock changed during offline sync. Retry after refreshing the catalog.');
			}

			throw new PosHttpError(500, message);
		}
	}

	return {
		accepted,
		rejected,
		updatedProducts: Array.from(touchedProductIds.entries()).map(([id, stockQuantity]) => ({
			id,
			stockQuantity
		}))
	};
}

export async function uploadProductImage(
	env: PosBindings,
	productId: string,
	file: File
): Promise<ProductSummary> {
	if (!file.size) {
		throw new PosHttpError(400, 'Choose an image file to upload.');
	}

	if (file.size > MAX_IMAGE_BYTES) {
		throw new PosHttpError(400, 'Product images must be 5MB or smaller.');
	}

	const product = await env.DB.prepare(
		`SELECT
			p.id,
			ss.store_id,
			p.name,
			p.barcode,
			p.description,
			p.price_cents,
			ss.stock_quantity,
			ss.reorder_point,
			p.image_key
		FROM products p
		INNER JOIN store_stock ss ON ss.product_id = p.id
		WHERE p.id = ? AND ss.store_id = (SELECT store_id FROM products WHERE id = ?)`
	)
		.bind(productId, productId)
		.first<ProductRow>();

	if (!product) {
		throw new PosHttpError(404, 'Product not found.');
	}

	const safeName = sanitizeFilename(file.name);
	const objectKey = `products/${productId}/${crypto.randomUUID()}-${safeName}`;

	await env.PRODUCT_IMAGES.put(objectKey, await file.arrayBuffer(), {
		httpMetadata: {
			contentType: file.type || 'application/octet-stream',
			cacheControl: 'public, max-age=86400'
		},
		customMetadata: {
			productId,
			uploadedAt: new Date().toISOString()
		}
	});

	await env.DB.prepare(
		`UPDATE products
		SET image_key = ?, updated_at = ?
		WHERE id = ?`
	)
		.bind(objectKey, new Date().toISOString(), productId)
		.run();

	if (product.image_key) {
		await env.PRODUCT_IMAGES.delete(product.image_key);
	}

	return mapProductRow({
		...product,
		image_key: objectKey
	});
}

export async function fetchProductImage(env: PosBindings, key: string) {
	const object = await env.PRODUCT_IMAGES.get(key);

	if (!object) {
		return null;
	}

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('etag', object.httpEtag);

	if (!headers.has('Cache-Control')) {
		headers.set('Cache-Control', 'public, max-age=3600');
	}

	return new Response(object.body, {
		headers
	});
}

export function toApiError(error: unknown) {
	if (error instanceof PosHttpError) {
		return {
			status: error.status,
			body: {
				message: error.message
			}
		};
	}

	if (
		typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		typeof error.status === 'number'
	) {
		const message =
			'body' in error &&
			typeof error.body === 'object' &&
			error.body !== null &&
			'message' in error.body &&
			typeof error.body.message === 'string'
				? error.body.message
				: error instanceof Error
					? error.message
					: 'Request failed.';

		return {
			status: error.status,
			body: {
				message
			}
		};
	}

	return {
		status: 500,
		body: {
			message: error instanceof Error ? error.message : 'Unexpected server error.'
		}
	};
}

function aggregateItems(items: SaleRequestItem[]) {
	const quantities = new Map<string, number>();

	for (const item of items) {
		if (!item.productId || !Number.isInteger(item.quantity) || item.quantity <= 0) {
			throw new PosHttpError(400, 'Each cart item needs a product ID and a positive quantity.');
		}

		quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
	}

	return Array.from(quantities.entries()).map(([productId, quantity]) => ({
		productId,
		quantity
	}));
}

function mapProductRow(row: ProductRow): ProductSummary {
	return {
		id: row.id,
		storeId: row.store_id,
		name: row.name,
		barcode: row.barcode,
		description: row.description,
		priceCents: row.price_cents,
		stockQuantity: row.stock_quantity,
		reorderPoint: row.reorder_point,
		lowStock: row.stock_quantity <= row.reorder_point,
		imageKey: row.image_key,
		imageUrl: row.image_key ? `/api/product-images/${encodeKeyPath(row.image_key)}` : null
	};
}

function clampPositiveInteger(
	value: string | number | null | undefined,
	fallback: number,
	maximum = Number.MAX_SAFE_INTEGER
) {
	const parsed =
		typeof value === 'number'
			? value
			: typeof value === 'string'
				? Number.parseInt(value, 10)
				: Number.NaN;

	if (!Number.isFinite(parsed) || parsed < 1) {
		return fallback;
	}

	return Math.min(Math.trunc(parsed), maximum);
}

function escapeLikeValue(value: string) {
	return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function sanitizeFilename(filename: string) {
	const normalized = filename.trim().toLowerCase().replace(/[^a-z0-9.-]+/g, '-');
	return normalized || 'product-image.bin';
}

function encodeKeyPath(value: string) {
	return value
		.split('/')
		.map((segment) => encodeURIComponent(segment))
		.join('/');
}
