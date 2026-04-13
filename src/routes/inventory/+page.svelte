<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import { formatCents } from '$lib/currency';
	import type {
		InventorySyncResponse,
		LowStockDispatchResponse,
		LowStockReportResponse,
		PendingInventoryActionRecord,
		ProductSummary,
		PurchaseOrderResponse,
		SupplierSummary
	} from '$lib/types';
	import type { PageData } from './$types';

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

	export let data: PageData;

	let store = data.store;
	let suppliers = data.suppliers;
	let products = data.products;
	let lowStockReport: LowStockReportResponse = data.lowStockReport;
	let recentBatches = data.recentBatches;
	let recentMovements = data.recentMovements;
	let selectedSupplierId = suppliers[0]?.id ?? '';
	let selectedProductId = products.find((product) => product.lowStock)?.id ?? products[0]?.id ?? '';
	let quantityInput = '6';
	let unitCostInput = '420';
	let batchCodeInput = 'REC-APR-01';
	let expiryDateInput = '';
	let notesInput = '';
	let isOnline = true;
	let submittingPurchaseOrder = false;
	let sendingAlert = false;
	let formError = '';
	let alertMessage = '';
	let queueMessage = 'No queued inventory actions.';
	let lastPurchaseOrder: PurchaseOrderResponse['purchaseOrder'] | null = null;
	let queueRecords: PendingInventoryActionRecord[] = [];
	let queueSummary: QueueSummary = {
		pending: 0,
		syncing: 0,
		synced: 0,
		conflicts: 0
	};
	let queueSnapshot = '[]';
	let serviceWorkerRegistration: ServiceWorkerRegistration | null = null;
	let serviceWorkerRegistrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;
	let offlineModulePromise: Promise<OfflineDbModule> | null = null;
	let offlineRuntimeReady = false;
	let hydrated = false;
	let syncingQueue = false;
	let syncFallbackTimer: ReturnType<typeof setTimeout> | null = null;

	const selectedSupplier = () =>
		suppliers.find((supplier) => supplier.id === selectedSupplierId) ?? suppliers[0] ?? null;
	const selectedProduct = () =>
		products.find((product) => product.id === selectedProductId) ?? products[0] ?? null;

	onMount(() => {
		hydrated = true;
		isOnline = navigator.onLine;
		serviceWorkerRegistrationPromise = registerOfflineSyncWorker();
		void initializeOfflineRuntime();

		const handleOnline = () => {
			isOnline = true;
			queueMessage = queueSummary.pending
				? 'Connection restored. Syncing queued inventory actions...'
				: 'Inventory tools are back online.';
			void triggerInventorySync();
		};

		const handleOffline = () => {
			isOnline = false;
			queueMessage = 'Offline mode active. Purchase orders will queue locally.';
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

	$: queueSummary =
		queueRecords.reduce(
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
		) ?? queueSummary;
	$: queueSnapshot = JSON.stringify(
		queueRecords.map((record) => ({
			localId: record.localId,
			actionType: record.actionType,
			status: record.status,
			summary: record.summary,
			lastError: record.lastError
		})),
		null,
		2
	);

	function getOfflineModule() {
		offlineModulePromise ??= import('$lib/client/offline-db');
		return offlineModulePromise;
	}

	async function initializeOfflineRuntime() {
		if (!browser) {
			return;
		}

		try {
			await getOfflineModule();
			offlineRuntimeReady = true;
			await refreshQueueState();
		} catch (error) {
			queueMessage =
				error instanceof Error
					? error.message
					: 'Offline inventory storage failed to initialize.';
		}
	}

	async function registerOfflineSyncWorker() {
		if (!browser || !('serviceWorker' in navigator)) {
			return null;
		}

		await navigator.serviceWorker.register('/offline-sync-sw.js');
		serviceWorkerRegistration = await navigator.serviceWorker.ready;
		return serviceWorkerRegistration;
	}

	function handleServiceWorkerMessage(event: MessageEvent) {
		const payload = event.data;

		if (!payload || typeof payload !== 'object' || !('type' in payload)) {
			return;
		}

		if (payload.type === 'OFFLINE_INVENTORY_SYNC_RESULT') {
			clearSyncFallbackTimer();
			syncingQueue = false;
			const result = payload as InventorySyncResponse & { type: string };
			applyUpdatedProducts(result.updatedProducts ?? []);
			queueMessage =
				(result.accepted?.length ?? 0) > 0
					? `${result.accepted.length} inventory action(s) synced.`
					: (result.rejected?.length ?? 0) > 0
						? `${result.rejected.length} inventory action(s) need review.`
						: 'No queued inventory actions.';
			void refreshLowStockReport();
			void refreshQueueState();
		}

		if (payload.type === 'OFFLINE_INVENTORY_SYNC_ERROR') {
			clearSyncFallbackTimer();
			syncingQueue = false;
			queueMessage =
				typeof payload.message === 'string'
					? payload.message
					: 'Offline inventory sync failed. Pending actions remain queued.';
			void refreshQueueState();
		}
	}

	async function refreshQueueState() {
		const offline = await getOfflineModule();
		queueRecords = await offline.listQueuedInventoryActions();

		if (queueSummary.pending === 0 && queueSummary.syncing === 0 && queueSummary.conflicts === 0) {
			queueMessage = queueSummary.synced
				? 'Queued inventory work has been synced.'
				: isOnline
					? 'No queued inventory actions.'
					: 'Offline mode active. Purchase orders will queue locally.';
		}
	}

	async function refreshLowStockReport() {
		const response = await fetch('/api/reports/low-stock');
		const payload = (await response.json()) as LowStockReportResponse | { message?: string };

		if (!response.ok || !('items' in payload)) {
			return;
		}

		lowStockReport = payload;
	}

	function applyUpdatedProducts(
		updates: Array<{
			id: string;
			stockQuantity: number;
		}>
	) {
		if (updates.length === 0) {
			return;
		}

		const updatesById = new Map(updates.map((update) => [update.id, update.stockQuantity]));
		products = products.map((product) => {
			const stockQuantity = updatesById.get(product.id);

			if (stockQuantity === undefined) {
				return product;
			}

			return {
				...product,
				stockQuantity,
				lowStock: stockQuantity <= product.reorderPoint
			};
		});
	}

	function applyLocalPurchaseOrderDelta(productId: string, quantity: number) {
		products = products.map((product) =>
			product.id === productId
				? {
						...product,
						stockQuantity: product.stockQuantity + quantity,
						lowStock: product.stockQuantity + quantity <= product.reorderPoint
					}
				: product
		);
	}

	async function triggerInventorySync() {
		if (!browser || !navigator.onLine) {
			return;
		}

		const offline = await getOfflineModule();
		const queued = await offline.listQueuedInventoryActions();
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
				// Ignore duplicate or unsupported registrations.
			}
		}

		const activeWorker = registration?.active ?? navigator.serviceWorker.controller;

		if (!activeWorker) {
			await performDirectInventorySync();
			return;
		}

		activeWorker.postMessage({
			type: 'SYNC_OFFLINE_INVENTORY'
		});
		scheduleDirectSyncFallback();
	}

	async function performDirectInventorySync() {
		if (!browser || !navigator.onLine) {
			return;
		}

		clearSyncFallbackTimer();
		const offline = await getOfflineModule();
		const queued = await offline.listQueuedInventoryActions();
		const pending = queued.filter(
			(record) => record.status === 'pending' || record.status === 'syncing'
		);

		if (pending.length === 0) {
			syncingQueue = false;
			return;
		}

		syncingQueue = true;
		const now = new Date().toISOString();

		for (const record of pending) {
			await offline.updateQueuedInventoryAction(record.localId, {
				status: 'syncing',
				lastError: null
			});
		}

		await refreshQueueState();

		try {
			const response = await fetch('/api/sync/inventory-actions', {
				method: 'POST',
				headers: {
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					actions: pending.map((record) =>
						record.actionType === 'purchase_order'
							? {
									localId: record.localId,
									actionType: record.actionType,
									storeId: record.storeId,
									createdAt: record.createdAt,
									summary: record.summary,
									supplierId: record.supplierId,
									notes: record.notes,
									receiveNow: record.receiveNow,
									items: record.items
								}
							: {
									localId: record.localId,
									actionType: record.actionType,
									storeId: record.storeId,
									createdAt: record.createdAt,
									summary: record.summary,
									productId: record.productId,
									quantityDelta: record.quantityDelta,
									reason: record.reason,
									batchCode: record.batchCode,
									expiryDate: record.expiryDate
								}
					)
				})
			});
			const payload = (await response.json()) as InventorySyncResponse | { message?: string };

			if (!response.ok || !('accepted' in payload)) {
				throw new Error(
					typeof payload === 'object' && payload && 'message' in payload
						? (payload.message ?? 'Offline inventory sync failed.')
						: 'Offline inventory sync failed.'
				);
			}

			for (const entry of payload.accepted) {
				await offline.updateQueuedInventoryAction(entry.localId, {
					status: 'synced',
					syncedAt: entry.syncedAt ?? now,
					conflictAt: null,
					serverEntityId: entry.entityId,
					serverReference: entry.referenceNumber ?? null,
					lastError: null
				});
			}

			for (const entry of payload.rejected) {
				await offline.updateQueuedInventoryAction(entry.localId, {
					status: 'conflict',
					syncedAt: null,
					conflictAt: now,
					lastError: entry.message
				});
			}

			applyUpdatedProducts(payload.updatedProducts);
			queueMessage =
				payload.accepted.length > 0
					? `${payload.accepted.length} inventory action(s) synced.`
					: payload.rejected.length > 0
						? `${payload.rejected.length} inventory action(s) need review.`
						: 'No queued inventory actions.';
			await refreshLowStockReport();
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Offline inventory sync failed.';

			for (const record of pending) {
				await offline.updateQueuedInventoryAction(record.localId, {
					status: 'pending',
					lastError: message
				});
			}

			queueMessage = message;
		} finally {
			syncingQueue = false;
			await refreshQueueState();
		}
	}

	function scheduleDirectSyncFallback() {
		clearSyncFallbackTimer();
		syncFallbackTimer = setTimeout(() => {
			void performDirectInventorySync();
		}, 1800);
	}

	function clearSyncFallbackTimer() {
		if (syncFallbackTimer) {
			clearTimeout(syncFallbackTimer);
			syncFallbackTimer = null;
		}
	}

	async function submitPurchaseOrder() {
		const supplier = selectedSupplier();
		const product = selectedProduct();
		const quantity = Number.parseInt(quantityInput, 10);
		const unitCostCents = Number.parseInt(unitCostInput, 10);

		if (!supplier || !product) {
			formError = 'Choose both a supplier and a product.';
			return;
		}

		if (!Number.isInteger(quantity) || quantity <= 0) {
			formError = 'Quantity must be a whole number greater than zero.';
			return;
		}

		if (!Number.isInteger(unitCostCents) || unitCostCents < 0) {
			formError = 'Unit cost must be a non-negative cent value.';
			return;
		}

		const batchCode = batchCodeInput.trim().toUpperCase();

		if (!batchCode) {
			formError = 'Batch code is required for received stock.';
			return;
		}

		submittingPurchaseOrder = true;
		formError = '';
		const offline = await getOfflineModule();
		const submission = offline.buildOfflinePurchaseOrderSubmission({
			store,
			supplier,
			items: [
				{
					product,
					quantity,
					unitCostCents,
					batchCode,
					expiryDate: expiryDateInput || null
				}
			],
			notes: notesInput,
			receiveNow: true
		});

		try {
			if (!isOnline) {
				await offline.savePendingInventoryAction(
					offline.buildPendingInventoryActionRecord(submission)
				);
				applyLocalPurchaseOrderDelta(product.id, quantity);
				queueMessage = 'Purchase order queued offline and applied locally.';
				await refreshQueueState();
				return;
			}

			const response = await fetch('/api/purchase-orders', {
				method: 'POST',
				headers: {
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					storeId: store.id,
					supplierId: supplier.id,
					notes: notesInput,
					receiveNow: true,
					items: [
						{
							productId: product.id,
							quantity,
							unitCostCents,
							batchCode,
							expiryDate: expiryDateInput || null
						}
					]
				})
			});
			const payload = (await response.json()) as PurchaseOrderResponse | { message?: string };

			if (!response.ok || !('purchaseOrder' in payload)) {
				throw new Error(
					typeof payload === 'object' && payload && 'message' in payload
						? (payload.message ?? 'Purchase order failed.')
						: 'Purchase order failed.'
				);
			}

			lastPurchaseOrder = payload.purchaseOrder;
			applyUpdatedProducts(payload.updatedProducts);
			recentBatches = [...payload.purchaseOrder.batches, ...recentBatches].slice(0, 8);
			queueMessage = 'Purchase order received online.';
			await refreshLowStockReport();
		} catch (error) {
			if (!navigator.onLine || error instanceof TypeError) {
				isOnline = navigator.onLine;
				await offline.savePendingInventoryAction(
					offline.buildPendingInventoryActionRecord(submission)
				);
				applyLocalPurchaseOrderDelta(product.id, quantity);
				queueMessage = 'Purchase order queued offline and applied locally.';
				await refreshQueueState();
			} else {
				formError = error instanceof Error ? error.message : 'Purchase order failed.';
			}
		} finally {
			submittingPurchaseOrder = false;
		}
	}

	async function sendLowStockAlert() {
		sendingAlert = true;
		alertMessage = '';

		try {
			const response = await fetch('/api/reports/low-stock/dispatch', {
				method: 'POST'
			});
			const payload = (await response.json()) as LowStockDispatchResponse | { message?: string };

			if (!response.ok || !('delivery' in payload)) {
				throw new Error(
					typeof payload === 'object' && payload && 'message' in payload
						? (payload.message ?? 'Low stock alert failed.')
						: 'Low stock alert failed.'
				);
			}

			lowStockReport = payload.report;
			alertMessage = `Alert sent via ${payload.delivery.transport} transport to ${payload.delivery.recipient}.`;
		} catch (error) {
			alertMessage = error instanceof Error ? error.message : 'Low stock alert failed.';
		} finally {
			sendingAlert = false;
		}
	}

	function stockLabel(product: ProductSummary) {
		return `${product.stockQuantity} on hand`;
	}

	function queueStatusLabel(status: PendingInventoryActionRecord['status']) {
		if (status === 'pending') return 'Pending sync';
		if (status === 'syncing') return 'Syncing';
		if (status === 'synced') return 'Synced';
		return 'Review needed';
	}
</script>

<svelte:head>
	<title>Inventory Management</title>
</svelte:head>

<div
	class="inventory-shell"
	data-offline-ready={offlineRuntimeReady ? 'true' : 'false'}
	data-ready={hydrated ? 'true' : 'false'}
>
	<header class="hero">
		<div>
			<p class="eyebrow">Inventory Management</p>
			<h1>Purchasing, batches, and low stock alerts</h1>
			<p class="lead">
				Receive supplier stock online, queue purchase orders offline, and dispatch low stock alerts
				from the Cloudflare Worker schedule.
			</p>
			<nav class="nav">
				<a href="/">POS</a>
				<a href="/inventory" aria-current="page">Inventory</a>
				<a href="/inventory/stock-take">Stock Take</a>
			</nav>
		</div>
		<div class="status-card">
			<span>Store: {store.name}</span>
			<span class:offline={!isOnline} data-testid="inventory-network-status">
				{isOnline ? 'Online' : 'Offline'}
			</span>
			<span>Queued: {queueSummary.pending}</span>
			<span>Review: {queueSummary.conflicts}</span>
		</div>
	</header>

	<div class="layout">
		<section class="panel" data-testid="po-form-panel">
			<div class="panel-header">
				<div>
					<p class="section-kicker">Purchase Orders</p>
					<h2>Create and receive stock</h2>
				</div>
			</div>

			<div class="form-grid">
				<label>
					<span>Supplier</span>
					<select bind:value={selectedSupplierId}>
						{#each suppliers as supplier}
							<option value={supplier.id}>{supplier.name}</option>
						{/each}
					</select>
				</label>
				<label>
					<span>Product</span>
					<select bind:value={selectedProductId}>
						{#each products as product}
							<option value={product.id}>{product.name}</option>
						{/each}
					</select>
				</label>
				<label>
					<span>Quantity</span>
					<input bind:value={quantityInput} inputmode="numeric" />
				</label>
				<label>
					<span>Unit cost (cents)</span>
					<input bind:value={unitCostInput} inputmode="numeric" />
				</label>
				<label>
					<span>Batch code</span>
					<input bind:value={batchCodeInput} />
				</label>
				<label>
					<span>Expiry date</span>
					<input bind:value={expiryDateInput} type="date" />
				</label>
				<label class="full">
					<span>Notes</span>
					<textarea bind:value={notesInput} rows="3"></textarea>
				</label>
			</div>

			{#if formError}
				<p class="error">{formError}</p>
			{/if}

			<button
				type="button"
				class="primary"
				on:click={() => {
					void submitPurchaseOrder();
				}}
				disabled={submittingPurchaseOrder}
				data-testid="po-submit-button"
			>
				{submittingPurchaseOrder ? 'Receiving stock...' : isOnline ? 'Create and receive PO' : 'Queue PO offline'}
			</button>

			{#if lastPurchaseOrder}
				<div class="result-card" data-testid="last-po-card">
					<p class="section-kicker">Last Purchase Order</p>
					<strong data-testid="po-number">{lastPurchaseOrder.poNumber}</strong>
					<span>{lastPurchaseOrder.supplierName}</span>
					<span>{formatCents(lastPurchaseOrder.totalCostCents, store.currencyCode)}</span>
				</div>
			{/if}
		</section>

		<section class="panel" data-testid="low-stock-widget">
			<div class="panel-header">
				<div>
					<p class="section-kicker">Low Stock</p>
					<h2>Alert widget</h2>
				</div>
				<button
					type="button"
					class="secondary"
					on:click={() => {
						void sendLowStockAlert();
					}}
					disabled={sendingAlert}
					data-testid="send-low-stock-alert"
				>
					{sendingAlert ? 'Sending...' : 'Send alert now'}
				</button>
			</div>

			{#if alertMessage}
				<p class="message">{alertMessage}</p>
			{/if}

			<ul class="low-stock-list">
				{#each lowStockReport.items as item}
					<li>
						<div>
							<strong>{item.productName}</strong>
							<span>{item.stockQuantity} / reorder {item.reorderPoint}</span>
						</div>
						<span>{item.nextBatchCode ?? 'no batch'}{item.nextExpiryDate ? ` • ${item.nextExpiryDate}` : ''}</span>
					</li>
				{/each}
			</ul>

			{#if lowStockReport.lastDelivery}
				<div class="delivery" data-testid="low-stock-delivery">
					<strong>{lowStockReport.lastDelivery.subject}</strong>
					<span>{lowStockReport.lastDelivery.transport} • {lowStockReport.lastDelivery.status}</span>
				</div>
			{/if}
		</section>

		<section class="panel wide">
			<div class="panel-header">
				<div>
					<p class="section-kicker">Product Stock</p>
					<h2>Inventory snapshot</h2>
				</div>
				<span>{products.length} products</span>
			</div>

			<div class="product-grid">
				{#each products as product}
					<article
						class:low={product.lowStock}
						class="product-card"
						data-testid={`inventory-product-${product.id}`}
					>
						<div>
							<strong>{product.name}</strong>
							<span>{product.barcode}</span>
						</div>
						<div class="product-meta">
							<span data-testid={`inventory-product-stock-${product.id}`}>
								{stockLabel(product)}
							</span>
							<span>Reorder {product.reorderPoint}</span>
						</div>
					</article>
				{/each}
			</div>
		</section>

		<section class="panel" data-testid="inventory-queue-panel">
			<div class="panel-header">
				<div>
					<p class="section-kicker">Offline Queue</p>
					<h2>Inventory sync state</h2>
				</div>
				<button
					type="button"
					class="secondary"
					on:click={() => {
						void triggerInventorySync();
					}}
					disabled={!isOnline || queueSummary.pending === 0 || syncingQueue}
					data-testid="inventory-sync-button"
				>
					{syncingQueue ? 'Syncing...' : 'Sync queued actions'}
				</button>
			</div>

			<div class="summary-row">
				<span>Pending {queueSummary.pending}</span>
				<span>Syncing {queueSummary.syncing}</span>
				<span>Synced {queueSummary.synced}</span>
				<span>Review {queueSummary.conflicts}</span>
			</div>
			<p class="message" data-testid="inventory-sync-message">{queueMessage}</p>

			{#if queueRecords.length === 0}
				<p class="empty">No queued inventory actions.</p>
			{:else}
				<ul class="queue-list">
					{#each queueRecords as record}
						<li class="queue-item" data-status={record.status}>
							<div>
								<strong>{record.summary}</strong>
								<span>{record.actionType}</span>
							</div>
							<span>{queueStatusLabel(record.status)}</span>
						</li>
					{/each}
				</ul>
			{/if}

			<pre data-testid="inventory-queue-snapshot">{queueSnapshot}</pre>
		</section>

		<section class="panel">
			<div class="panel-header">
				<div>
					<p class="section-kicker">Recent Batches</p>
					<h2>Expiry tracking</h2>
				</div>
			</div>
			<ul class="list">
				{#each recentBatches as batch}
					<li>
						<div>
							<strong>{batch.productName}</strong>
							<span>{batch.batchCode}</span>
						</div>
						<span>{batch.expiryDate ?? 'No expiry'} • {batch.remainingQuantity} remaining</span>
					</li>
				{/each}
			</ul>
		</section>

		<section class="panel">
			<div class="panel-header">
				<div>
					<p class="section-kicker">Movement Log</p>
					<h2>Latest stock movements</h2>
				</div>
			</div>
			<ul class="list">
				{#each recentMovements as movement}
					<li>
						<div>
							<strong>{movement.productName}</strong>
							<span>{movement.reason ?? movement.sourceType}</span>
						</div>
						<span>{movement.quantityDelta > 0 ? '+' : ''}{movement.quantityDelta} • {movement.resultingStockQuantity} on hand</span>
					</li>
				{/each}
			</ul>
		</section>
	</div>
</div>

<style>
	:global(body) {
		margin: 0;
		font-family: 'Aptos', 'Segoe UI', sans-serif;
		background: linear-gradient(180deg, #f3efe7 0%, #ebe4d7 100%);
		color: #17202a;
	}

	:global(button),
	:global(input),
	:global(select),
	:global(textarea) {
		font: inherit;
	}

	.inventory-shell {
		max-width: 1380px;
		margin: 0 auto;
		padding: 2rem 1.25rem 3rem;
	}

	.hero {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 280px;
		gap: 1rem;
		margin-bottom: 1.5rem;
	}

	.eyebrow,
	.section-kicker {
		margin: 0 0 0.45rem;
		font-size: 0.76rem;
		font-weight: 700;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: #7a4c10;
	}

	h1,
	h2,
	p {
		margin: 0;
	}

	h1 {
		font-size: clamp(2rem, 4vw, 3.4rem);
		line-height: 0.95;
		margin-bottom: 0.8rem;
	}

	.lead {
		max-width: 56ch;
		line-height: 1.6;
		color: #475161;
	}

	.nav {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin-top: 1rem;
	}

	.nav a {
		padding: 0.55rem 0.85rem;
		border-radius: 999px;
		background: rgba(18, 73, 96, 0.08);
		color: inherit;
		text-decoration: none;
		font-weight: 700;
	}

	.status-card,
	.panel {
		background: rgba(255, 251, 244, 0.92);
		border: 1px solid rgba(122, 76, 16, 0.12);
		border-radius: 24px;
		box-shadow: 0 22px 48px rgba(31, 41, 55, 0.08);
	}

	.status-card {
		padding: 1.2rem;
		display: grid;
		gap: 0.45rem;
		align-content: start;
	}

	.status-card span {
		font-weight: 600;
	}

	.status-card span.offline {
		color: #a32d2d;
	}

	.layout {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
	}

	.panel {
		padding: 1.2rem;
		display: grid;
		gap: 1rem;
	}

	.panel.wide {
		grid-column: span 2;
	}

	.panel-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
	}

	.form-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.85rem;
	}

	label {
		display: grid;
		gap: 0.35rem;
		font-size: 0.92rem;
	}

	label.full {
		grid-column: span 2;
	}

	input,
	select,
	textarea,
	pre {
		border: 1px solid rgba(23, 32, 42, 0.12);
		border-radius: 14px;
		padding: 0.85rem 0.95rem;
		background: rgba(255, 255, 255, 0.85);
		color: inherit;
	}

	button {
		border: 0;
		border-radius: 14px;
		padding: 0.85rem 1rem;
		font-weight: 700;
		cursor: pointer;
	}

	button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.primary {
		background: linear-gradient(135deg, #124960, #198074);
		color: #f8fbff;
	}

	.secondary {
		background: rgba(18, 73, 96, 0.08);
		color: inherit;
	}

	.result-card,
	.delivery {
		padding: 0.9rem;
		border-radius: 16px;
		background: rgba(18, 73, 96, 0.06);
		display: grid;
		gap: 0.25rem;
	}

	.product-grid,
	.list,
	.low-stock-list,
	.queue-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 0.75rem;
	}

	.product-grid {
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
	}

	.product-card,
	.list li,
	.low-stock-list li,
	.queue-item {
		padding: 0.95rem;
		border-radius: 18px;
		border: 1px solid rgba(23, 32, 42, 0.08);
		background: rgba(255, 255, 255, 0.84);
		display: flex;
		justify-content: space-between;
		gap: 1rem;
	}

	.product-card.low {
		border-color: rgba(163, 45, 45, 0.3);
		background: rgba(255, 243, 243, 0.9);
	}

	.product-card strong,
	.list strong,
	.low-stock-list strong,
	.queue-item strong {
		display: block;
	}

	.product-meta,
	.summary-row {
		display: flex;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.summary-row span {
		padding: 0.35rem 0.7rem;
		border-radius: 999px;
		background: rgba(18, 73, 96, 0.08);
		font-size: 0.84rem;
		font-weight: 700;
	}

	.message,
	.empty,
	.error {
		line-height: 1.5;
	}

	.error {
		color: #a32d2d;
	}

	pre {
		margin: 0;
		font-size: 0.76rem;
		line-height: 1.4;
		overflow: auto;
	}

	@media (max-width: 980px) {
		.hero,
		.layout {
			grid-template-columns: 1fr;
		}

		.panel.wide,
		label.full {
			grid-column: span 1;
		}

		.form-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
