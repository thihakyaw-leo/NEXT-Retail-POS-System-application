<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import type { ProductSummary, StoreSummary, TransferResponse, TransferSummary } from '$lib/types';
	import type { PageData } from './$types';

	export let data: PageData;

	let selectedProductId = data.products[0]?.id ?? '';
	let destinationStoreId =
		data.stores.find((store) => store.id !== data.selectedStoreId)?.id ?? data.selectedStoreId;
	let quantityInput = '3';
	let noteInput = '';
	let transfers: TransferSummary[] = data.transfers;
	let creating = false;
	let approvingTransferId = '';
	let message = '';
	let hydrated = false;

	onMount(() => {
		hydrated = true;
	});

	function switchStore(storeId: string) {
		goto(`/transfers?storeId=${encodeURIComponent(storeId)}`);
	}

	async function createTransferRequest() {
		creating = true;
		message = '';

		try {
			const response = await fetch('/api/transfers', {
				method: 'POST',
				headers: {
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					fromStoreId: data.selectedStoreId,
					toStoreId: destinationStoreId,
					note: noteInput,
					items: [
						{
							productId: selectedProductId,
							quantity: Number.parseInt(quantityInput, 10)
						}
					]
				})
			});
			const payload = (await response.json()) as TransferResponse | { message?: string };

			if (!response.ok || !('transfer' in payload)) {
				throw new Error(
					typeof payload === 'object' && payload && 'message' in payload
						? (payload.message ?? 'Transfer request failed.')
						: 'Transfer request failed.'
				);
			}

			transfers = [payload.transfer, ...transfers];
			message = `Transfer ${payload.transfer.transferNumber} created.`;
		} catch (error) {
			message = error instanceof Error ? error.message : 'Transfer request failed.';
		} finally {
			creating = false;
		}
	}

	async function approve(id: string) {
		approvingTransferId = id;
		message = '';

		try {
			const response = await fetch(`/api/transfers/${id}/approve`, {
				method: 'PUT'
			});
			const payload = (await response.json()) as TransferResponse | { message?: string };

			if (!response.ok || !('transfer' in payload)) {
				throw new Error(
					typeof payload === 'object' && payload && 'message' in payload
						? (payload.message ?? 'Transfer approval failed.')
						: 'Transfer approval failed.'
				);
			}

			transfers = transfers.map((transfer) =>
				transfer.id === id ? payload.transfer : transfer
			);
			message = `Transfer ${payload.transfer.transferNumber} approved.`;
		} catch (error) {
			message = error instanceof Error ? error.message : 'Transfer approval failed.';
		} finally {
			approvingTransferId = '';
		}
	}
</script>

<svelte:head>
	<title>Transfers</title>
</svelte:head>

<div class="shell" data-ready={hydrated ? 'true' : 'false'}>
	<header class="hero">
		<div>
			<p class="eyebrow">Inter-store Transfers</p>
			<h1>Move stock across stores with approval</h1>
			<p class="lead">
				Store managers can request transfers. Admins can approve them and move inventory between
				store-scoped stock pools.
			</p>
			<nav class="nav">
				<a href="/">POS</a>
				<a href="/inventory">Inventory</a>
				<a href="/inventory/stock-take">Stock Take</a>
				<a href="/transfers" aria-current="page">Transfers</a>
			</nav>
		</div>
		<div class="status-card">
			<span>{data.user.name}</span>
			<span>{data.user.role}</span>
			{#if data.sourceStores.length > 1}
				<label>
					<span>Store switcher</span>
					<select aria-label="Store switcher" value={data.selectedStoreId} on:change={(event) => switchStore((event.currentTarget as HTMLSelectElement).value)}>
						{#each data.sourceStores as store}
							<option value={store.id}>{store.name}</option>
						{/each}
					</select>
				</label>
			{/if}
		</div>
	</header>

	<div class="layout">
		<section class="panel" data-testid="transfer-form-panel">
			<p class="section-kicker">Request Transfer</p>
			<h2>Create a new request</h2>

			<label>
				<span>Product</span>
				<select bind:value={selectedProductId} aria-label="Transfer product">
					{#each data.products as product}
						<option value={product.id}>{product.name} ({product.stockQuantity} on hand)</option>
					{/each}
				</select>
			</label>
				<label>
					<span>Destination store</span>
					<select bind:value={destinationStoreId} aria-label="Destination store">
						{#each data.stores.filter((store) => store.id !== data.selectedStoreId) as store}
							<option value={store.id}>{store.name}</option>
						{/each}
					</select>
			</label>
			<label>
				<span>Quantity</span>
				<input bind:value={quantityInput} inputmode="numeric" aria-label="Transfer quantity" />
			</label>
			<label>
				<span>Note</span>
				<input bind:value={noteInput} aria-label="Transfer note" />
			</label>

			<button type="button" on:click={() => void createTransferRequest()} disabled={creating} data-testid="transfer-submit">
				{creating ? 'Creating...' : 'Create transfer request'}
			</button>

			{#if message}
				<p class="message">{message}</p>
			{/if}
		</section>

		<section class="panel wide" data-testid="transfer-list-panel">
			<p class="section-kicker">Transfer Flow</p>
			<h2>Pending and approved requests</h2>

			<ul class="transfer-list">
				{#each transfers as transfer}
					<li data-testid={`transfer-${transfer.id}`}>
						<div>
							<strong data-testid={`transfer-number-${transfer.id}`}>{transfer.transferNumber}</strong>
							<span>{transfer.fromStoreName} → {transfer.toStoreName}</span>
							<span>{transfer.items.map((item) => `${item.productName} x${item.quantity}`).join(', ')}</span>
						</div>
						<div class="transfer-actions">
							<span>{transfer.status}</span>
							{#if data.user.role === 'admin' && transfer.status === 'requested'}
								<button type="button" on:click={() => void approve(transfer.id)} disabled={approvingTransferId === transfer.id} data-testid={`approve-transfer-${transfer.id}`}>
									{approvingTransferId === transfer.id ? 'Approving...' : 'Approve'}
								</button>
							{/if}
						</div>
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
		background: linear-gradient(180deg, #f4efe7 0%, #e8e0d4 100%);
		color: #17202a;
	}

	.shell {
		max-width: 1280px;
		margin: 0 auto;
		padding: 2rem 1.25rem 3rem;
	}

	.hero {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 280px;
		gap: 1rem;
		margin-bottom: 1rem;
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
		max-width: 56ch;
		line-height: 1.6;
		color: #4f5d6c;
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
		background: rgba(255, 251, 244, 0.94);
		border: 1px solid rgba(122, 76, 16, 0.12);
		border-radius: 24px;
		box-shadow: 0 20px 48px rgba(31, 41, 55, 0.08);
	}

	.status-card {
		padding: 1rem;
		display: grid;
		gap: 0.45rem;
	}

	.status-card select,
	input,
	button {
		font: inherit;
	}

	.layout {
		display: grid;
		grid-template-columns: minmax(320px, 0.8fr) minmax(0, 1.2fr);
		gap: 1rem;
	}

	.panel {
		padding: 1.2rem;
		display: grid;
		gap: 0.85rem;
	}

	.panel.wide {
		grid-column: span 1;
	}

	label {
		display: grid;
		gap: 0.35rem;
	}

	select,
	input {
		border: 1px solid rgba(23, 32, 42, 0.12);
		border-radius: 14px;
		padding: 0.8rem 0.9rem;
		background: rgba(255, 255, 255, 0.85);
	}

	button {
		border: 0;
		border-radius: 14px;
		padding: 0.85rem 1rem;
		font-weight: 700;
		cursor: pointer;
		background: linear-gradient(135deg, #124960, #198074);
		color: #f8fbff;
	}

	button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.transfer-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 0.85rem;
	}

	.transfer-list li {
		padding: 0.95rem;
		border-radius: 18px;
		border: 1px solid rgba(23, 32, 42, 0.08);
		background: rgba(255, 255, 255, 0.84);
		display: flex;
		justify-content: space-between;
		gap: 1rem;
	}

	.transfer-list strong,
	.transfer-list span {
		display: block;
	}

	.transfer-actions {
		display: grid;
		gap: 0.5rem;
		justify-items: end;
	}

	.message {
		color: #0a4d68;
	}

	@media (max-width: 960px) {
		.hero,
		.layout {
			grid-template-columns: 1fr;
		}
	}
</style>
