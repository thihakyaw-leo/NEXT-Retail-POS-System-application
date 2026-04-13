import type {
	BatchSummary,
	EmailDeliverySummary,
	InventoryActionType,
	InventorySyncRequest,
	InventorySyncResponse,
	LowStockDispatchResponse,
	LowStockReportItem,
	LowStockReportResponse,
	OfflineInventoryActionSubmission,
	PendingInventoryActionRecord,
	ProductSummary,
	PurchaseOrderItemSummary,
	PurchaseOrderRequest,
	PurchaseOrderRequestItem,
	PurchaseOrderResponse,
	PurchaseOrderSummary,
	StockAdjustmentRequest,
	StockAdjustmentResponse,
	StockMovementSummary,
	SupplierSummary
} from '$lib/types';
import type { PosBindings } from '$lib/server/env';
import { DEFAULT_STORE_ID, PosHttpError, getStoreSummary, listProducts } from '$lib/server/pos';
import type { D1PreparedStatement } from '$lib/server/cloudflare';

type InventoryProductRow = {
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

type SupplierRow = {
	id: string;
	name: string;
	contact_name: string | null;
	email: string | null;
	phone: string | null;
	lead_time_days: number;
};

type BatchRow = {
	id: string;
	product_id: string;
	product_name: string;
	batch_code: string;
	expiry_date: string | null;
	received_quantity: number;
	remaining_quantity: number;
	unit_cost_cents: number;
};

type PurchaseOrderRow = {
	id: string;
	store_id: string;
	supplier_id: string;
	supplier_name: string;
	po_number: string;
	status: 'draft' | 'received';
	notes: string | null;
	total_cost_cents: number;
	received_at: string | null;
	created_at: string;
};

type PurchaseOrderItemRow = {
	id: string;
	product_id: string;
	product_name_snapshot: string;
	quantity: number;
	unit_cost_cents: number;
	line_total_cents: number;
	batch_code: string;
	expiry_date: string | null;
};

type StockMovementRow = {
	id: string;
	store_id: string;
	product_id: string;
	product_name: string;
	batch_id: string | null;
	source_type: 'purchase_order' | 'stock_adjustment' | 'sale' | 'offline_sync';
	source_id: string;
	movement_type: 'in' | 'out' | 'adjust';
	quantity_delta: number;
	reason: string | null;
	resulting_stock_quantity: number;
	created_at: string;
};

type LowStockRow = {
	product_id: string;
	product_name: string;
	barcode: string;
	stock_quantity: number;
	reorder_point: number;
	next_batch_code: string | null;
	next_expiry_date: string | null;
};

type EmailDeliveryRow = {
	id: string;
	provider: string;
	transport: 'mock' | 'resend';
	recipient: string;
	subject: string;
	status: string;
	provider_message_id: string | null;
	created_at: string;
};

export async function listSuppliers(env: PosBindings): Promise<SupplierSummary[]> {
	const result = await env.DB.prepare(
		`SELECT id, name, contact_name, email, phone, lead_time_days
		FROM suppliers
		ORDER BY name COLLATE NOCASE ASC`
	).all<SupplierRow>();

	return result.results.map((row) => ({
		id: row.id,
		name: row.name,
		contactName: row.contact_name,
		email: row.email,
		phone: row.phone,
		leadTimeDays: row.lead_time_days
	}));
}

export async function listRecentBatches(
	env: PosBindings,
	storeId = DEFAULT_STORE_ID,
	limit = 8
): Promise<BatchSummary[]> {
	const result = await env.DB.prepare(
		`SELECT
			b.id,
			b.product_id,
			p.name AS product_name,
			b.batch_code,
			b.expiry_date,
			b.received_quantity,
			b.remaining_quantity,
			b.unit_cost_cents
		FROM batches b
		INNER JOIN products p ON p.id = b.product_id
		WHERE b.store_id = ?
		ORDER BY b.created_at DESC
		LIMIT ?`
	)
		.bind(storeId, limit)
		.all<BatchRow>();

	return result.results.map(mapBatchRow);
}

export async function listRecentStockMovements(
	env: PosBindings,
	storeId = DEFAULT_STORE_ID,
	limit = 12
): Promise<StockMovementSummary[]> {
	const result = await env.DB.prepare(
		`SELECT
			m.id,
			m.store_id,
			m.product_id,
			p.name AS product_name,
			m.batch_id,
			m.source_type,
			m.source_id,
			m.movement_type,
			m.quantity_delta,
			m.reason,
			m.resulting_stock_quantity,
			m.created_at
		FROM stock_movements m
		INNER JOIN products p ON p.id = m.product_id
		WHERE m.store_id = ?
		ORDER BY m.created_at DESC
		LIMIT ?`
	)
		.bind(storeId, limit)
		.all<StockMovementRow>();

	return result.results.map(mapMovementRow);
}

export async function listLowStockReport(
	env: PosBindings,
	storeId = DEFAULT_STORE_ID
): Promise<LowStockReportResponse> {
	const store = await getStoreSummary(env, storeId);
	const generatedAt = new Date().toISOString();
	const result = await env.DB.prepare(
		`SELECT
			p.id AS product_id,
			p.name AS product_name,
			p.barcode,
			ss.stock_quantity,
			ss.reorder_point,
			(
				SELECT b.batch_code
				FROM batches b
				WHERE b.product_id = p.id
					AND b.store_id = ss.store_id
					AND b.remaining_quantity > 0
					AND b.expiry_date IS NOT NULL
				ORDER BY b.expiry_date ASC, b.created_at ASC
				LIMIT 1
			) AS next_batch_code,
			(
				SELECT b.expiry_date
				FROM batches b
				WHERE b.product_id = p.id
					AND b.store_id = ss.store_id
					AND b.remaining_quantity > 0
					AND b.expiry_date IS NOT NULL
				ORDER BY b.expiry_date ASC, b.created_at ASC
				LIMIT 1
			) AS next_expiry_date
		FROM products p
		INNER JOIN store_stock ss ON ss.product_id = p.id
		WHERE ss.store_id = ?
			AND p.is_active = 1
			AND ss.stock_quantity <= ss.reorder_point
		ORDER BY (ss.reorder_point - ss.stock_quantity) DESC, p.name COLLATE NOCASE ASC`
	)
		.bind(storeId)
		.all<LowStockRow>();
	const lastDelivery = await env.DB.prepare(
		`SELECT
			id,
			provider,
			transport,
			recipient,
			subject,
			status,
			provider_message_id,
			created_at
		FROM email_deliveries
		ORDER BY created_at DESC
		LIMIT 1`
	).first<EmailDeliveryRow>();

	return {
		generatedAt,
		store,
		items: result.results.map((row) => ({
			productId: row.product_id,
			productName: row.product_name,
			barcode: row.barcode,
			stockQuantity: row.stock_quantity,
			reorderPoint: row.reorder_point,
			shortageQuantity: Math.max(row.reorder_point - row.stock_quantity, 0),
			nextBatchCode: row.next_batch_code,
			nextExpiryDate: row.next_expiry_date,
			daysUntilExpiry: calculateDaysUntil(row.next_expiry_date, generatedAt)
		})),
		lastDelivery: lastDelivery ? mapEmailDeliveryRow(lastDelivery) : null
	};
}

export async function dispatchLowStockAlert(
	env: PosBindings,
	storeId = DEFAULT_STORE_ID
): Promise<LowStockDispatchResponse> {
	const report = await listLowStockReport(env, storeId);
	const recipient = env.LOW_STOCK_REPORT_TO?.trim() || 'ops@retail-pos.example';
	const from = env.LOW_STOCK_REPORT_FROM?.trim() || 'alerts@retail-pos.example';
	const transport: 'mock' | 'resend' =
		env.EMAIL_TRANSPORT === 'resend' && env.RESEND_API_KEY ? 'resend' : 'mock';
	const provider = transport === 'resend' ? 'resend' : 'mock-resend';
	const subject = `${report.store.name} low stock report`;
	const bodyText = renderLowStockText(report);
	const bodyHtml = renderLowStockHtml(report);
	const payload = {
		from,
		to: [recipient],
		subject,
		text: bodyText,
		html: bodyHtml
	};
	const createdAt = new Date().toISOString();
	const deliveryId = crypto.randomUUID();
	let providerMessageId: string | null = null;
	let status = transport === 'mock' ? 'mocked' : 'queued';

	if (transport === 'resend') {
		const response = await fetch(
			`${env.RESEND_API_BASE_URL?.trim() || 'https://api.resend.com'}/emails`,
			{
				method: 'POST',
				headers: {
					authorization: `Bearer ${env.RESEND_API_KEY}`,
					'content-type': 'application/json'
				},
				body: JSON.stringify(payload)
			}
		);
		const responsePayload = (await response.json()) as { id?: string; message?: string };

		if (!response.ok) {
			throw new PosHttpError(
				502,
				responsePayload.message || 'Resend rejected the low stock report request.'
			);
		}

		providerMessageId = responsePayload.id ?? null;
	} else {
		providerMessageId = `mock-${deliveryId.slice(0, 12)}`;
	}

	await env.DB.prepare(
		`INSERT INTO email_deliveries (
			id,
			provider,
			transport,
			recipient,
			subject,
			status,
			provider_message_id,
			payload_json,
			created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			deliveryId,
			provider,
			transport,
			recipient,
			subject,
			status,
			providerMessageId,
			JSON.stringify(payload),
			createdAt
		)
		.run();

	return {
		report: {
			...report,
			lastDelivery: {
				id: deliveryId,
				provider,
				transport,
				recipient,
				subject,
				status,
				providerMessageId,
				createdAt
			}
		},
		delivery: {
			id: deliveryId,
			provider,
			transport,
			recipient,
			subject,
			status,
			providerMessageId,
			createdAt
		}
	};
}

export async function createPurchaseOrder(
	env: PosBindings,
	payload: PurchaseOrderRequest
): Promise<PurchaseOrderResponse> {
	const storeId = payload.storeId ?? DEFAULT_STORE_ID;
	await getStoreSummary(env, storeId);
	const supplier = await env.DB.prepare(
		`SELECT id, name, contact_name, email, phone, lead_time_days
		FROM suppliers
		WHERE id = ?`
	)
		.bind(payload.supplierId)
		.first<SupplierRow>();

	if (!supplier) {
		throw new PosHttpError(404, 'Supplier not found.');
	}

	const items = normalizePurchaseOrderItems(payload.items);
	const productIds = Array.from(new Set(items.map((item) => item.productId)));
	const productCatalog = await listProducts(env, {
		storeId,
		pageSize: 100
	});
	const productsById = new Map(
		productCatalog.items
			.filter((product) => productIds.includes(product.id))
			.map((product) => [product.id, product])
	);

	if (productsById.size !== productIds.length) {
		throw new PosHttpError(404, 'One or more purchase order products could not be found.');
	}

	const purchaseOrderId = crypto.randomUUID();
	const createdAt = new Date().toISOString();
	const receivedAt = payload.receiveNow === false ? null : createdAt;
	const status: PurchaseOrderSummary['status'] = receivedAt ? 'received' : 'draft';
	const poNumber = `PO-${createdAt.slice(0, 10).replaceAll('-', '')}-${purchaseOrderId
		.slice(0, 6)
		.toUpperCase()}`;
	const totalCostCents = items.reduce((total, item) => total + item.quantity * item.unitCostCents, 0);
	const notes = payload.notes?.trim() || null;
	const session = env.DB.withSession('first-primary');
	const virtualStock = new Map(
		productCatalog.items
			.filter((product) => productIds.includes(product.id))
			.map((product) => [product.id, product.stockQuantity])
	);
	const updatedProducts = new Map<string, number>();
	const itemSummaries: PurchaseOrderItemSummary[] = [];
	const batchSummaries: BatchSummary[] = [];
	const statements: D1PreparedStatement[] = [
		session
			.prepare(
				`INSERT INTO purchase_orders (
					id,
					store_id,
					supplier_id,
					po_number,
					status,
					notes,
					total_cost_cents,
					received_at,
					created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				purchaseOrderId,
				storeId,
				supplier.id,
				poNumber,
				status,
				notes,
				totalCostCents,
				receivedAt,
				createdAt
			)
	];

	for (const item of items) {
		const product = productsById.get(item.productId);

		if (!product) {
			throw new PosHttpError(404, 'One or more purchase order products could not be found.');
		}

		const poItemId = crypto.randomUUID();
		const lineTotalCents = item.quantity * item.unitCostCents;
		itemSummaries.push({
			id: poItemId,
			productId: item.productId,
			productName: product.name,
			quantity: item.quantity,
			unitCostCents: item.unitCostCents,
			lineTotalCents,
			batchCode: item.batchCode,
			expiryDate: item.expiryDate
		});
		statements.push(
			session
				.prepare(
					`INSERT INTO po_items (
						id,
						purchase_order_id,
						product_id,
						product_name_snapshot,
						quantity,
						unit_cost_cents,
						line_total_cents,
						batch_code,
						expiry_date
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					poItemId,
					purchaseOrderId,
					item.productId,
					product.name,
					item.quantity,
					item.unitCostCents,
					lineTotalCents,
					item.batchCode,
					item.expiryDate
				)
		);

		if (!receivedAt) {
			continue;
		}

		const nextStock = (virtualStock.get(item.productId) ?? product.stockQuantity) + item.quantity;
		const batchId = crypto.randomUUID();
		virtualStock.set(item.productId, nextStock);
		updatedProducts.set(item.productId, nextStock);
		batchSummaries.push({
			id: batchId,
			productId: item.productId,
			productName: product.name,
			batchCode: item.batchCode,
			expiryDate: item.expiryDate,
			receivedQuantity: item.quantity,
			remainingQuantity: item.quantity,
			unitCostCents: item.unitCostCents
		});
		statements.push(
			session
				.prepare(
					`UPDATE store_stock
					SET stock_quantity = stock_quantity + ?, updated_at = ?
					WHERE store_id = ? AND product_id = ?`
				)
				.bind(item.quantity, receivedAt, storeId, item.productId)
		);
		statements.push(
			session
				.prepare(
					`INSERT INTO batches (
						id,
						store_id,
						product_id,
						supplier_id,
						purchase_order_id,
						batch_code,
						expiry_date,
						received_quantity,
						remaining_quantity,
						unit_cost_cents,
						created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					batchId,
					storeId,
					item.productId,
					supplier.id,
					purchaseOrderId,
					item.batchCode,
					item.expiryDate,
					item.quantity,
					item.quantity,
					item.unitCostCents,
					receivedAt
				)
		);
		statements.push(
			session
				.prepare(
					`INSERT INTO stock_movements (
						id,
						store_id,
						product_id,
						batch_id,
						source_type,
						source_id,
						movement_type,
						quantity_delta,
						reason,
						resulting_stock_quantity,
						created_at
					) VALUES (?, ?, ?, ?, 'purchase_order', ?, 'in', ?, ?, ?, ?)`
				)
				.bind(
					crypto.randomUUID(),
					storeId,
					item.productId,
					batchId,
					purchaseOrderId,
					item.quantity,
					`Received against ${poNumber}`,
					nextStock,
					receivedAt
				)
		);
	}

	await session.batch(statements);

	return {
		purchaseOrder: {
			id: purchaseOrderId,
			storeId,
			supplierId: supplier.id,
			supplierName: supplier.name,
			poNumber,
			status,
			notes,
			totalCostCents,
			receivedAt,
			createdAt,
			items: itemSummaries,
			batches: batchSummaries
		},
		updatedProducts: Array.from(updatedProducts.entries()).map(([id, stockQuantity]) => ({
			id,
			stockQuantity
		}))
	};
}

export async function createStockAdjustment(
	env: PosBindings,
	payload: StockAdjustmentRequest
): Promise<StockAdjustmentResponse> {
	const storeId = payload.storeId ?? DEFAULT_STORE_ID;
	const reason = payload.reason.trim();

	if (!reason) {
		throw new PosHttpError(400, 'A stock adjustment reason is required.');
	}

	if (!Number.isInteger(payload.quantityDelta) || payload.quantityDelta === 0) {
		throw new PosHttpError(400, 'Stock adjustments need a non-zero quantity delta.');
	}

	const existingProduct = await env.DB.prepare(
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
		WHERE p.id = ? AND ss.store_id = ?`
	)
		.bind(payload.productId, storeId)
		.first<InventoryProductRow>();

	if (!existingProduct) {
		throw new PosHttpError(404, 'Product not found for stock adjustment.');
	}

	const adjustedAt = new Date().toISOString();
	const updatedStock = await env.DB.prepare(
		`UPDATE store_stock
		SET stock_quantity = stock_quantity + ?, updated_at = ?
		WHERE product_id = ? AND store_id = ? AND stock_quantity + ? >= 0
		RETURNING stock_quantity, reorder_point`
	)
		.bind(payload.quantityDelta, adjustedAt, payload.productId, storeId, payload.quantityDelta)
		.first<{ stock_quantity: number; reorder_point: number }>();

	if (!updatedStock) {
		throw new PosHttpError(
			409,
			`${existingProduct.name} cannot be reduced below zero stock. Refresh and try again.`
		);
	}

	if (storeId === DEFAULT_STORE_ID) {
		// products table update removed (legacy)
	}

	const updatedProduct: InventoryProductRow = {
		...existingProduct,
		stock_quantity: updatedStock.stock_quantity,
		reorder_point: updatedStock.reorder_point
	};

	const movementId = crypto.randomUUID();
	let batch: BatchSummary | null = null;

	if (payload.quantityDelta > 0) {
		const batchId = crypto.randomUUID();
		const batchCode = normalizeBatchCode(payload.batchCode) || createAdjustmentBatchCode(adjustedAt);
		const expiryDate = normalizeExpiryDate(payload.expiryDate);

		await env.DB
			.prepare(
				`INSERT INTO batches (
					id,
					store_id,
					product_id,
					supplier_id,
					purchase_order_id,
					batch_code,
					expiry_date,
					received_quantity,
					remaining_quantity,
					unit_cost_cents,
					created_at
				) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, 0, ?)`
			)
			.bind(
				batchId,
				storeId,
				payload.productId,
				batchCode,
				expiryDate,
				payload.quantityDelta,
				payload.quantityDelta,
				adjustedAt
			)
			.run();
		await env.DB
			.prepare(
				`INSERT INTO stock_movements (
					id,
					store_id,
					product_id,
					batch_id,
					source_type,
					source_id,
					movement_type,
					quantity_delta,
					reason,
					resulting_stock_quantity,
					created_at
				) VALUES (?, ?, ?, ?, 'stock_adjustment', ?, 'adjust', ?, ?, ?, ?)`
			)
			.bind(
				movementId,
				storeId,
				payload.productId,
				batchId,
				movementId,
				payload.quantityDelta,
				reason,
				updatedProduct.stock_quantity,
				adjustedAt
			)
			.run();

		batch = {
			id: batchId,
			productId: payload.productId,
			productName: updatedProduct.name,
			batchCode,
			expiryDate,
			receivedQuantity: payload.quantityDelta,
			remainingQuantity: payload.quantityDelta,
			unitCostCents: 0
		};
	} else {
		await env.DB.prepare(
			`INSERT INTO stock_movements (
				id,
				store_id,
				product_id,
				batch_id,
				source_type,
				source_id,
				movement_type,
				quantity_delta,
				reason,
				resulting_stock_quantity,
				created_at
			) VALUES (?, ?, ?, NULL, 'stock_adjustment', ?, 'adjust', ?, ?, ?, ?)`
		)
			.bind(
				movementId,
				storeId,
				payload.productId,
				movementId,
				payload.quantityDelta,
				reason,
				updatedProduct.stock_quantity,
				adjustedAt
			)
			.run();

		if (payload.batchCode) {
			const trackedBatch = await env.DB.prepare(
				`SELECT
					b.id,
					b.product_id,
					p.name AS product_name,
					b.batch_code,
					b.expiry_date,
					b.received_quantity,
					b.remaining_quantity,
					b.unit_cost_cents
				FROM batches b
				INNER JOIN products p ON p.id = b.product_id
				WHERE b.product_id = ? AND b.batch_code = ?
				ORDER BY b.created_at DESC
				LIMIT 1`
			)
				.bind(payload.productId, payload.batchCode.trim())
				.first<BatchRow>();

			if (trackedBatch && trackedBatch.remaining_quantity + payload.quantityDelta >= 0) {
				await env.DB.prepare(
					`UPDATE batches
					SET remaining_quantity = remaining_quantity + ?
					WHERE id = ?`
				)
					.bind(payload.quantityDelta, trackedBatch.id)
					.run();

				batch = {
					...mapBatchRow(trackedBatch),
					remainingQuantity: trackedBatch.remaining_quantity + payload.quantityDelta
				};
			}
		}
	}

	return {
		movement: {
			id: movementId,
			storeId,
			productId: payload.productId,
			productName: updatedProduct.name,
			batchId: batch?.id ?? null,
			sourceType: 'stock_adjustment',
			sourceId: movementId,
			movementType: 'adjust',
			quantityDelta: payload.quantityDelta,
			reason,
			resultingStockQuantity: updatedProduct.stock_quantity,
			createdAt: adjustedAt
		},
		updatedProduct: {
			id: payload.productId,
			stockQuantity: updatedProduct.stock_quantity
		},
		batch
	};
}

export async function syncInventoryActions(
	env: PosBindings,
	payload: InventorySyncRequest
): Promise<InventorySyncResponse> {
	const accepted: InventorySyncResponse['accepted'] = [];
	const rejected: InventorySyncResponse['rejected'] = [];
	const updatedProducts = new Map<string, number>();

	for (const action of payload.actions ?? []) {
		try {
			if (action.actionType === 'purchase_order') {
				const response = await createPurchaseOrder(env, action);

				accepted.push({
					localId: action.localId,
					actionType: 'purchase_order',
					entityId: response.purchaseOrder.id,
					referenceNumber: response.purchaseOrder.poNumber,
					syncedAt: new Date().toISOString()
				});

				for (const update of response.updatedProducts) {
					updatedProducts.set(update.id, update.stockQuantity);
				}

				continue;
			}

			const response = await createStockAdjustment(env, action);
			accepted.push({
				localId: action.localId,
				actionType: 'stock_adjustment',
				entityId: response.movement.id,
				referenceNumber: response.movement.id,
				syncedAt: new Date().toISOString()
			});
			updatedProducts.set(response.updatedProduct.id, response.updatedProduct.stockQuantity);
		} catch (error) {
			const isPosError = error instanceof PosHttpError;
			const reason =
				isPosError && error.status === 409 ? 'stock_conflict' : 'invalid_action';
			rejected.push({
				localId: action.localId,
				actionType: action.actionType,
				reason,
				message: error instanceof Error ? error.message : 'Offline inventory sync failed.'
			});
		}
	}

	return {
		accepted,
		rejected,
		updatedProducts: Array.from(updatedProducts.entries()).map(([id, stockQuantity]) => ({
			id,
			stockQuantity
		}))
	};
}

export async function runScheduledLowStockAlert(env: PosBindings) {
	return dispatchLowStockAlert(env, DEFAULT_STORE_ID);
}

function normalizePurchaseOrderItems(items: PurchaseOrderRequestItem[]) {
	if (items.length === 0) {
		throw new PosHttpError(400, 'At least one purchase order item is required.');
	}

	return items.map((item) => {
		const batchCode = normalizeBatchCode(item.batchCode);

		if (!item.productId || !Number.isInteger(item.quantity) || item.quantity <= 0) {
			throw new PosHttpError(400, 'Each purchase order item needs a product ID and a positive quantity.');
		}

		if (!Number.isInteger(item.unitCostCents) || item.unitCostCents < 0) {
			throw new PosHttpError(400, 'Unit cost must be a non-negative cent value.');
		}

		if (!batchCode) {
			throw new PosHttpError(400, 'Each purchase order item needs a batch code.');
		}

		return {
			productId: item.productId,
			quantity: item.quantity,
			unitCostCents: item.unitCostCents,
			batchCode,
			expiryDate: normalizeExpiryDate(item.expiryDate)
		};
	});
}

function normalizeBatchCode(batchCode: string | null | undefined) {
	const value = batchCode?.trim().toUpperCase() ?? '';
	return value || null;
}

function normalizeExpiryDate(value: string | null | undefined) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function createAdjustmentBatchCode(timestamp: string) {
	return `ADJ-${timestamp.slice(0, 10).replaceAll('-', '')}-${timestamp.slice(11, 19).replaceAll(':', '')}`;
}

function calculateDaysUntil(date: string | null, reference: string) {
	if (!date) {
		return null;
	}

	const referenceDate = new Date(reference);
	const targetDate = new Date(`${date}T00:00:00.000Z`);

	if (Number.isNaN(referenceDate.getTime()) || Number.isNaN(targetDate.getTime())) {
		return null;
	}

	return Math.ceil((targetDate.getTime() - referenceDate.getTime()) / (1000 * 60 * 60 * 24));
}

function renderLowStockText(report: LowStockReportResponse) {
	if (report.items.length === 0) {
		return `${report.store.name}: no low stock products were detected in the latest scan.`;
	}

	return [
		`${report.store.name} low stock report`,
		`Generated: ${report.generatedAt}`,
		'',
		...report.items.map(
			(item) =>
				`${item.productName}: ${item.stockQuantity} on hand, reorder at ${item.reorderPoint}, shortage ${item.shortageQuantity}${
					item.nextExpiryDate ? `, next expiry ${item.nextExpiryDate}` : ''
				}`
		)
	].join('\n');
}

function renderLowStockHtml(report: LowStockReportResponse) {
	const rows =
		report.items.length === 0
			? '<tr><td colspan="5">No low stock products detected.</td></tr>'
			: report.items
					.map(
						(item) => `<tr>
	<td>${escapeHtml(item.productName)}</td>
	<td>${item.stockQuantity}</td>
	<td>${item.reorderPoint}</td>
	<td>${item.shortageQuantity}</td>
	<td>${item.nextExpiryDate ? escapeHtml(item.nextExpiryDate) : 'n/a'}</td>
</tr>`
					)
					.join('');

	return `<!doctype html>
<html lang="en">
	<body style="font-family: Arial, sans-serif; color: #1f2933;">
		<h1>${escapeHtml(report.store.name)} low stock report</h1>
		<p>Generated at ${escapeHtml(report.generatedAt)}</p>
		<table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
			<thead>
				<tr>
					<th align="left">Product</th>
					<th align="left">On hand</th>
					<th align="left">Reorder point</th>
					<th align="left">Shortage</th>
					<th align="left">Next expiry</th>
				</tr>
			</thead>
			<tbody>${rows}</tbody>
		</table>
	</body>
</html>`;
}

function escapeHtml(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function mapBatchRow(row: BatchRow): BatchSummary {
	return {
		id: row.id,
		productId: row.product_id,
		productName: row.product_name,
		batchCode: row.batch_code,
		expiryDate: row.expiry_date,
		receivedQuantity: row.received_quantity,
		remainingQuantity: row.remaining_quantity,
		unitCostCents: row.unit_cost_cents
	};
}

function mapMovementRow(row: StockMovementRow): StockMovementSummary {
	return {
		id: row.id,
		storeId: row.store_id,
		productId: row.product_id,
		productName: row.product_name,
		batchId: row.batch_id,
		sourceType: row.source_type,
		sourceId: row.source_id,
		movementType: row.movement_type,
		quantityDelta: row.quantity_delta,
		reason: row.reason,
		resultingStockQuantity: row.resulting_stock_quantity,
		createdAt: row.created_at
	};
}

function mapEmailDeliveryRow(row: EmailDeliveryRow): EmailDeliverySummary {
	return {
		id: row.id,
		provider: row.provider,
		transport: row.transport,
		recipient: row.recipient,
		subject: row.subject,
		status: row.status,
		providerMessageId: row.provider_message_id,
		createdAt: row.created_at
	};
}
