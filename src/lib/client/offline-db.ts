import Dexie, { type Table } from 'dexie';
import type {
	OfflineActionStatus,
	OfflineInventoryActionSubmission,
	OfflineSaleSubmission,
	OfflineStockAdjustmentSubmission,
	OfflineTransactionStatus,
	OfflinePurchaseOrderSubmission,
	PendingInventoryActionRecord,
	PendingTransactionRecord,
	ProductSummary,
	PurchaseOrderRequestItem,
	Receipt,
	StoreSummary,
	SupplierSummary
} from '$lib/types';

export const OFFLINE_DB_NAME = 'retail-pos-offline';
export const PENDING_TRANSACTIONS_TABLE = 'pending_transactions';
export const PENDING_INVENTORY_ACTIONS_TABLE = 'pending_inventory_actions';
export const OFFLINE_SYNC_TAG = 'offline-sales-sync';

class RetailPosOfflineDatabase extends Dexie {
	pending_transactions!: Table<PendingTransactionRecord, string>;
	pending_inventory_actions!: Table<PendingInventoryActionRecord, string>;

	constructor() {
		super(OFFLINE_DB_NAME);

		this.version(1).stores({
			pending_transactions: '&localId,status,createdAt,syncedAt,conflictAt'
		});

		this.version(2).stores({
			pending_transactions: '&localId,status,createdAt,syncedAt,conflictAt',
			pending_inventory_actions: '&localId,actionType,status,createdAt,syncedAt,conflictAt'
		});
	}
}

let database: RetailPosOfflineDatabase | undefined;

export function getOfflineDatabase() {
	database ??= new RetailPosOfflineDatabase();
	return database;
}

export async function listQueuedTransactions() {
	return getOfflineDatabase().pending_transactions.orderBy('createdAt').reverse().toArray();
}

export async function savePendingTransaction(record: PendingTransactionRecord) {
	await getOfflineDatabase().pending_transactions.put(record);
}

export async function updateQueuedTransaction(
	localId: string,
	changes: Partial<PendingTransactionRecord>
) {
	await getOfflineDatabase().pending_transactions.update(localId, changes);
}

export async function listQueuedInventoryActions() {
	return getOfflineDatabase().pending_inventory_actions.orderBy('createdAt').reverse().toArray();
}

export async function savePendingInventoryAction(record: PendingInventoryActionRecord) {
	await getOfflineDatabase().pending_inventory_actions.put(record);
}

export async function updateQueuedInventoryAction(
	localId: string,
	changes: Partial<PendingInventoryActionRecord>
) {
	await getOfflineDatabase().pending_inventory_actions.update(localId, changes);
}

export function buildOfflineSaleSubmission(input: {
	store: StoreSummary;
	userId: string;
	cashReceivedCents: number;
	items: Array<{
		product: ProductSummary;
		quantity: number;
	}>;
}): OfflineSaleSubmission {
	const createdAt = new Date().toISOString();
	const localId = crypto.randomUUID();
	const subtotalCents = input.items.reduce(
		(total, entry) => total + entry.product.priceCents * entry.quantity,
		0
	);
	const itemCount = input.items.reduce((count, entry) => count + entry.quantity, 0);

	return {
		localId,
		storeId: input.store.id,
		userId: input.userId,
		cashReceivedCents: input.cashReceivedCents,
		items: input.items.map((entry) => ({
			productId: entry.product.id,
			quantity: entry.quantity
		})),
		createdAt,
		receiptNumber: `OFF-${createdAt.slice(0, 10).replaceAll('-', '')}-${localId
			.slice(0, 6)
			.toUpperCase()}`,
		subtotalCents,
		totalAmountCents: subtotalCents,
		changeDueCents: input.cashReceivedCents - subtotalCents,
		itemCount
	};
}

export function buildPendingTransactionRecord(sale: OfflineSaleSubmission): PendingTransactionRecord {
	return {
		...sale,
		status: 'pending',
		lastError: null,
		syncedAt: null,
		conflictAt: null,
		serverTransactionId: null,
		serverReceiptNumber: null
	};
}

export function buildOfflinePurchaseOrderSubmission(input: {
	store: StoreSummary;
	supplier: SupplierSummary;
	items: Array<{
		product: ProductSummary;
		quantity: number;
		unitCostCents: number;
		batchCode: string;
		expiryDate: string | null;
	}>;
	notes?: string;
	receiveNow?: boolean;
}): OfflinePurchaseOrderSubmission {
	const createdAt = new Date().toISOString();
	const localId = crypto.randomUUID();
	const normalizedItems: PurchaseOrderRequestItem[] = input.items.map((item) => ({
		productId: item.product.id,
		quantity: item.quantity,
		unitCostCents: item.unitCostCents,
		batchCode: item.batchCode.trim().toUpperCase(),
		expiryDate: item.expiryDate ?? null
	}));

	return {
		localId,
		actionType: 'purchase_order',
		storeId: input.store.id,
		supplierId: input.supplier.id,
		notes: input.notes?.trim() || '',
		receiveNow: input.receiveNow ?? true,
		items: normalizedItems,
		createdAt,
		summary: `${input.supplier.name} PO with ${normalizedItems.length} line(s)`
	};
}

export function buildOfflineStockAdjustmentSubmission(input: {
	store: StoreSummary;
	product: ProductSummary;
	quantityDelta: number;
	reason: string;
	batchCode?: string | null;
	expiryDate?: string | null;
}): OfflineStockAdjustmentSubmission {
	const createdAt = new Date().toISOString();

	return {
		localId: crypto.randomUUID(),
		actionType: 'stock_adjustment',
		storeId: input.store.id,
		productId: input.product.id,
		quantityDelta: input.quantityDelta,
		reason: input.reason.trim(),
		batchCode: input.batchCode?.trim().toUpperCase() ?? null,
		expiryDate: input.expiryDate ?? null,
		createdAt,
		summary: `${input.product.name}: ${input.quantityDelta > 0 ? '+' : ''}${input.quantityDelta}`
	};
}

export function buildPendingInventoryActionRecord(
	action: OfflineInventoryActionSubmission
): PendingInventoryActionRecord {
	return {
		...action,
		status: 'pending',
		lastError: null,
		syncedAt: null,
		conflictAt: null,
		serverEntityId: null,
		serverReference: null
	};
}

export function buildReceiptFromOfflineSale(
	sale: OfflineSaleSubmission,
	store: StoreSummary,
	productsById: Map<string, ProductSummary>
): Receipt {
	return {
		transactionId: sale.localId,
		receiptNumber: sale.receiptNumber,
		storeName: store.name,
		storeAddress: store.address,
		createdAt: sale.createdAt,
		itemCount: sale.itemCount,
		subtotalCents: sale.subtotalCents,
		totalAmountCents: sale.totalAmountCents,
		cashReceivedCents: sale.cashReceivedCents,
		changeDueCents: sale.changeDueCents,
		items: sale.items.map((item) => {
			const product = productsById.get(item.productId);

			return {
				productId: item.productId,
				productName: product?.name ?? item.productId,
				barcode: product?.barcode ?? 'offline-item',
				quantity: item.quantity,
				unitPriceCents: product?.priceCents ?? 0,
				lineTotalCents: (product?.priceCents ?? 0) * item.quantity
			};
		})
	};
}

export function createQueuedStockMap(records: PendingTransactionRecord[]) {
	const reserved = new Map<string, number>();

	for (const record of records) {
		if (!canAutoSync(record.status)) {
			continue;
		}

		for (const item of record.items) {
			reserved.set(item.productId, (reserved.get(item.productId) ?? 0) + item.quantity);
		}
	}

	return reserved;
}

export function createQueuedInventoryDeltaMap(records: PendingInventoryActionRecord[]) {
	const delta = new Map<string, number>();

	for (const record of records) {
		if (!canAutoSync(record.status)) {
			continue;
		}

		if (record.actionType === 'purchase_order') {
			for (const item of record.items) {
				delta.set(item.productId, (delta.get(item.productId) ?? 0) + item.quantity);
			}
			continue;
		}

		delta.set(
			record.productId,
			(delta.get(record.productId) ?? 0) + record.quantityDelta
		);
	}

	return delta;
}

export function summarizeQueue<T extends { status: OfflineActionStatus }>(records: T[]) {
	return records.reduce(
		(summary, record) => {
			if (record.status === 'pending') summary.pending += 1;
			if (record.status === 'syncing') summary.syncing += 1;
			if (record.status === 'synced') summary.synced += 1;
			if (record.status === 'conflict') summary.conflicts += 1;
			return summary;
		},
		{
			pending: 0,
			syncing: 0,
			synced: 0,
			conflicts: 0
		}
	);
}

export function canAutoSync(status: OfflineTransactionStatus) {
	return status === 'pending' || status === 'syncing';
}
