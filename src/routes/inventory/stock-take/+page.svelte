<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import { formatCents } from '$lib/currency';
	import type {
		InventorySyncResponse,
		OfflineStockAdjustmentSubmission,
		PendingInventoryActionRecord,
		ProductSummary,
		StockAdjustmentResponse
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
	type PendingAdjustmentRecord = PendingInventoryActionRecord &
		OfflineStockAdjustmentSubmission;

	export let data: PageData;

	let store = data.store;
	let products = data.products;
	let lowStockReport = data.lowStockReport;
	let recentMovements = data.recentMovements;
	let selectedProductId = products.find((product) => product.lowStock)?.id ?? products[0]?.id ?? '';
	let quantityDeltaInput = '-2';
	let reasonInput = 'Cycle count correction';
	let batchCodeInput = '';
	let expiryDateInput = '';
	let isOnline = true;
	let errorMessage = '';
	let queueMessage = 'No queued stock adjustments.';
	let adjustmentResult: StockAdjustmentResponse | null = null;
	let queueRecords: PendingAdjustmentRecord[] = [];
	let queueSummary: QueueSummary = {
		pending: 0,
		syncing: 0,
		synced: 0,
		conflicts: 0
	};
	let queueSnapshot = '[]';
	let submitting = false;
	let syncingQueue = false;
	let serviceWorkerRegistration: ServiceWorkerRegistration | null = null;
	let serviceWorkerRegistrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;
	let offlineModulePromise: Promise<OfflineDbModule> | null = null;
	let offlineRuntimeReady = false;
	let syncFallbackTimer: ReturnType<typeof setTimeout> | null = null;

	const selectedProduct = () =>
		products.find((product) => product.id === selectedProductId) ?? products[0] ?? null;

	onMount(() => {
		isOnline = navigator.onLine;
		serviceWorkerRegistrationPromise = registerOfflineSyncWorker();
		void initializeOfflineRuntime();

		const handleOnline = () => {
			isOnline = true;
			queueMessage = queueSummary.pending
				? 'Connection restored. Syncing queued stock adjustments...'
				: 'Stock take tools are back online.';
			void triggerInventorySync();
		};

		const handleOffline = () => {
			isOnline = false;
			queueMessage = 'Offline mode active. Adjustments will queue locally.';
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
			summary: record.summary,
			status: record.status,
			lastError: record.lastError
		})),
		null,
		2
	);

	function getOfflineModule() {
		offlineModulePromise ??= import('$lib/client/offline-db');
		return offlineModulePromise;
	}

	function isPendingAdjustmentRecord(
		record: PendingInventoryActionRecord
	): record is PendingAdjustmentRecord {
		return record.actionType === 'stock_adjustment';
	}

	async function initializeOfflineRuntime() {
		try {
			await getOfflineModule();
			offlineRuntimeReady = true;
			await refreshQueueState();
		} catch (error) {
			queueMessage =
				error instanceof Error
					? error.message
					: 'Offline adjustment storage failed to initialize.';
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
					? `${result.accepted.length} stock adjustment(s) synced.`
					: (result.rejected?.length ?? 0) > 0
						? `${result.rejected.length} stock adjustment(s) need review.`
						: 'No queued stock adjustments.';
			void refreshQueueState();
		}

		if (payload.type === 'OFFLINE_INVENTORY_SYNC_ERROR') {
			clearSyncFallbackTimer();
			syncingQueue = false;
			queueMessage =
				typeof payload.message === 'string'
					? payload.message
					: 'Offline adjustment sync failed.';
			void refreshQueueState();
		}
	}

	async function refreshQueueState() {
		const offline = await getOfflineModule();
		queueRecords = (await offline.listQueuedInventoryActions()).filter(isPendingAdjustmentRecord);

		if (queueSummary.pending === 0 && queueSummary.syncing === 0 && queueSummary.conflicts === 0) {
			queueMessage = queueSummary.synced
				? 'Queued stock adjustments have been synced.'
				: isOnline
					? 'No queued stock adjustments.'
					: 'Offline mode active. Adjustments will queue locally.';
		}
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

	async function triggerInventorySync() {
		if (!browser || !navigator.onLine) {
			return;
		}

		const offline = await getOfflineModule();
		const queued = (await offline.listQueuedInventoryActions()).filter(isPendingAdjustmentRecord);
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
		const offline = await getOfflineModule();
		const queued = (await offline.listQueuedInventoryActions()).filter(
			(record): record is PendingAdjustmentRecord =>
				isPendingAdjustmentRecord(record) &&
				(record.status === 'pending' || record.status === 'syncing')
		);

		if (queued.length === 0) {
			syncingQueue = false;
			return;
		}

		const now = new Date().toISOString();
		syncingQueue = true;

		for (const record of queued) {
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
					actions: queued.map((record) => ({
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
					}))
				})
			});
			const payload = (await response.json()) as InventorySyncResponse | { message?: string };

			if (!response.ok || !('accepted' in payload)) {
				throw new Error(
					typeof payload === 'object' && payload && 'message' in payload
						? (payload.message ?? 'Offline adjustment sync failed.')
						: 'Offline adjustment sync failed.'
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
					? `${payload.accepted.length} stock adjustment(s) synced.`
					: payload.rejected.length > 0
						? `${payload.rejected.length} stock adjustment(s) need review.`
						: 'No queued stock adjustments.';
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Offline adjustment sync failed.';

			for (const record of queued) {
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

	async function submitAdjustment() {
		const product = selectedProduct();
		const quantityDelta = Number.parseInt(quantityDeltaInput, 10);

		if (!product) {
			errorMessage = 'Choose a product for the stock take.';
			return;
		}

		if (!Number.isInteger(quantityDelta) || quantityDelta === 0) {
			errorMessage = 'Quantity delta must be a non-zero whole number.';
			return;
		}

		if (!reasonInput.trim()) {
			errorMessage = 'Adjustment reason is required.';
			return;
		}

		submitting = true;
		errorMessage = '';
		const offline = await getOfflineModule();
		const submission = offline.buildOfflineStockAdjustmentSubmission({
			store,
			product,
			quantityDelta,
			reason: reasonInput,
			batchCode: batchCodeInput || null,
			expiryDate: expiryDateInput || null
		});

		try {
			if (!isOnline) {
				await offline.savePendingInventoryAction(
					offline.buildPendingInventoryActionRecord(submission)
				);
				applyUpdatedProducts([
					{
						id: product.id,
						stockQuantity: Math.max(product.stockQuantity + quantityDelta, 0)
					}
				]);
				queueMessage = 'Stock adjustment queued offline and applied locally.';
				await refreshQueueState();
				return;
			}

			const response = await fetch('/api/stock/adjust', {
				method: 'POST',
				headers: {
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					storeId: store.id,
					productId: product.id,
					quantityDelta,
					reason: reasonInput,
					batchCode: batchCodeInput || null,
					expiryDate: expiryDateInput || null
				})
			});
			const payload = (await response.json()) as StockAdjustmentResponse | { message?: string };

			if (!response.ok || !('movement' in payload)) {
				throw new Error(
					typeof payload === 'object' && payload && 'message' in payload
						? (payload.message ?? 'Stock adjustment failed.')
						: 'Stock adjustment failed.'
				);
			}

			adjustmentResult = payload;
			applyUpdatedProducts([payload.updatedProduct]);
			recentMovements = [payload.movement, ...recentMovements].slice(0, 12);
			queueMessage = 'Stock adjustment applied online.';
		} catch (error) {
			if (!navigator.onLine || error instanceof TypeError) {
				isOnline = navigator.onLine;
				await offline.savePendingInventoryAction(
					offline.buildPendingInventoryActionRecord(submission)
				);
				applyUpdatedProducts([
					{
						id: product.id,
						stockQuantity: Math.max(product.stockQuantity + quantityDelta, 0)
					}
				]);
				queueMessage = 'Stock adjustment queued offline and applied locally.';
				await refreshQueueState();
			} else {
				errorMessage = error instanceof Error ? error.message : 'Stock adjustment failed.';
			}
		} finally {
			submitting = false;
		}
	}

	function queueStatusLabel(status: PendingInventoryActionRecord['status']) {
		if (status === 'pending') return 'Pending sync';
		if (status === 'syncing') return 'Syncing';
		if (status === 'synced') return 'Synced';
		return 'Review needed';
	}

	function stockLabel(product: ProductSummary) {
		return `${product.stockQuantity} on hand`;
	}
</script>

<svelte:head>
	<title>Stock Take</title>
</svelte:head>

<div class="stock-shell" data-offline-ready={offlineRuntimeReady ? 'true' : 'false'}>
	<header class="hero">
		<div>
			<p class="eyebrow">Stock Take</p>
			<h1>Adjust live stock and sync corrections later</h1>
			<p class="lead">
				Count inventory on the floor, queue corrections while offline, and replay them into D1 once
				connectivity returns.
			</p>
			<nav class="nav">
				<a href="/">POS</a>
				<a href="/inventory">Inventory</a>
				<a href="/inventory/stock-take" aria-current="page">Stock Take</a>
			</nav>
		</div>
		<div class="status-card">
			<span>Store: {store.name}</span>
			<span class:offline={!isOnline} data-testid="stock-adjust-network-status">
				{isOnline ? 'Online' : 'Offline'}
			</span>
			<span>Pending: {queueSummary.pending}</span>
			<span>Review: {queueSummary.conflicts}</span>
		</div>
	</header>

	<div class="layout">
		<section class="panel">
			<div class="panel-header">
				<div>
					<p class="section-kicker">Adjustment Form</p>
					<h2>Post a stock correction</h2>
				</div>
			</div>

			<div class="form-grid">
				<label>
					<span>Product</span>
					<select bind:value={selectedProductId}>
						{#each products as product}
							<option value={product.id}>{product.name}</option>
						{/each}
					</select>
				</label>
				<label>
					<span>Quantity delta</span>
					<input bind:value={quantityDeltaInput} inputmode="numeric" />
				</label>
				<label class="full">
					<span>Reason</span>
					<input bind:value={reasonInput} />
				</label>
				<label>
					<span>Batch code</span>
					<input bind:value={batchCodeInput} />
				</label>
				<label>
					<span>Expiry date</span>
					<input bind:value={expiryDateInput} type="date" />
				</label>
			</div>

			{#if errorMessage}
				<p class="error">{errorMessage}</p>
			{/if}

			<button
				type="button"
				class="primary"
				on:click={() => {
					void submitAdjustment();
				}}
				disabled={submitting}
				data-testid="stock-adjust-submit-button"
			>
				{submitting ? 'Applying...' : isOnline ? 'Apply adjustment' : 'Queue adjustment offline'}
			</button>

			{#if adjustmentResult}
				<div class="result-card" data-testid="stock-adjust-result">
					<strong>{adjustmentResult.movement.productName}</strong>
					<span>{adjustmentResult.movement.quantityDelta > 0 ? '+' : ''}{adjustmentResult.movement.quantityDelta} units</span>
					<span>{adjustmentResult.updatedProduct.stockQuantity} on hand</span>
				</div>
			{/if}
		</section>

		<section class="panel">
			<div class="panel-header">
				<div>
					<p class="section-kicker">Low Stock Focus</p>
					<h2>Items under reorder point</h2>
				</div>
			</div>

			<ul class="list">
				{#each lowStockReport.items as item}
					<li>
						<div>
							<strong>{item.productName}</strong>
							<span>{item.stockQuantity} / reorder {item.reorderPoint}</span>
						</div>
						<span>{item.shortageQuantity} short</span>
					</li>
				{/each}
			</ul>
		</section>

		<section class="panel wide">
			<div class="panel-header">
				<div>
					<p class="section-kicker">Stock Ledger</p>
					<h2>Current product stock</h2>
				</div>
			</div>

			<div class="product-grid">
				{#each products as product}
					<article
						class:low={product.lowStock}
						class="product-card"
						data-testid={`stock-adjust-product-${product.id}`}
					>
						<div>
							<strong>{product.name}</strong>
							<span>{product.barcode}</span>
						</div>
						<div class="product-meta">
							<span data-testid={`stock-adjust-product-stock-${product.id}`}>{stockLabel(product)}</span>
							<span>{formatCents(product.priceCents, store.currencyCode)}</span>
						</div>
					</article>
				{/each}
			</div>
		</section>

		<section class="panel" data-testid="stock-adjust-queue-panel">
			<div class="panel-header">
				<div>
					<p class="section-kicker">Offline Queue</p>
					<h2>Queued adjustments</h2>
				</div>
				<button
					type="button"
					class="secondary"
					on:click={() => {
						void triggerInventorySync();
					}}
					disabled={!isOnline || queueSummary.pending === 0 || syncingQueue}
				>
					{syncingQueue ? 'Syncing...' : 'Sync adjustments'}
				</button>
			</div>

			<div class="summary-row">
				<span>Pending {queueSummary.pending}</span>
				<span>Syncing {queueSummary.syncing}</span>
				<span>Synced {queueSummary.synced}</span>
				<span>Review {queueSummary.conflicts}</span>
			</div>
			<p class="message" data-testid="stock-adjust-sync-message">{queueMessage}</p>

			{#if queueRecords.length === 0}
				<p class="empty">No queued stock adjustments.</p>
			{:else}
				<ul class="list">
					{#each queueRecords as record}
						<li>
							<div>
								<strong>{record.summary}</strong>
								<span>{record.reason}</span>
							</div>
							<span>{queueStatusLabel(record.status)}</span>
						</li>
					{/each}
				</ul>
			{/if}

			<pre data-testid="stock-adjust-queue-snapshot">{queueSnapshot}</pre>
		</section>

		<section class="panel">
			<div class="panel-header">
				<div>
					<p class="section-kicker">Recent Adjustments</p>
					<h2>Movement history</h2>
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

	.stock-shell {
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
		font-size: clamp(2rem, 4vw, 3.3rem);
		line-height: 0.95;
		margin-bottom: 0.8rem;
	}

	.lead {
		max-width: 54ch;
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

	.result-card {
		padding: 0.9rem;
		border-radius: 16px;
		background: rgba(18, 73, 96, 0.06);
		display: grid;
		gap: 0.25rem;
	}

	.product-grid,
	.list {
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
	.list li {
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
	.list strong {
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

	.error {
		color: #a32d2d;
	}

	.message,
	.empty,
	.error {
		line-height: 1.5;
	}

	pre {
		margin: 0;
		font-size: 0.76rem;
		line-height: 1.4;
		overflow: auto;
	}

	@media (max-width: 980px) {
		.hero,
		.layout,
		.form-grid {
			grid-template-columns: 1fr;
		}

		.panel.wide,
		label.full {
			grid-column: span 1;
		}
	}
</style>
