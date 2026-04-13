export interface StoreSummary {
	id: string;
	name: string;
	address: string | null;
	currencyCode: string;
}

export type UserRole = 'admin' | 'store_manager' | 'cashier';

export interface CurrentUser {
	id: string;
	email: string;
	name: string;
	role: UserRole;
	storeId: string | null;
}

export interface ProductSummary {
	id: string;
	storeId: string;
	name: string;
	barcode: string;
	description: string | null;
	priceCents: number;
	stockQuantity: number;
	reorderPoint: number;
	lowStock: boolean;
	imageKey: string | null;
	imageUrl: string | null;
}

export interface PaginationMeta {
	page: number;
	pageSize: number;
	totalItems: number;
	totalPages: number;
	hasNextPage: boolean;
	hasPreviousPage: boolean;
}

export interface ProductsResponse {
	items: ProductSummary[];
	pagination: PaginationMeta;
	search: string;
}

export interface SupplierSummary {
	id: string;
	name: string;
	contactName: string | null;
	email: string | null;
	phone: string | null;
	leadTimeDays: number;
}

export interface SaleRequestItem {
	productId: string;
	quantity: number;
}

export interface SaleRequest {
	storeId?: string;
	userId?: string;
	cashReceivedCents: number;
	items: SaleRequestItem[];
}

export interface ReceiptItem {
	productId: string;
	productName: string;
	barcode: string;
	quantity: number;
	unitPriceCents: number;
	lineTotalCents: number;
}

export interface Receipt {
	transactionId: string;
	receiptNumber: string;
	storeName: string;
	storeAddress: string | null;
	createdAt: string;
	itemCount: number;
	subtotalCents: number;
	totalAmountCents: number;
	cashReceivedCents: number;
	changeDueCents: number;
	items: ReceiptItem[];
}

export interface SaleResponse {
	receipt: Receipt;
	updatedProducts: Array<{
		id: string;
		stockQuantity: number;
	}>;
}

export type OfflineActionStatus = 'pending' | 'syncing' | 'synced' | 'conflict';
export type OfflineTransactionStatus = OfflineActionStatus;

export interface OfflineSaleSubmission extends SaleRequest {
	localId: string;
	storeId: string;
	userId: string;
	createdAt: string;
	receiptNumber: string;
	subtotalCents: number;
	totalAmountCents: number;
	changeDueCents: number;
	itemCount: number;
}

export interface PendingTransactionRecord extends OfflineSaleSubmission {
	status: OfflineTransactionStatus;
	lastError: string | null;
	syncedAt: string | null;
	conflictAt: string | null;
	serverTransactionId: string | null;
	serverReceiptNumber: string | null;
}

export interface OfflineSyncRequest {
	sales: OfflineSaleSubmission[];
}

export interface OfflineSyncAccepted {
	localId: string;
	transactionId: string;
	receiptNumber: string;
	syncedAt: string;
}

export interface OfflineSyncRejected {
	localId: string;
	reason: 'stock_conflict' | 'invalid_sale';
	message: string;
}

export interface OfflineSyncResponse {
	accepted: OfflineSyncAccepted[];
	rejected: OfflineSyncRejected[];
	updatedProducts: Array<{
		id: string;
		stockQuantity: number;
	}>;
}

export interface PurchaseOrderRequestItem {
	productId: string;
	quantity: number;
	unitCostCents: number;
	batchCode: string;
	expiryDate: string | null;
}

export interface PurchaseOrderRequest {
	storeId?: string;
	supplierId: string;
	notes?: string;
	receiveNow?: boolean;
	items: PurchaseOrderRequestItem[];
}

export interface PurchaseOrderItemSummary extends PurchaseOrderRequestItem {
	id: string;
	productName: string;
	lineTotalCents: number;
}

export interface BatchSummary {
	id: string;
	productId: string;
	productName: string;
	batchCode: string;
	expiryDate: string | null;
	receivedQuantity: number;
	remainingQuantity: number;
	unitCostCents: number;
}

export interface PurchaseOrderSummary {
	id: string;
	storeId: string;
	supplierId: string;
	supplierName: string;
	poNumber: string;
	status: 'draft' | 'received';
	notes: string | null;
	totalCostCents: number;
	receivedAt: string | null;
	createdAt: string;
	items: PurchaseOrderItemSummary[];
	batches: BatchSummary[];
}

export interface PurchaseOrderResponse {
	purchaseOrder: PurchaseOrderSummary;
	updatedProducts: Array<{
		id: string;
		stockQuantity: number;
	}>;
}

export interface StockAdjustmentRequest {
	storeId?: string;
	productId: string;
	quantityDelta: number;
	reason: string;
	batchCode?: string | null;
	expiryDate?: string | null;
}

export interface StockMovementSummary {
	id: string;
	storeId: string;
	productId: string;
	productName: string;
	batchId: string | null;
	sourceType: 'purchase_order' | 'stock_adjustment' | 'sale' | 'offline_sync';
	sourceId: string;
	movementType: 'in' | 'out' | 'adjust';
	quantityDelta: number;
	reason: string | null;
	resultingStockQuantity: number;
	createdAt: string;
}

export interface StockAdjustmentResponse {
	movement: StockMovementSummary;
	updatedProduct: {
		id: string;
		stockQuantity: number;
	};
	batch: BatchSummary | null;
}

export interface LowStockReportItem {
	productId: string;
	productName: string;
	barcode: string;
	stockQuantity: number;
	reorderPoint: number;
	shortageQuantity: number;
	nextBatchCode: string | null;
	nextExpiryDate: string | null;
	daysUntilExpiry: number | null;
}

export interface EmailDeliverySummary {
	id: string;
	provider: string;
	transport: 'mock' | 'resend';
	recipient: string;
	subject: string;
	status: string;
	providerMessageId: string | null;
	createdAt: string;
}

export interface LowStockReportResponse {
	generatedAt: string;
	store: StoreSummary;
	items: LowStockReportItem[];
	lastDelivery: EmailDeliverySummary | null;
}

export interface LowStockDispatchResponse {
	report: LowStockReportResponse;
	delivery: EmailDeliverySummary;
}

export interface AuthLoginRequest {
	email: string;
	password: string;
}

export interface AuthLoginResponse {
	token: string;
	user: CurrentUser;
	stores: StoreSummary[];
}

export interface MeResponse {
	user: CurrentUser;
	stores: StoreSummary[];
}

export type InventoryActionType = 'purchase_order' | 'stock_adjustment';
export type OfflineInventoryActionStatus = OfflineActionStatus;

interface OfflineInventoryActionBase {
	localId: string;
	storeId: string;
	actionType: InventoryActionType;
	createdAt: string;
	summary: string;
}

export interface OfflinePurchaseOrderSubmission
	extends OfflineInventoryActionBase,
		PurchaseOrderRequest {
	actionType: 'purchase_order';
	storeId: string;
}

export interface OfflineStockAdjustmentSubmission
	extends OfflineInventoryActionBase,
		StockAdjustmentRequest {
	actionType: 'stock_adjustment';
	storeId: string;
}

export type OfflineInventoryActionSubmission =
	| OfflinePurchaseOrderSubmission
	| OfflineStockAdjustmentSubmission;

export type PendingInventoryActionRecord = OfflineInventoryActionSubmission & {
	status: OfflineInventoryActionStatus;
	lastError: string | null;
	syncedAt: string | null;
	conflictAt: string | null;
	serverEntityId: string | null;
	serverReference: string | null;
};

export interface InventorySyncRequest {
	actions: OfflineInventoryActionSubmission[];
}

export interface InventorySyncAccepted {
	localId: string;
	actionType: InventoryActionType;
	entityId: string;
	referenceNumber: string | null;
	syncedAt: string;
}

export interface InventorySyncRejected {
	localId: string;
	actionType: InventoryActionType;
	reason: 'stock_conflict' | 'invalid_action';
	message: string;
}

export interface InventorySyncResponse {
	accepted: InventorySyncAccepted[];
	rejected: InventorySyncRejected[];
	updatedProducts: Array<{
		id: string;
		stockQuantity: number;
	}>;
}

export interface TransferRequestItem {
	productId: string;
	quantity: number;
}

export interface TransferRequest {
	fromStoreId?: string;
	toStoreId: string;
	note?: string;
	items: TransferRequestItem[];
}

export interface TransferItemSummary extends TransferRequestItem {
	id: string;
	productName: string;
}

export interface TransferSummary {
	id: string;
	transferNumber: string;
	fromStoreId: string;
	fromStoreName: string;
	toStoreId: string;
	toStoreName: string;
	status: 'requested' | 'approved';
	note: string | null;
	requestedByUserId: string;
	requestedByName: string;
	approvedByUserId: string | null;
	approvedByName: string | null;
	createdAt: string;
	approvedAt: string | null;
	items: TransferItemSummary[];
}

export interface TransferResponse {
	transfer: TransferSummary;
	updatedProducts: Array<{
		id: string;
		storeId: string;
		stockQuantity: number;
	}>;
}
