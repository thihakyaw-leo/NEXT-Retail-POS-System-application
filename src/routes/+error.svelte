<script lang="ts">
	export let error: App.Error;
	export let status: number;
</script>

<svelte:head>
	<title>{status}</title>
</svelte:head>

<div class="error-shell">
	<div class="error-card">
		<p class="eyebrow">Request blocked</p>
		<h1>{status}</h1>
		<p>{error?.message ?? 'Unexpected error.'}</p>
		<a href="/">Return to POS</a>
	</div>
</div>

<style>
	:global(body) {
		margin: 0;
		font-family: 'Aptos', 'Segoe UI', sans-serif;
		background: linear-gradient(180deg, #f4efe7 0%, #e6ded2 100%);
		color: #17202a;
	}

	.error-shell {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: 1.5rem;
	}

	.error-card {
		width: min(440px, 100%);
		padding: 1.5rem;
		border-radius: 28px;
		background: rgba(255, 251, 244, 0.94);
		border: 1px solid rgba(122, 76, 16, 0.12);
		box-shadow: 0 24px 54px rgba(31, 41, 55, 0.1);
		display: grid;
		gap: 0.75rem;
	}

	.eyebrow {
		margin: 0;
		font-size: 0.76rem;
		font-weight: 700;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: #7a4c10;
	}

	h1,
	p {
		margin: 0;
	}

	a {
		color: #124960;
		font-weight: 700;
		text-decoration: none;
	}
</style>
