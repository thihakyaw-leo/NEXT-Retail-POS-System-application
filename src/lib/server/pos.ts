import type { D1PreparedStatement } from '$lib/server/cloudflare';
import type {
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
	image_key: string | null;
};

type StoreRow = {
	id: string;
	name: string;
	address: string | null;
	currency_code: string;
};

class PosHttpError extends Error {
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
		? `WHERE store_id = ?
			AND is_active = 1
			AND (
				name LIKE ? ESCAPE '\\' COLLATE NOCASE
				OR barcode LIKE ? ESCAPE '\\'
			)`
		: `WHERE store_id = ?
			AND is_active = 1`;
	const parameters = search ? [storeId, searchFilter, searchFilter] : [storeId];

	const totalItems =
		Number(
			await env.DB.prepare(
				`SELECT COUNT(*) AS total
				FROM products
				${whereClause}`
			)
				.bind(...parameters)
				.first('total')
		) || 0;

	const itemsResult = await env.DB.prepare(
		`SELECT
			id,
			store_id,
			name,
			barcode,
			description,
			price_cents,
			stock_quantity,
			image_key
		FROM products
		${whereClause}
		ORDER BY name COLLATE NOCASE ASC
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

	if (!Number.isInteger(payload.cashReceivedCents) || payload.cashReceivedCents < 0) {
		throw new PosHttpError(400, 'Cash received must be a positive cent value.');
	}

	const session = env.DB.withSession('first-primary');
	const productIds = aggregatedItems.map((item) => item.productId);
	const placeholders = productIds.map(() => '?').join(', ');
	const productResult = await session
		.prepare(
			`SELECT
				id,
				store_id,
				name,
				barcode,
				description,
				price_cents,
				stock_quantity,
				image_key
			FROM products
			WHERE store_id = ? AND id IN (${placeholders})`
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
					receipt_number,
					status,
					item_count,
					subtotal_cents,
					total_amount_cents,
					cash_received_cents,
					change_due_cents,
					created_at
				) VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				transactionId,
				store.id,
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
					`UPDATE products
					SET stock_quantity = stock_quantity - ?, updated_at = ?
					WHERE id = ?`
				)
				.bind(item.quantity, createdAt, item.productId)
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
			id,
			store_id,
			name,
			barcode,
			description,
			price_cents,
			stock_quantity,
			image_key
		FROM products
		WHERE id = ?`
	)
		.bind(productId)
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
