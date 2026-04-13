<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import { formatCents } from '$lib/currency';
	import type {
		CurrentUser,
		OfflineSaleSubmission,
		OfflineSyncResponse,
		PendingTransactionRecord,
		ProductSummary,
		ProductsResponse,
		Receipt,
		SaleResponse,
		StoreSummary
	} from '$lib/types';
	import type { PageData } from './$types';

	export let data: PageData;

	type CartEntry = {
		product: ProductSummary;
		quantity: number;
	};

	type UploadState = {
		busy?: boolean;
		message?: string;
		error?: boolean;
	};

	type QueueSummary = {
		pending: number;
		syncing: number;
		synced: number;
		conflicts: number;
	};

	type OfflineDbModule = typeof import('$lib/client/offline-db');
	type SyncCapableRegistration = ServiceWorkerRegistration & {
		sync?: {
			register(tag: string): Promise<void>;
		};
	};

	let store: StoreSummary = {
		id: '',
		name: '',
		address: null,
		currencyCode: 'USD'
	};
	let products: ProductSummary[] = [];
	let currentUser: CurrentUser | null = null;
	let accessibleStores: StoreSummary[] = [];
	let pagination = {
		page: 1,
		pageSize: 12,
		totalItems: 0,
		totalPages: 1,
		hasNextPage: false,
		hasPreviousPage: false
	};
	let searchTerm = '';
	let knownProducts = new Map<string, ProductSummary>();
	let seededFromData = false;
	let cart = new Map<string, number>();
	let loadingProducts = false;
	let catalogError = '';
	let saleError = '';
	let submittingSale = false;
	let syncingQueue = false;
	let cashInput = '';
	let receipt: Receipt | null = null;
	let uploadStates: Record<string, UploadState> = {};
	let hydrated = false;
	let isOnline = true;
	let queueRecords: PendingTransactionRecord[] = [];
	let queueSummary: QueueSummary = {
		pending: 0,
		syncing: 0,
		synced: 0,
		conflicts: 0
	};
	let queuedStock = new Map<string, number>();
	let syncMessage = 'Offline queue is empty.';
	let serviceWorkerRegistration: ServiceWorkerRegistration | null = null;
	let serviceWorkerRegistrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;
	let offlineModulePromise:
		| Promise<OfflineDbModule>
		| null = null;
	let offlineRuntimeReady = false;
	let receiptMode: 'draft' | 'online' | 'queued' = 'draft';
	let indexedDbSnapshot = '[]';
	let syncFallbackTimer: ReturnType<typeof setTimeout> | null = null;

	$: if (data && !seededFromData) {
		currentUser = data.user;
		accessibleStores = data.stores;
		store = data.store;
		products = data.initialProducts.items;
		pagination = data.initialProducts.pagination;
		searchTerm = data.initialProducts.search;
		knownProducts = new Map(data.initialProducts.items.map((product) => [product.id, product]));
		seededFromData = true;
	}

	onMount(() => {
		hydrated = true;

		if (!browser) {
			return;
		}

		isOnline = navigator.onLine;
		serviceWorkerRegistrationPromise = registerOfflineSyncWorker();
		void initializeOfflineRuntime();

		const handleOnline = () => {
			isOnline = true;
			syncMessage = queueSummary.pending
				? 'Connection restored. Syncing queued sales...'
				: 'Back online.';
			void triggerOfflineSync();
		};

		const handleOffline = () => {
			isOnline = false;
			syncMessage = 'Offline mode active. Sales will be queued locally.';
		};

		window.addEventListener('online', handleOnline);
		window.addEventListener('offline', handleOffline);
		navigator.serviceWorker?.addEventListener('message', handleServiceWorkerMessage);

		return () => {
			clearSyncFallbackTimer();
			window.removeEventListener('online', handleOnline);
			window.removeEventListener('offline', handleOffline);
			navigator.serviceWorker?.removeEventListener('message', handleServiceWorkerMessage);
		};
	});

	$: cartEntries = Array.from(cart.entries())
		.map(([productId, quantity]) => {
			const product = knownProducts.get(productId);
			return product ? { product, quantity } : null;
		})
		.filter(Boolean) as CartEntry[];
	$: itemCount = cartEntries.reduce((count, entry) => count + entry.quantity, 0);
	$: subtotalCents = cartEntries.reduce(
		(total, entry) => total + entry.product.priceCents * entry.quantity,
		0
	);
	$: cashReceivedCents = parseCashInput(cashInput);
	$: changeDueCents = Math.max(cashReceivedCents - subtotalCents, 0);
	$: canCheckout =
		cartEntries.length > 0 &&
		cashReceivedCents >= subtotalCents &&
		!submittingSale &&
		(isOnline || offlineRuntimeReady);
	$: receiptLines =
		receipt?.items ??
		cartEntries.map((entry) => ({
			productId: entry.product.id,
			productName: entry.product.name,
			barcode: entry.product.barcode,
			quantity: entry.quantity,
			unitPriceCents: entry.product.priceCents,
			lineTotalCents: entry.product.priceCents * entry.quantity
		}));
	$: queueSummary = summarizeQueueState(queueRecords);
	$: queuedStock = buildQueuedStockMap(queueRecords);
	$: indexedDbSnapshot = JSON.stringify(
		queueRecords.map((record) => ({
			localId: record.localId,
			receiptNumber: record.receiptNumber,
			status: record.status,
			itemCount: record.itemCount,
			totalAmountCents: record.totalAmountCents,
			lastError: record.lastError
		})),
		null,
		2
	);

	function getErrorMessage(payload: unknown, fallback: string) {
		if (typeof payload === 'object' && payload !== null && 'message' in payload) {
			const message = payload.message;
			return typeof message === 'string' ? message : fallback;
		}

		return fallback;
	}

	function isProductsResponse(payload: unknown): payload is ProductsResponse {
		return (
			typeof payload === 'object' &&
			payload !== null &&
			'items' in payload &&
			'pagination' in payload &&
			'search' in payload
		);
	}

	function isSaleResponse(payload: unknown): payload is SaleResponse {
		return typeof payload === 'object' && payload !== null && 'receipt' in payload && 'updatedProducts' in payload;
	}

	function mergeProducts(nextProducts: ProductSummary[]) {
		const merged = new Map(knownProducts);

		for (const product of nextProducts) {
			merged.set(product.id, product);
		}

		knownProducts = merged;
	}

	function buildQueuedStockMap(records: PendingTransactionRecord[]) {
		const reserved = new Map<string, number>();

		for (const record of records) {
			if (record.status !== 'pending' && record.status !== 'syncing') {
				continue;
			}

			for (const item of record.items) {
				reserved.set(item.productId, (reserved.get(item.productId) ?? 0) + item.quantity);
			}
		}

		return reserved;
	}

	function summarizeQueueState(records: PendingTransactionRecord[]): QueueSummary {
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

	function getOfflineModule() {
		offlineModulePromise ??= import('$lib/client/offline-db');
		return offlineModulePromise;
	}

	function switchStore(storeId: string) {
		if (!browser) {
			return;
		}

		window.location.assign(`/?storeId=${encodeURIComponent(storeId)}`);
	}

	async function initializeOfflineRuntime() {
		try {
			await getOfflineModule();
			offlineRuntimeReady = true;
			await refreshQueueState();
		} catch (error) {
			syncMessage =
				error instanceof Error
					? error.message
					: 'Offline storage failed to initialize. Refresh while online and try again.';
		}
	}

	function getAvailableStock(productId: string) {
		const product = knownProducts.get(productId);

		if (!product) {
			return 0;
		}

		return Math.max(product.stockQuantity - (queuedStock.get(productId) ?? 0), 0);
	}

	function addToCart(product: ProductSummary) {
		const currentQuantity = cart.get(product.id) ?? 0;
		const availableStock = getAvailableStock(product.id);

		if (currentQuantity >= availableStock) {
			saleError = `${product.name} has no additional stock available locally.`;
			return;
		}

		const nextCart = new Map(cart);
		nextCart.set(product.id, currentQuantity + 1);
		cart = nextCart;
		saleError = '';
	}

	function updateCartQuantity(productId: string, quantity: number) {
		const product = knownProducts.get(productId);

		if (!product) {
			return;
		}

		const boundedQuantity = Math.min(Math.max(quantity, 0), getAvailableStock(productId));
		const nextCart = new Map(cart);

		if (boundedQuantity === 0) {
			nextCart.delete(productId);
		} else {
			nextCart.set(productId, boundedQuantity);
		}

		cart = nextCart;
	}

	async function fetchProducts(page = 1) {
		loadingProducts = true;
		catalogError = '';

		try {
			const params = new URLSearchParams({
				page: String(page),
				pageSize: String(pagination.pageSize)
			});

			if (searchTerm.trim()) {
				params.set('search', searchTerm.trim());
			}

			const response = await fetch(`/api/products?${params}`);
			const payload = await response.json();

			if (!response.ok || !isProductsResponse(payload)) {
				throw new Error(getErrorMessage(payload, 'Unable to load products.'));
			}

			products = payload.items;
			pagination = payload.pagination;
			searchTerm = payload.search;
			mergeProducts(payload.items);
		} catch (error) {
			catalogError = error instanceof Error ? error.message : 'Unable to load products.';
		} finally {
			loadingProducts = false;
		}
	}

	function applyUpdatedStock(updatedProducts: SaleResponse['updatedProducts']) {
		const nextKnownProducts = new Map(knownProducts);

		for (const update of updatedProducts) {
			const product = nextKnownProducts.get(update.id);

			if (product) {
				nextKnownProducts.set(update.id, {
					...product,
					stockQuantity: update.stockQuantity
				});
			}
		}

		knownProducts = nextKnownProducts;
		products = products.map((product) => nextKnownProducts.get(product.id) ?? product);

		const nextCart = new Map(cart);

		for (const [productId, quantity] of nextCart.entries()) {
			const product = nextKnownProducts.get(productId);
			const availableStock = product ? Math.max(product.stockQuantity - (queuedStock.get(productId) ?? 0), 0) : 0;

			if (!product || availableStock <= 0) {
				nextCart.delete(productId);
				continue;
			}

			if (quantity > availableStock) {
				nextCart.set(productId, availableStock);
			}
		}

		cart = nextCart;
	}

	async function refreshQueueState() {
		if (!browser) {
			return;
		}

		const offline = await getOfflineModule();
		offlineRuntimeReady = true;
		const records = await offline.listQueuedTransactions();
		const summary = summarizeQueueState(records);
		queueRecords = records;

		if (summary.pending === 0 && summary.syncing === 0 && summary.conflicts === 0) {
			syncMessage = summary.synced
				? 'Offline sales are synced.'
				: isOnline
					? 'No queued offline sales.'
					: 'Offline mode active. Sales will be queued locally.';
		}
	}

	async function registerOfflineSyncWorker() {
		if (!browser || !('serviceWorker' in navigator)) {
			return null;
		}

		await navigator.serviceWorker.register('/offline-sync-sw.js');
		serviceWorkerRegistration = await navigator.serviceWorker.ready;

		if (navigator.onLine) {
			setTimeout(() => {
				void triggerOfflineSync();
			}, 200);
		}

		return serviceWorkerRegistration;
	}

	function handleServiceWorkerMessage(event: MessageEvent) {
		const payload = event.data;

		if (!payload || typeof payload !== 'object' || !('type' in payload)) {
			return;
		}

		if (payload.type === 'OFFLINE_SYNC_RESULT') {
			clearSyncFallbackTimer();
			syncingQueue = false;
			const result = payload as OfflineSyncResponse & { type: string };
			applySyncResponse(result);
			void refreshQueueState();
		}

		if (payload.type === 'OFFLINE_SYNC_ERROR') {
			clearSyncFallbackTimer();
			syncingQueue = false;
			syncMessage =
				typeof payload.message === 'string'
					? payload.message
					: 'Offline sync failed. Pending sales remain queued.';
			void refreshQueueState();
		}
	}

	async function triggerOfflineSync() {
		if (!browser || !navigator.onLine) {
			return;
		}

		const offline = await getOfflineModule();
		const queued = await offline.listQueuedTransactions();
		const pendingCount = queued.filter((record) => record.status === 'pending').length;

		if (pendingCount === 0) {
			syncingQueue = false;
			return;
		}

		syncingQueue = true;
		const registration = (serviceWorkerRegistration ??
			(serviceWorkerRegistrationPromise && (await serviceWorkerRegistrationPromise))) as
			| SyncCapableRegistration
			| null;

		if (registration?.sync?.register) {
			try {
				await registration.sync.register('offline-sales-sync');
			} catch {
				// Ignore unsupported or duplicate registrations and continue with a direct message.
			}
		}

		const activeWorker = registration?.active ?? navigator.serviceWorker.controller;

		if (!activeWorker) {
			await performDirectSync();
			return;
		}

		activeWorker.postMessage({
			type: 'SYNC_OFFLINE_SALES'
		});
		scheduleDirectSyncFallback();
	}

	async function completeSale() {
		submittingSale = true;
		saleError = '';

		try {
			const offline = await getOfflineModule();
			offlineRuntimeReady = true;
			const offlineSale = offline.buildOfflineSaleSubmission({
				store,
				userId: currentUser?.id ?? '',
				cashReceivedCents,
				items: cartEntries
			});

			if (!isOnline) {
				await queueSaleLocally(offline, offlineSale);
				return;
			}

			const response = await fetch('/api/sale', {
				method: 'POST',
				headers: {
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					storeId: store.id,
					userId: currentUser?.id ?? '',
					cashReceivedCents,
					items: cartEntries.map((entry) => ({
						productId: entry.product.id,
						quantity: entry.quantity
					}))
				})
			});
			const payload = await response.json();

			if (!response.ok || !isSaleResponse(payload)) {
				throw new Error(getErrorMessage(payload, 'Checkout failed.'));
			}

			receipt = payload.receipt;
			receiptMode = 'online';
			applyUpdatedStock(payload.updatedProducts);
			cart = new Map();
			cashInput = '';
			syncMessage = 'Sale completed online.';
		} catch (error) {
			if (!navigator.onLine || error instanceof TypeError) {
				isOnline = navigator.onLine;
				try {
					const offline = await getOfflineModule();
					offlineRuntimeReady = true;
					const offlineSale = offline.buildOfflineSaleSubmission({
						store,
						userId: currentUser?.id ?? '',
						cashReceivedCents,
						items: cartEntries
					});
					await queueSaleLocally(offline, offlineSale);
				} catch (offlineError) {
					saleError =
						offlineError instanceof Error
							? offlineError.message
							: 'Offline storage is unavailable in this session.';
				}
			} else {
				saleError = error instanceof Error ? error.message : 'Checkout failed.';
			}
		} finally {
			submittingSale = false;
		}
	}

	async function queueSaleLocally(offline: OfflineDbModule, offlineSale: OfflineSaleSubmission) {
		await offline.savePendingTransaction(offline.buildPendingTransactionRecord(offlineSale));
		receipt = offline.buildReceiptFromOfflineSale(offlineSale, store, knownProducts);
		receiptMode = 'queued';
		cart = new Map();
		cashInput = '';
		saleError = '';
		syncMessage = 'Sale saved offline and added to the sync queue.';
		await refreshQueueState();
	}

	function clearSyncFallbackTimer() {
		if (syncFallbackTimer) {
			clearTimeout(syncFallbackTimer);
			syncFallbackTimer = null;
		}
	}

	function scheduleDirectSyncFallback() {
		clearSyncFallbackTimer();
		syncFallbackTimer = setTimeout(() => {
			void performDirectSync();
		}, 1800);
	}

	function applySyncResponse(result: OfflineSyncResponse) {
		if (Array.isArray(result.updatedProducts) && result.updatedProducts.length > 0) {
			applyUpdatedStock(result.updatedProducts);
		}

		if ((result.accepted?.length ?? 0) > 0) {
			syncMessage = `${result.accepted.length} offline sale(s) synced.`;
		}

		if ((result.rejected?.length ?? 0) > 0) {
			syncMessage = `${result.rejected.length} offline sale(s) need review due to stock conflicts.`;
		}

		if ((result.accepted?.length ?? 0) === 0 && (result.rejected?.length ?? 0) === 0) {
			syncMessage = 'No queued offline sales.';
		}
	}

	async function performDirectSync() {
		if (!browser || !navigator.onLine) {
			return;
		}

		clearSyncFallbackTimer();
		const offline = await getOfflineModule();
		const queued = await offline.listQueuedTransactions();
		const pending = queued.filter(
			(record) => record.status === 'pending' || record.status === 'syncing'
		);

		if (pending.length === 0) {
			syncingQueue = false;
			return;
		}

		const now = new Date().toISOString();
		syncingQueue = true;

		for (const record of pending) {
			await offline.updateQueuedTransaction(record.localId, {
				status: 'syncing',
				lastError: null
			});
		}

		await refreshQueueState();

		try {
			const response = await fetch('/api/sync/offline-sales', {
				method: 'POST',
				headers: {
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					sales: pending.map((record) => ({
						localId: record.localId,
						storeId: record.storeId,
						cashReceivedCents: record.cashReceivedCents,
						items: record.items,
						createdAt: record.createdAt,
						receiptNumber: record.receiptNumber,
						subtotalCents: record.subtotalCents,
						totalAmountCents: record.totalAmountCents,
						changeDueCents: record.changeDueCents,
						itemCount: record.itemCount
					}))
				})
			});
			const payload = (await response.json()) as OfflineSyncResponse & {
				message?: string;
			};

			if (!response.ok) {
				throw new Error(getErrorMessage(payload, 'Offline sync failed.'));
			}

			for (const entry of payload.accepted ?? []) {
				await offline.updateQueuedTransaction(entry.localId, {
					status: 'synced',
					syncedAt: entry.syncedAt ?? now,
					conflictAt: null,
					serverTransactionId: entry.transactionId,
					serverReceiptNumber: entry.receiptNumber,
					lastError: null
				});
			}

			for (const entry of payload.rejected ?? []) {
				await offline.updateQueuedTransaction(entry.localId, {
					status: 'conflict',
					syncedAt: null,
					conflictAt: now,
					lastError: entry.message
				});
			}

			applySyncResponse(payload);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Offline sync failed.';

			for (const record of pending) {
				await offline.updateQueuedTransaction(record.localId, {
					status: 'pending',
					lastError: message
				});
			}

			syncMessage = message;
		} finally {
			syncingQueue = false;
			await refreshQueueState();
		}
	}

	async function handleImageUpload(productId: string, event: Event) {
		const target = event.currentTarget as HTMLInputElement | null;
		const file = target?.files?.[0];

		if (!file) {
			return;
		}

		uploadStates = {
			...uploadStates,
			[productId]: {
				busy: true,
				message: 'Uploading image...'
			}
		};

		try {
			const formData = new FormData();
			formData.set('image', file);

			const response = await fetch(`/api/products/${productId}/image`, {
				method: 'POST',
				body: formData
			});
			const payload = await response.json();

			if (
				!response.ok ||
				typeof payload !== 'object' ||
				payload === null ||
				!('product' in payload)
			) {
				throw new Error(getErrorMessage(payload, 'Image upload failed.'));
			}

			mergeProducts([payload.product]);
			products = products.map((product) =>
				product.id === payload.product.id ? payload.product : product
			);
			uploadStates = {
				...uploadStates,
				[productId]: {
					message: 'Image uploaded to R2.'
				}
			};
		} catch (error) {
			uploadStates = {
				...uploadStates,
				[productId]: {
					error: true,
					message: error instanceof Error ? error.message : 'Image upload failed.'
				}
			};
		} finally {
			if (target) {
				target.value = '';
			}
		}
	}

	function parseCashInput(value: string) {
		const normalized = value.replace(/[^0-9.]/g, '');
		const parsed = Number.parseFloat(normalized);

		if (!Number.isFinite(parsed) || parsed < 0) {
			return 0;
		}

		return Math.round(parsed * 100);
	}

	function stockLabel(stockQuantity: number) {
		if (stockQuantity <= 0) {
			return 'Out of stock';
		}

		if (stockQuantity < 5) {
			return `${stockQuantity} left`;
		}

		return `${stockQuantity} in stock`;
	}

	function initials(name: string) {
		return name
			.split(' ')
			.slice(0, 2)
			.map((part) => part[0])
			.join('')
			.toUpperCase();
	}

	function queueStatusLabel(status: PendingTransactionRecord['status']) {
		if (status === 'pending') return 'Pending sync';
		if (status === 'syncing') return 'Syncing';
		if (status === 'synced') return 'Synced';
		return 'Marked for review';
	}
</script>

<svelte:head>
	<title>Retail POS Enterprise</title>
	<meta
		name="description"
		content="Cloudflare-powered retail POS with offline sales queueing, background sync, and receipt preview."
	/>
</svelte:head>

<div class="shell" data-ready={hydrated ? 'true' : 'false'}>
	<header class="hero">
		<div>
			<p class="eyebrow">Offline Sync POS</p>
			<h1>Retail POS Enterprise</h1>
			<p class="lead">
				{store.name} runs on a Cloudflare Worker with D1-backed inventory, R2 product media, and a
				fast cashier surface designed for low-friction sales, even when the network drops.
			</p>
		</div>
		<div class="store-card">
			<span class="store-label">Active store</span>
			<strong>{store.name}</strong>
			<span>{store.address}</span>
			{#if currentUser}
				<span>Operator: {currentUser.name} ({currentUser.role})</span>
			{/if}
			<span>Currency: {store.currencyCode}</span>
			{#if accessibleStores.length > 1}
				<label class="store-switcher">
					<span>Store switcher</span>
					<select
						aria-label="Store switcher"
						value={store.id}
						on:change={(event) => {
							switchStore((event.currentTarget as HTMLSelectElement).value);
						}}
					>
						{#each accessibleStores as option}
							<option value={option.id}>{option.name}</option>
						{/each}
					</select>
				</label>
			{/if}
			<span class:is-offline={!isOnline} class="network-pill" data-testid="network-status">
				{isOnline ? 'Online' : 'Offline'}
			</span>
		</div>
	</header>

	<div class="workspace">
		<section class="catalog-panel">
			<div class="panel-header">
				<div>
					<p class="section-kicker">Catalog</p>
					<h2>Sellable inventory</h2>
				</div>
				<form
					class="search-bar"
					on:submit|preventDefault={() => {
						void fetchProducts(1);
					}}
				>
					<input
						placeholder="Search by barcode or product name"
						bind:value={searchTerm}
						aria-label="Search products"
					/>
					<button type="submit" disabled={loadingProducts}>
						{loadingProducts ? 'Searching...' : 'Search'}
					</button>
				</form>
			</div>

			{#if catalogError}
				<p class="inline-error">{catalogError}</p>
			{/if}

			<div class="catalog-meta">
				<span>{pagination.totalItems} products</span>
				<span>Page {pagination.page} of {pagination.totalPages}</span>
			</div>

			<div class="product-grid" data-testid="product-grid">
				{#each products as product}
					<article class="product-card">
						<div class="product-media">
							{#if product.imageUrl}
								<img src={product.imageUrl} alt={product.name} loading="lazy" />
							{:else}
								<div class="product-placeholder">{initials(product.name)}</div>
							{/if}
						</div>

						<div class="product-copy">
							<div class="product-topline">
								<div>
									<h3>{product.name}</h3>
									<p>{product.barcode}</p>
								</div>
								<span class:low-stock={getAvailableStock(product.id) < 5}>
									{stockLabel(getAvailableStock(product.id))}
								</span>
							</div>
							<p class="product-description">{product.description}</p>
							<div class="product-footer">
								<strong>{formatCents(product.priceCents, store.currencyCode)}</strong>
								<button
									type="button"
									class="primary"
									disabled={getAvailableStock(product.id) === 0}
									on:click={() => addToCart(product)}
									aria-label={`Add ${product.name}`}
								>
									Add to cart
								</button>
							</div>
							<label class="upload-field">
								<span>Product image</span>
								<input
									type="file"
									accept="image/*"
									on:change={(event) => {
										void handleImageUpload(product.id, event);
									}}
								/>
							</label>
							{#if uploadStates[product.id]?.message}
								<p class:upload-error={uploadStates[product.id]?.error} class="upload-message">
									{uploadStates[product.id]?.message}
								</p>
							{/if}
						</div>
					</article>
				{/each}
			</div>

			<div class="pager">
				<button
					type="button"
					on:click={() => {
						void fetchProducts(pagination.page - 1);
					}}
					disabled={!pagination.hasPreviousPage || loadingProducts}
				>
					Previous
				</button>
				<button
					type="button"
					on:click={() => {
						void fetchProducts(pagination.page + 1);
					}}
					disabled={!pagination.hasNextPage || loadingProducts}
				>
					Next
				</button>
			</div>
		</section>

		<aside class="checkout-panel">
			<section class="queue-card" data-testid="offline-queue-panel">
				<div class="panel-header compact">
					<div>
						<p class="section-kicker">Offline Queue</p>
						<h2>IndexedDB sync state</h2>
					</div>
					<button
						type="button"
						class="secondary"
						disabled={!isOnline || queueSummary.pending === 0 || syncingQueue}
						on:click={() => {
							void triggerOfflineSync();
						}}
						data-testid="sync-now-button"
					>
						{syncingQueue ? 'Syncing...' : 'Sync now'}
					</button>
				</div>

				<div class="queue-summary">
					<span data-testid="queue-pending-count">Pending {queueSummary.pending}</span>
					<span>Syncing {queueSummary.syncing}</span>
					<span>Synced {queueSummary.synced}</span>
					<span data-testid="queue-conflict-count">Review {queueSummary.conflicts}</span>
				</div>

				<p class="queue-message" data-testid="sync-message">{syncMessage}</p>

				{#if queueRecords.length === 0}
					<p class="empty-state">No offline transactions stored in IndexedDB.</p>
				{:else}
					<ul class="queue-list" data-testid="offline-queue-list">
						{#each queueRecords as record}
							<li
								class="queue-item"
								data-testid={`queue-record-${record.localId}`}
								data-status={record.status}
							>
								<div class="queue-item-header">
									<div>
										<strong>{record.receiptNumber}</strong>
										<span>{new Date(record.createdAt).toLocaleString()}</span>
									</div>
									<span class={`queue-status queue-status-${record.status}`}>
										{queueStatusLabel(record.status)}
									</span>
								</div>
								<div class="queue-item-meta">
									<span>{record.itemCount} item(s)</span>
									<span>{formatCents(record.totalAmountCents, store.currencyCode)}</span>
								</div>
								{#if record.lastError}
									<p class="inline-error">{record.lastError}</p>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}

				<div class="queue-debug">
					<p class="section-kicker">IndexedDB Snapshot</p>
					<pre data-testid="indexeddb-snapshot">{indexedDbSnapshot}</pre>
				</div>
			</section>

			<section class="cart-card">
				<div class="panel-header compact">
					<div>
						<p class="section-kicker">Cart</p>
						<h2>Cashier basket</h2>
					</div>
					<span class="cart-count" data-testid="cart-count">{itemCount} items</span>
				</div>

				{#if cartEntries.length === 0}
					<p class="empty-state">Add products from the catalog to start a sale.</p>
				{:else}
					<ul class="cart-list">
						{#each cartEntries as entry}
							<li>
								<div>
									<strong>{entry.product.name}</strong>
									<span>{formatCents(entry.product.priceCents, store.currencyCode)}</span>
								</div>
								<div class="cart-actions">
									<button type="button" on:click={() => updateCartQuantity(entry.product.id, entry.quantity - 1)}>
										-
									</button>
									<span>{entry.quantity}</span>
									<button type="button" on:click={() => updateCartQuantity(entry.product.id, entry.quantity + 1)}>
										+
									</button>
								</div>
							</li>
						{/each}
					</ul>
				{/if}

				<div class="totals">
					<div>
						<span>Subtotal</span>
						<strong>{formatCents(subtotalCents, store.currencyCode)}</strong>
					</div>
					<label class="cash-field">
						<span>Cash received</span>
						<input
							type="text"
							inputmode="decimal"
							placeholder="0.00"
							bind:value={cashInput}
							aria-label="Cash received"
						/>
					</label>
					<div>
						<span>Change due</span>
						<strong>{formatCents(changeDueCents, store.currencyCode)}</strong>
					</div>
				</div>

				{#if saleError}
					<p class="inline-error">{saleError}</p>
				{/if}

				<button
					type="button"
					class="checkout-button"
					disabled={!canCheckout}
					data-testid="checkout-button"
					on:click={() => {
						void completeSale();
					}}
				>
					{submittingSale ? 'Processing sale...' : isOnline ? 'Complete sale' : 'Save offline sale'}
				</button>
			</section>

			<section class="receipt-card" data-testid="receipt-preview">
				<div class="receipt-header">
					<div>
						<p class="section-kicker">Receipt preview</p>
						<h2>
							{#if receipt && receiptMode === 'queued'}
								Queued offline receipt
							{:else if receipt}
								Receipt issued
							{:else}
								Draft receipt
							{/if}
						</h2>
					</div>
					{#if receipt}
						<span class="receipt-pill">{receipt.receiptNumber}</span>
					{/if}
				</div>

				<div class="receipt-body">
					<div class="receipt-store">
						<strong>{store.name}</strong>
						<span>{store.address}</span>
						{#if receipt}
							<span>{new Date(receipt.createdAt).toLocaleString()}</span>
						{:else}
							<span>Ready for cashier confirmation</span>
						{/if}
						{#if receiptMode === 'queued'}
							<span class="queue-note">Waiting for automatic background sync.</span>
						{/if}
					</div>

					<div class="receipt-lines">
						<div class="receipt-line header">
							<span>Item</span>
							<span>Qty</span>
							<span>Total</span>
						</div>
						{#each receiptLines as line}
							<div class="receipt-line">
								<div>
									<strong>{line.productName}</strong>
									<span>{line.barcode}</span>
								</div>
								<span>{line.quantity}</span>
								<span>{formatCents(line.lineTotalCents, store.currencyCode)}</span>
							</div>
						{/each}
					</div>

					<div class="receipt-totals">
						<div>
							<span>Subtotal</span>
							<strong>{formatCents(receipt?.subtotalCents ?? subtotalCents, store.currencyCode)}</strong>
						</div>
						<div>
							<span>Cash</span>
							<strong>
								{formatCents(receipt?.cashReceivedCents ?? cashReceivedCents, store.currencyCode)}
							</strong>
						</div>
						<div>
							<span>Change</span>
							<strong>
								{formatCents(receipt?.changeDueCents ?? changeDueCents, store.currencyCode)}
							</strong>
						</div>
					</div>
				</div>
			</section>
		</aside>
	</div>
</div>

<style>
	:global(body) {
		margin: 0;
		font-family: 'Aptos', 'Trebuchet MS', 'Segoe UI', sans-serif;
		background:
			radial-gradient(circle at top left, rgba(245, 127, 23, 0.2), transparent 35%),
			radial-gradient(circle at top right, rgba(10, 77, 104, 0.18), transparent 25%),
			linear-gradient(180deg, #f7f4ec 0%, #efe8da 100%);
		color: #1d1f24;
	}

	:global(button),
	:global(input) {
		font: inherit;
	}

	.shell {
		max-width: 1400px;
		margin: 0 auto;
		padding: 2rem 1.25rem 3rem;
	}

	.hero {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 320px;
		gap: 1.5rem;
		margin-bottom: 1.5rem;
		align-items: stretch;
	}

	.eyebrow,
	.section-kicker {
		margin: 0 0 0.5rem;
		font-size: 0.75rem;
		font-weight: 700;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: #8a4d13;
	}

	h1,
	h2,
	h3,
	p {
		margin: 0;
	}

	h1 {
		font-size: clamp(2rem, 4vw, 3.75rem);
		line-height: 0.95;
		letter-spacing: -0.04em;
		margin-bottom: 0.85rem;
	}

	h2 {
		font-size: 1.35rem;
	}

	.lead {
		max-width: 60ch;
		line-height: 1.6;
		color: #3d4350;
	}

	.store-card,
	.catalog-panel,
	.queue-card,
	.cart-card,
	.receipt-card {
		background: rgba(255, 251, 244, 0.9);
		border: 1px solid rgba(123, 78, 36, 0.12);
		border-radius: 24px;
		box-shadow: 0 20px 50px rgba(61, 67, 80, 0.08);
		backdrop-filter: blur(16px);
	}

	.store-card {
		padding: 1.25rem;
		display: grid;
		gap: 0.5rem;
		align-content: start;
	}

	.store-label {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.8rem;
		font-weight: 700;
		color: #0a4d68;
	}

	.store-switcher {
		display: grid;
		gap: 0.35rem;
		font-size: 0.85rem;
		color: #5f6775;
	}

	.store-switcher select {
		border: 1px solid rgba(29, 31, 36, 0.12);
		border-radius: 12px;
		padding: 0.65rem 0.75rem;
		background: rgba(255, 255, 255, 0.8);
		color: inherit;
	}

	.network-pill {
		display: inline-flex;
		width: fit-content;
		padding: 0.35rem 0.7rem;
		border-radius: 999px;
		background: rgba(10, 77, 104, 0.08);
		color: #0a4d68;
		font-size: 0.85rem;
		font-weight: 700;
	}

	.network-pill.is-offline {
		background: rgba(161, 41, 41, 0.12);
		color: #a12929;
	}

	.workspace {
		display: grid;
		grid-template-columns: minmax(0, 1.7fr) minmax(360px, 0.9fr);
		gap: 1.5rem;
	}

	.catalog-panel,
	.queue-card,
	.cart-card,
	.receipt-card {
		padding: 1.25rem;
	}

	.checkout-panel {
		display: grid;
		gap: 1rem;
		align-content: start;
	}

	.panel-header {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		align-items: center;
		margin-bottom: 1rem;
	}

	.panel-header.compact {
		margin-bottom: 0.75rem;
	}

	.search-bar {
		display: flex;
		gap: 0.75rem;
	}

	.search-bar input,
	.cash-field input {
		border: 1px solid rgba(29, 31, 36, 0.12);
		border-radius: 14px;
		background: rgba(255, 255, 255, 0.8);
		padding: 0.8rem 1rem;
		color: inherit;
	}

	.search-bar input {
		min-width: min(420px, 48vw);
	}

	button {
		border: 0;
		border-radius: 14px;
		padding: 0.8rem 1rem;
		font-weight: 700;
		cursor: pointer;
		transition:
			transform 0.16s ease,
			opacity 0.16s ease,
			background 0.16s ease;
	}

	button:hover:enabled {
		transform: translateY(-1px);
	}

	button:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.search-bar button,
	.primary,
	.checkout-button {
		background: linear-gradient(135deg, #0a4d68, #167799);
		color: #f8fbff;
	}

	.secondary {
		background: rgba(16, 36, 49, 0.08);
		color: #1d1f24;
	}

	.catalog-meta,
	.pager {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
	}

	.catalog-meta {
		margin-bottom: 1rem;
		color: #5f6775;
		font-size: 0.95rem;
	}

	.product-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
		gap: 1rem;
	}

	.product-card {
		display: grid;
		gap: 0.9rem;
		padding: 1rem;
		border-radius: 20px;
		background: linear-gradient(180deg, rgba(255, 255, 255, 0.92), rgba(245, 238, 229, 0.85));
		border: 1px solid rgba(16, 36, 49, 0.08);
	}

	.product-media {
		aspect-ratio: 4 / 3;
		border-radius: 18px;
		overflow: hidden;
		background: linear-gradient(135deg, rgba(245, 127, 23, 0.2), rgba(10, 77, 104, 0.14));
	}

	.product-media img,
	.product-placeholder {
		width: 100%;
		height: 100%;
	}

	.product-media img {
		object-fit: cover;
		display: block;
	}

	.product-placeholder {
		display: grid;
		place-items: center;
		font-size: 2rem;
		font-weight: 800;
		color: #8a4d13;
	}

	.product-copy {
		display: grid;
		gap: 0.85rem;
	}

	.product-topline {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		align-items: start;
	}

	.product-topline p,
	.product-description {
		color: #5f6775;
		font-size: 0.95rem;
		line-height: 1.45;
	}

	.product-topline span {
		padding: 0.35rem 0.65rem;
		border-radius: 999px;
		background: rgba(10, 77, 104, 0.1);
		color: #0a4d68;
		font-size: 0.8rem;
		font-weight: 700;
		white-space: nowrap;
	}

	.product-topline span.low-stock {
		background: rgba(245, 127, 23, 0.16);
		color: #8a4d13;
	}

	.product-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.upload-field {
		display: grid;
		gap: 0.4rem;
		font-size: 0.85rem;
		color: #5f6775;
	}

	.upload-field input {
		padding: 0.5rem 0;
	}

	.upload-message {
		font-size: 0.85rem;
		color: #0a4d68;
	}

	.upload-message.upload-error,
	.inline-error {
		color: #a12929;
	}

	.queue-card {
		background: rgba(250, 247, 240, 0.92);
	}

	.queue-summary {
		display: flex;
		flex-wrap: wrap;
		gap: 0.65rem;
		margin-bottom: 0.9rem;
	}

	.queue-summary span,
	.queue-status {
		display: inline-flex;
		align-items: center;
		padding: 0.35rem 0.7rem;
		border-radius: 999px;
		font-size: 0.82rem;
		font-weight: 700;
	}

	.queue-summary span {
		background: rgba(10, 77, 104, 0.08);
		color: #0a4d68;
	}

	.queue-message {
		margin-bottom: 0.9rem;
		color: #3d4350;
		line-height: 1.5;
	}

	.queue-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 0.85rem;
	}

	.queue-item {
		padding: 0.9rem;
		border-radius: 16px;
		background: rgba(255, 255, 255, 0.82);
		border: 1px solid rgba(16, 36, 49, 0.08);
	}

	.queue-item-header,
	.queue-item-meta {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
	}

	.queue-item-header {
		margin-bottom: 0.55rem;
	}

	.queue-item-header span,
	.queue-item-meta span {
		color: #5f6775;
		font-size: 0.9rem;
	}

	.queue-status-pending,
	.queue-status-syncing {
		background: rgba(245, 127, 23, 0.14);
		color: #8a4d13;
	}

	.queue-status-synced {
		background: rgba(10, 77, 104, 0.12);
		color: #0a4d68;
	}

	.queue-status-conflict {
		background: rgba(161, 41, 41, 0.12);
		color: #a12929;
	}

	.queue-note {
		color: #8a4d13;
		font-weight: 700;
	}

	.queue-debug {
		margin-top: 1rem;
	}

	.queue-debug pre {
		margin: 0;
		padding: 0.85rem;
		border-radius: 14px;
		background: rgba(16, 36, 49, 0.06);
		color: #33404f;
		font-size: 0.76rem;
		line-height: 1.45;
		overflow: auto;
		max-height: 240px;
	}

	.pager {
		margin-top: 1rem;
	}

	.pager button,
	.cart-actions button {
		background: rgba(16, 36, 49, 0.08);
		color: #1d1f24;
	}

	.cart-count {
		padding: 0.35rem 0.75rem;
		border-radius: 999px;
		background: rgba(10, 77, 104, 0.08);
		color: #0a4d68;
		font-weight: 700;
	}

	.empty-state {
		color: #5f6775;
		line-height: 1.6;
	}

	.cart-list {
		list-style: none;
		padding: 0;
		margin: 0 0 1rem;
		display: grid;
		gap: 0.85rem;
	}

	.cart-list li {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		align-items: center;
		padding: 0.9rem 0;
		border-bottom: 1px solid rgba(16, 36, 49, 0.08);
	}

	.cart-list li span {
		display: block;
		color: #5f6775;
		font-size: 0.9rem;
	}

	.cart-actions {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.cart-actions button {
		width: 34px;
		height: 34px;
		padding: 0;
		border-radius: 10px;
	}

	.totals {
		display: grid;
		gap: 0.85rem;
		margin-bottom: 1rem;
	}

	.totals > div,
	.cash-field {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
	}

	.cash-field {
		flex-direction: column;
		align-items: stretch;
	}

	.cash-field span {
		font-weight: 600;
	}

	.checkout-button {
		width: 100%;
	}

	.receipt-card {
		font-family: 'Cascadia Mono', 'Consolas', monospace;
	}

	.receipt-header {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		align-items: start;
		margin-bottom: 1rem;
	}

	.receipt-pill {
		padding: 0.35rem 0.65rem;
		border-radius: 999px;
		background: rgba(245, 127, 23, 0.14);
		color: #8a4d13;
		font-size: 0.78rem;
		font-weight: 700;
	}

	.receipt-body {
		display: grid;
		gap: 1rem;
	}

	.receipt-store {
		display: grid;
		gap: 0.3rem;
		color: #5f6775;
	}

	.receipt-lines {
		display: grid;
		gap: 0.65rem;
	}

	.receipt-line {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 52px 90px;
		gap: 1rem;
		align-items: start;
		font-size: 0.88rem;
	}

	.receipt-line.header {
		color: #5f6775;
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		border-bottom: 1px dashed rgba(16, 36, 49, 0.15);
		padding-bottom: 0.5rem;
	}

	.receipt-line strong,
	.receipt-line span {
		display: block;
	}

	.receipt-totals {
		display: grid;
		gap: 0.45rem;
		padding-top: 0.8rem;
		border-top: 1px dashed rgba(16, 36, 49, 0.15);
	}

	.receipt-totals > div {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
	}

	@media (max-width: 1080px) {
		.hero,
		.workspace {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 720px) {
		.shell {
			padding-inline: 0.85rem;
		}

		.search-bar {
			flex-direction: column;
		}

		.search-bar input {
			min-width: 0;
		}

		.panel-header,
		.catalog-meta,
		.pager,
		.product-footer,
		.receipt-header {
			flex-direction: column;
			align-items: stretch;
		}
	}
</style>
