<script lang="ts">
	import { onMount } from 'svelte';
	import { saveCachedSession, readCachedSession } from '$lib/client/session';
	import type { AuthLoginResponse } from '$lib/types';

	let email = 'cashier@nextpos.test';
	let password = 'Cashier#123';
	let errorMessage = '';
	let offlineHint = '';
	let submitting = false;
	let hydrated = false;

	onMount(() => {
		hydrated = true;
	});

	async function submit() {
		submitting = true;
		errorMessage = '';
		offlineHint = '';

		try {
			const response = await fetch('/api/auth/login', {
				method: 'POST',
				headers: {
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					email,
					password
				})
			});
			const payload = (await response.json()) as AuthLoginResponse | { message?: string };

			if (!response.ok || !('token' in payload)) {
				throw new Error(
					typeof payload === 'object' && payload && 'message' in payload
						? (payload.message ?? 'Login failed.')
						: 'Login failed.'
				);
			}

			saveCachedSession(payload);
			window.location.assign('/');
		} catch (error) {
			if (!navigator.onLine) {
				const cached = readCachedSession();

				if (cached && cached.user.email === email.trim().toLowerCase()) {
					offlineHint = `Cached session available for ${cached.user.name}. Reconnect to refresh the secure cookie.`;
				}
			}

			errorMessage = error instanceof Error ? error.message : 'Login failed.';
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head>
	<title>Login</title>
</svelte:head>

<div class="login-shell" data-ready={hydrated ? 'true' : 'false'}>
	<section class="login-card">
		<p class="eyebrow">Secure Access</p>
		<h1>Retail POS Login</h1>
		<p class="lead">Sign in with your role account to unlock store-scoped access.</p>

		<form
			on:submit|preventDefault={() => {
				void submit();
			}}
		>
			<label>
				<span>Email</span>
				<input bind:value={email} type="email" aria-label="Email" />
			</label>
			<label>
				<span>Password</span>
				<input bind:value={password} type="password" aria-label="Password" />
			</label>

			{#if errorMessage}
				<p class="error">{errorMessage}</p>
			{/if}

			{#if offlineHint}
				<p class="hint">{offlineHint}</p>
			{/if}

			<button type="submit" disabled={submitting} data-testid="login-submit">
				{submitting ? 'Signing in...' : 'Sign in'}
			</button>
		</form>

		<div class="accounts">
			<strong>Seeded accounts</strong>
			<span>`admin@nextpos.test` / `Admin#123`</span>
			<span>`manager@nextpos.test` / `Manager#123`</span>
			<span>`cashier@nextpos.test` / `Cashier#123`</span>
		</div>
	</section>
</div>

<style>
	:global(body) {
		margin: 0;
		font-family: 'Aptos', 'Segoe UI', sans-serif;
		background: linear-gradient(180deg, #f4efe7 0%, #e6ded2 100%);
		color: #17202a;
	}

	.login-shell {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: 1.5rem;
	}

	.login-card {
		width: min(460px, 100%);
		padding: 1.5rem;
		border-radius: 28px;
		background: rgba(255, 251, 244, 0.94);
		border: 1px solid rgba(122, 76, 16, 0.12);
		box-shadow: 0 24px 54px rgba(31, 41, 55, 0.1);
	}

	.eyebrow {
		margin: 0 0 0.5rem;
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

	h1 {
		font-size: clamp(2rem, 5vw, 3rem);
		line-height: 0.95;
		margin-bottom: 0.75rem;
	}

	.lead {
		color: #4f5d6c;
		line-height: 1.6;
		margin-bottom: 1.2rem;
	}

	form {
		display: grid;
		gap: 0.85rem;
	}

	label {
		display: grid;
		gap: 0.35rem;
		font-size: 0.92rem;
	}

	input {
		border: 1px solid rgba(23, 32, 42, 0.12);
		border-radius: 14px;
		padding: 0.9rem 1rem;
		font: inherit;
	}

	button {
		border: 0;
		border-radius: 14px;
		padding: 0.9rem 1rem;
		font: inherit;
		font-weight: 700;
		cursor: pointer;
		background: linear-gradient(135deg, #124960, #198074);
		color: #f8fbff;
	}

	button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.error {
		color: #a32d2d;
	}

	.hint {
		color: #7a4c10;
	}

	.accounts {
		margin-top: 1rem;
		display: grid;
		gap: 0.35rem;
		color: #4f5d6c;
	}
</style>
