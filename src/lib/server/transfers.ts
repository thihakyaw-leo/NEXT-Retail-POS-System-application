import type {
	CurrentUser,
	ProductSummary,
	TransferRequest,
	TransferItemSummary,
	TransferResponse,
	TransferSummary
} from '$lib/types';
import type { PosBindings } from '$lib/server/env';
import type { D1PreparedStatement } from '$lib/server/cloudflare';
import { DEFAULT_STORE_ID, PosHttpError, getStoreSummary, listProducts } from '$lib/server/pos';

type TransferRow = {
	id: string;
	transfer_number: string;
	from_store_id: string;
	from_store_name: string;
	to_store_id: string;
	to_store_name: string;
	status: 'requested' | 'approved';
	note: string | null;
	requested_by_user_id: string;
	requested_by_name: string;
	approved_by_user_id: string | null;
	approved_by_name: string | null;
	created_at: string;
	approved_at: string | null;
};

type TransferItemRow = {
	id: string;
	transfer_id: string;
	product_id: string;
	product_name_snapshot: string;
	quantity: number;
};

export async function listTransfers(env: PosBindings, user: CurrentUser): Promise<TransferSummary[]> {
	const result = await env.DB.prepare(
		`SELECT
			t.id,
			t.transfer_number,
			t.from_store_id,
			sf.name AS from_store_name,
			t.to_store_id,
			st.name AS to_store_name,
			t.status,
			t.note,
			t.requested_by_user_id,
			ru.name AS requested_by_name,
			t.approved_by_user_id,
			au.name AS approved_by_name,
			t.created_at,
			t.approved_at
		FROM transfers t
		INNER JOIN stores sf ON sf.id = t.from_store_id
		INNER JOIN stores st ON st.id = t.to_store_id
		INNER JOIN users ru ON ru.id = t.requested_by_user_id
		LEFT JOIN users au ON au.id = t.approved_by_user_id
		WHERE (? = 'admin' OR t.from_store_id = ? OR t.to_store_id = ?)
		ORDER BY t.created_at DESC`
	)
		.bind(user.role, user.storeId ?? '', user.storeId ?? '')
		.all<TransferRow>();

	const itemResult = await env.DB.prepare(
		`SELECT id, transfer_id, product_id, product_name_snapshot, quantity
		FROM transfer_items
		ORDER BY rowid ASC`
	).all<TransferItemRow>();
	const itemsByTransfer = new Map<string, TransferItemSummary[]>();

	for (const item of itemResult.results) {
		const list = itemsByTransfer.get(item.transfer_id) ?? [];
		list.push({
			id: item.id,
			productId: item.product_id,
			productName: item.product_name_snapshot,
			quantity: item.quantity
		});
		itemsByTransfer.set(item.transfer_id, list);
	}

	return result.results.map((row) => ({
		id: row.id,
		transferNumber: row.transfer_number,
		fromStoreId: row.from_store_id,
		fromStoreName: row.from_store_name,
		toStoreId: row.to_store_id,
		toStoreName: row.to_store_name,
		status: row.status,
		note: row.note,
		requestedByUserId: row.requested_by_user_id,
		requestedByName: row.requested_by_name,
		approvedByUserId: row.approved_by_user_id,
		approvedByName: row.approved_by_name,
		createdAt: row.created_at,
		approvedAt: row.approved_at,
		items: itemsByTransfer.get(row.id) ?? []
	}));
}

export async function createTransfer(
	env: PosBindings,
	requester: CurrentUser,
	payload: TransferRequest
): Promise<TransferResponse> {
	const fromStoreId = payload.fromStoreId ?? requester.storeId ?? DEFAULT_STORE_ID;
	const toStoreId = payload.toStoreId;

	if (!toStoreId) {
		throw new PosHttpError(400, 'A destination store is required.');
	}

	if (fromStoreId === toStoreId) {
		throw new PosHttpError(400, 'Transfers require different source and destination stores.');
	}

	const normalizedItems = payload.items.map((item) => ({
		productId: item.productId,
		quantity: item.quantity
	}));

	if (normalizedItems.length === 0) {
		throw new PosHttpError(400, 'At least one transfer item is required.');
	}

	if (normalizedItems.some((item) => !item.productId || !Number.isInteger(item.quantity) || item.quantity <= 0)) {
		throw new PosHttpError(400, 'Transfer items need a product ID and a positive quantity.');
	}

	await Promise.all([getStoreSummary(env, fromStoreId), getStoreSummary(env, toStoreId)]);
	const sourceProducts = await listProducts(env, {
		storeId: fromStoreId,
		pageSize: 100
	});
	const productsById = new Map(sourceProducts.items.map((product) => [product.id, product]));

	for (const item of normalizedItems) {
		const product = productsById.get(item.productId);

		if (!product) {
			throw new PosHttpError(404, 'One or more transfer products could not be found.');
		}

		if (product.stockQuantity < item.quantity) {
			throw new PosHttpError(409, `${product.name} only has ${product.stockQuantity} unit(s) available.`);
		}
	}

	const transferId = crypto.randomUUID();
	const transferNumber = `TR-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${transferId
		.slice(0, 6)
		.toUpperCase()}`;
	const createdAt = new Date().toISOString();
	const note = payload.note?.trim() || null;
	const session = env.DB.withSession('first-primary');
	const statements: D1PreparedStatement[] = [
		session
			.prepare(
				`INSERT INTO transfers (
					id,
					transfer_number,
					from_store_id,
					to_store_id,
					status,
					note,
					requested_by_user_id,
					created_at
				) VALUES (?, ?, ?, ?, 'requested', ?, ?, ?)`
			)
			.bind(transferId, transferNumber, fromStoreId, toStoreId, note, requester.id, createdAt)
	];

	const itemSummaries: TransferItemSummary[] = [];

	for (const item of normalizedItems) {
		const product = productsById.get(item.productId) as ProductSummary;
		const transferItemId = crypto.randomUUID();
		itemSummaries.push({
			id: transferItemId,
			productId: item.productId,
			productName: product.name,
			quantity: item.quantity
		});
		statements.push(
			session
				.prepare(
					`INSERT INTO transfer_items (
						id,
						transfer_id,
						product_id,
						product_name_snapshot,
						quantity
					) VALUES (?, ?, ?, ?, ?)`
				)
				.bind(transferItemId, transferId, item.productId, product.name, item.quantity)
		);
	}

	await session.batch(statements);

	return {
		transfer: {
			id: transferId,
			transferNumber,
			fromStoreId,
			fromStoreName: (await getStoreSummary(env, fromStoreId)).name,
			toStoreId,
			toStoreName: (await getStoreSummary(env, toStoreId)).name,
			status: 'requested',
			note,
			requestedByUserId: requester.id,
			requestedByName: requester.name,
			approvedByUserId: null,
			approvedByName: null,
			createdAt,
			approvedAt: null,
			items: itemSummaries
		},
		updatedProducts: []
	};
}

export async function approveTransfer(
	env: PosBindings,
	transferId: string,
	approver: CurrentUser
): Promise<TransferResponse> {
	const transfer = await env.DB.prepare(
		`SELECT
			t.id,
			t.transfer_number,
			t.from_store_id,
			sf.name AS from_store_name,
			t.to_store_id,
			st.name AS to_store_name,
			t.status,
			t.note,
			t.requested_by_user_id,
			ru.name AS requested_by_name,
			t.approved_by_user_id,
			au.name AS approved_by_name,
			t.created_at,
			t.approved_at
		FROM transfers t
		INNER JOIN stores sf ON sf.id = t.from_store_id
		INNER JOIN stores st ON st.id = t.to_store_id
		INNER JOIN users ru ON ru.id = t.requested_by_user_id
		LEFT JOIN users au ON au.id = t.approved_by_user_id
		WHERE t.id = ?`
	)
		.bind(transferId)
		.first<TransferRow>();

	if (!transfer) {
		throw new PosHttpError(404, 'Transfer request not found.');
	}

	if (transfer.status !== 'requested') {
		throw new PosHttpError(409, 'Transfer request has already been processed.');
	}

	const itemsResult = await env.DB.prepare(
		`SELECT id, transfer_id, product_id, product_name_snapshot, quantity
		FROM transfer_items
		WHERE transfer_id = ?`
	)
		.bind(transferId)
		.all<TransferItemRow>();
	const sourceProducts = await listProducts(env, {
		storeId: transfer.from_store_id,
		pageSize: 100
	});
	const productsById = new Map(sourceProducts.items.map((product) => [product.id, product]));

	for (const item of itemsResult.results) {
		const product = productsById.get(item.product_id);

		if (!product || product.stockQuantity < item.quantity) {
			throw new PosHttpError(
				409,
				`${item.product_name_snapshot} does not have enough stock to approve this transfer.`
			);
		}
	}

	const approvedAt = new Date().toISOString();
	const session = env.DB.withSession('first-primary');
	const updatedProducts = new Map<string, { storeId: string; stockQuantity: number }>();
	const statements: D1PreparedStatement[] = [
		session
			.prepare(
				`UPDATE transfers
				SET status = 'approved', approved_by_user_id = ?, approved_at = ?
				WHERE id = ?`
			)
			.bind(approver.id, approvedAt, transferId)
	];

	for (const item of itemsResult.results) {
		const product = productsById.get(item.product_id) as ProductSummary;
		const nextSourceStock = product.stockQuantity - item.quantity;
		const destinationCurrent =
			Number(
				await env.DB.prepare(
					`SELECT stock_quantity
					FROM store_stock
					WHERE store_id = ? AND product_id = ?`
				)
					.bind(transfer.to_store_id, item.product_id)
					.first('stock_quantity')
			) || 0;
		const nextDestinationStock = destinationCurrent + item.quantity;

		updatedProducts.set(`${transfer.from_store_id}:${item.product_id}`, {
			storeId: transfer.from_store_id,
			stockQuantity: nextSourceStock
		});
		updatedProducts.set(`${transfer.to_store_id}:${item.product_id}`, {
			storeId: transfer.to_store_id,
			stockQuantity: nextDestinationStock
		});

		statements.push(
			session
				.prepare(
					`UPDATE store_stock
					SET stock_quantity = stock_quantity - ?, updated_at = ?
					WHERE store_id = ? AND product_id = ?`
				)
				.bind(item.quantity, approvedAt, transfer.from_store_id, item.product_id)
		);
		statements.push(
			session
				.prepare(
					`INSERT INTO store_stock (store_id, product_id, stock_quantity, reorder_point, updated_at)
					VALUES (
						?,
						?,
						?,
						COALESCE((SELECT reorder_point FROM store_stock WHERE store_id = ? AND product_id = ?), 0),
						?
					)
					ON CONFLICT(store_id, product_id)
					DO UPDATE SET
						stock_quantity = store_stock.stock_quantity + excluded.stock_quantity,
						updated_at = excluded.updated_at`
				)
				.bind(
					transfer.to_store_id,
					item.product_id,
					item.quantity,
					transfer.to_store_id,
					item.product_id,
					approvedAt
				)
		);

		// products table updates removed (legacy)
	}

	await session.batch(statements);

	return {
		transfer: {
			id: transfer.id,
			transferNumber: transfer.transfer_number,
			fromStoreId: transfer.from_store_id,
			fromStoreName: transfer.from_store_name,
			toStoreId: transfer.to_store_id,
			toStoreName: transfer.to_store_name,
			status: 'approved',
			note: transfer.note,
			requestedByUserId: transfer.requested_by_user_id,
			requestedByName: transfer.requested_by_name,
			approvedByUserId: approver.id,
			approvedByName: approver.name,
			createdAt: transfer.created_at,
			approvedAt,
			items: itemsResult.results.map((item) => ({
				id: item.id,
				productId: item.product_id,
				productName: item.product_name_snapshot,
				quantity: item.quantity
			}))
		},
		updatedProducts: Array.from(updatedProducts.entries()).map(([key, update]) => {
			const [, productId] = key.split(':');
			return {
				id: productId,
				storeId: update.storeId,
				stockQuantity: update.stockQuantity
			};
		})
	};
}
