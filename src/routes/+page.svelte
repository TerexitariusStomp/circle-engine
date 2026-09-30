<script lang="ts">
	import { goto } from '$app/navigation';

	let code = $state('');

	function newCircle() {
		const c = Math.floor(100000 + Math.random() * 900000).toString();
		goto(`/room/${c}#${crypto.randomUUID()}`);
	}

	function join() {
		const c = code.replace(/\D/g, '').slice(0, 6);
		if (c.length === 6) goto(`/room/${c}`);
	}
</script>

<svelte:head><title>Co-Intelligence Circle</title></svelte:head>

<main class="entry">
	<div class="card">
		<h1>Co-Intelligence Circle</h1>
		<p class="tagline">Find coherence through human connection.</p>

		<button class="primary" onclick={newCircle}>Open a circle</button>

		<div class="divider"><span>or join one</span></div>

		<form onsubmit={(e) => { e.preventDefault(); join(); }}>
			<input
				bind:value={code}
				inputmode="numeric"
				placeholder="6-digit room code"
				maxlength="6"
				aria-label="Room code"
			/>
			<button class="secondary" type="submit" disabled={code.replace(/\D/g, '').length !== 6}>
				Join
			</button>
		</form>

		<p class="privacy">Runs entirely on your devices. No account. No server sees your words.</p>
	</div>
</main>

<style>
	.entry {
		min-height: 100dvh;
		display: grid;
		place-items: center;
		background: var(--bg);
		padding: 1rem;
	}
	.card {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		box-shadow: var(--shadow-md);
		padding: 2.5rem;
		width: min(24rem, 100%);
		text-align: center;
	}
	h1 {
		font-family: var(--font-serif);
		font-size: 2rem;
		font-weight: 400;
		margin: 0 0 0.25rem;
	}
	.tagline {
		color: var(--ink-soft);
		margin: 0 0 2rem;
	}
	.primary,
	.secondary {
		border: 0;
		border-radius: var(--radius-sm);
		padding: 0.75rem 1.5rem;
		font-weight: 600;
	}
	.primary {
		background: var(--accent-strong);
		color: #fff;
		width: 100%;
	}
	.secondary {
		background: var(--accent-soft);
		color: var(--accent-ink);
	}
	.divider {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		color: var(--ink-soft);
		font-size: 0.85rem;
		margin: 1.5rem 0;
	}
	.divider::before,
	.divider::after {
		content: '';
		flex: 1;
		border-top: 1px solid var(--line);
	}
	form {
		display: flex;
		gap: 0.5rem;
	}
	input {
		flex: 1;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--bg);
		color: var(--ink);
		padding: 0.75rem 1rem;
		font: inherit;
		letter-spacing: 0.15em;
		text-align: center;
	}
	.privacy {
		margin-top: 2rem;
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
</style>
