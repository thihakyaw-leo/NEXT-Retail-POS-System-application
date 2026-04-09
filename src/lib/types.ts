export interface StoreSummary {
	id: string;
	name: string;
	address: string | null;
	currencyCode: string;
}

export interface ProductSummary {
	id: string;
	storeId: string;
	name: string;
	barcode: string;
	description: string | null;
	priceCents: number;
	stockQuantity: number;
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

export interface SaleRequestItem {
	productId: string;
	quantity: number;
}

export interface SaleRequest {
	storeId?: string;
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
