<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { RoomSession } from '$lib/state/room.svelte';
	import { roomSecretFromCode } from '$lib/net/room';
	import NotesEditor from '$lib/notes/NotesEditor.svelte';
	import { onMount, onDestroy } from 'svelte';
	import QRCode from 'qr-code-styling';

	let session = $state<RoomSession | null>(null);
	let name = $state('');
	let joined = $state(false);
	let chatText = $state('');
	let chatOpen = $state(false);
	let notesOpen = $state(false);
	let shareOpen = $state(false);
	let handUp = $state(false);
	let whisperTo = $state('');
	let breakoutOpen = $state(false);
	let qrEl: HTMLDivElement | undefined = $state();

	const code = page.params.code ?? '';

	onMount(() => {
		const key = page.url.hash.slice(1) || undefined;
		name = sessionStorage.getItem('cic:name') ?? '';
		if (!name) return;
		begin(key);
	});

	function begin(key?: string) {
		sessionStorage.setItem('cic:name', name);
		session = new RoomSession(roomSecretFromCode(code, key), name, code);
		joined = true;
		void session.join();
	}

	onDestroy(() => session?.leave());

	function leave() {
		void session?.leave();
		goto('/');
	}

	function attachVideo(el: HTMLVideoElement, stream: MediaStream | null | undefined) {
		if (stream) el.srcObject = stream;
	}

	function shareLink(): string {
		return page.url.href;
	}

	$effect(() => {
		if (shareOpen && qrEl) {
			new QRCode({
				width: 220,
				height: 220,
				data: shareLink(),
				dotsOptions: { color: '#22323c', type: 'rounded' },
				cornersSquareOptions: { color: '#1abc9c' }
			}).append(qrEl);
		}
	});

	const MAX_SEATS = 12;
	const seats = $derived.by(() => {
		if (!session) return [];
		const ids = [session.selfId, ...session.peers];
		return Array.from({ length: MAX_SEATS }, (_, i) => ids[i] ?? null);
	});
	const latestCaption = $derived(session?.captions.at(-1));
</script>

<svelte:head><title>Circle {code} — Co-Intelligence</title></svelte:head>

{#if !joined}
	<main class="prejoin" data-theme="sand">
		<div class="card">
			<h1>Circle {code}</h1>
			<p class="hint">Take a breath. How would you like to be known in this circle?</p>
			<input bind:value={name} placeholder="Your name" maxlength="40" aria-label="Display name" />
			<button class="primary" disabled={!name.trim()} onclick={() => begin()}>Enter the circle</button>
			<p class="privacy">Camera and mic start muted. End-to-end encrypted when your browser supports it.</p>
		</div>
	</main>
{:else if session}
	<main class="room" data-theme="deep">
		<header>
			<span class="room-code">Circle {code}</span>
			<span class="badges">
				{#if session.e2eeActive}
					<span class="badge e2ee" title="SFrame end-to-end encrypted">E2EE</span>
				{:else}
					<span class="badge warn" title="Browser lacks insertable streams — media is transport-encrypted only">not E2EE</span>
				{/if}
				{#if session.recording}<span class="badge rec">REC</span>{/if}
				{#if session.miloState !== 'off'}
					<span class="badge e2ee" title="Local AI participant ({session.miloState})">Milo {session.miloState}</span>
				{/if}
				{#if session.captionsAvailable}
					<span class="badge" title="On-device captions active">CC</span>
				{/if}
				{#if session.authorityId === session.selfId}<span class="badge">host</span>{/if}
			</span>
		</header>

		<div class="circle" style:--n={MAX_SEATS}>
			<div class="center" class:active={session.stickHolderId !== null}>
				<span class="stick">🪶</span>
				{#if session.stickHolderId === null}
					<span class="label">on the table</span>
				{:else if session.stickHolderId === session.selfId}
					<span class="label">you hold the stick</span>
				{:else}
					<span class="label">{session.names[session.stickHolderId] ?? 'a member'} holds it</span>
				{/if}
			</div>

			{#each seats as occupant, i}
				<div
					class="seat"
					class:me={occupant === session.selfId}
					class:holder={occupant !== null && occupant === session.stickHolderId}
					class:empty={occupant === null}
					style:--i={i}
				>
					{#if occupant === session.selfId && session.localMedia}
						<video
							autoplay muted playsinline
							use:attachVideo={session.localMedia.stream}
							class="vid"
						></video>
					{:else if occupant && session.remoteStreams[occupant]}
						<video autoplay playsinline use:attachVideo={session.remoteStreams[occupant]} class="vid"></video>
					{:else if occupant}
						<div class="avatar">{(session.names[occupant] ?? '?').slice(0, 1).toUpperCase()}</div>
					{:else}
						<div class="avatar empty"></div>
					{/if}
					{#if occupant && session.raisedHands.has(occupant)}<span class="hand">✋</span>{/if}
				</div>
			{/each}
		</div>

		{#if session.breakout}
			<div class="breakout-banner">
				In breakout — {session.breakout.peers.length + 1} here
				<button class="ctl accent" onclick={() => session?.returnFromBreakout()}>Return to circle</button>
			</div>
		{/if}

		{#if session.consentAsked}
			<div class="breakout-banner consent" role="dialog" aria-label="Recording consent">
				This circle wants to record. Do you consent?
				<button class="ctl accent" onclick={() => session?.answerConsent(true)}>Consent</button>
				<button class="ctl danger" onclick={() => session?.answerConsent(false)}>No</button>
			</div>
		{/if}

		{#if session.pendingBreakout}
			<div class="breakout-banner">
				Host invited you to breakout <strong>{session.pendingBreakout}</strong>
				<button class="ctl accent" onclick={() => { if (session?.pendingBreakout) void session.joinBreakout(session.pendingBreakout); }}>Join</button>
				<button class="ctl" onclick={() => { if (session) session.pendingBreakout = null; }}>Stay</button>
			</div>
		{/if}

		{#if latestCaption}
			<div class="caption" aria-live="polite">{latestCaption.text}</div>
		{/if}

		<footer class="controls">
			<button
				class="ctl"
				class:off={session.selfMuted}
				onclick={() => session?.setSelfMuted(!session.selfMuted)}
				aria-pressed={session.selfMuted}
			>
				{session.selfMuted ? 'Unmute' : 'Mute'}
			</button>
			<button class="ctl accent" onclick={() => session?.requestStick()}>Take the stick</button>
			<button class="ctl" onclick={() => session?.passStick()}>Pass</button>
			<button
				class="ctl"
				class:off={handUp}
				onclick={() => { handUp = !handUp; session?.raiseHand(handUp); }}
			>
				✋
			</button>
			<button class="ctl" onclick={() => (chatOpen = !chatOpen)}>Chat</button>
			<button class="ctl" onclick={() => (notesOpen = !notesOpen)}>Notes</button>
			<button class="ctl" onclick={() => (shareOpen = !shareOpen)}>Invite</button>
			{#if session.authorityId === session.selfId}
				<button class="ctl" onclick={() => (session?.recording ? session.stopRecording() : session?.startRecording())}>
					{session.recording ? 'Stop REC' : 'Record'}
				</button>
				<button class="ctl danger" onclick={() => session?.endRoom()}>End circle</button>
			{/if}
			<button class="ctl danger" onclick={leave}>Leave</button>
		</footer>

		{#if shareOpen}
			<div class="share" role="dialog" aria-label="Invite to circle">
				<div bind:this={qrEl} class="qr"></div>
				<p class="share-link">{shareLink()}</p>
				<button class="ctl" onclick={() => navigator.clipboard.writeText(shareLink())}>Copy link</button>
				<p class="hint">The link carries the room key in its #fragment — it never touches any server.</p>
			</div>
		{/if}

		{#if notesOpen}
			<aside class="notes">
				<header class="notes-head">Circle notes</header>
				<NotesEditor notes={session.notes} />
			</aside>
		{/if}

		{#if breakoutOpen && session.authorityId === session.selfId}
			<aside class="panel">
				<header class="notes-head">Breakout rooms</header>
				<div class="panel-body">
					{#if session.breakoutCount === 0}
						<button class="ctl accent" onclick={() => session?.openBreakouts(3)}>Open 3 breakouts</button>
					{:else}
						<p>{session.breakoutCount} breakout circles open</p>
						{#each session.peers as p}
							<div class="assign-row">
								<span>{session.names[p] ?? 'peer'}</span>
								{#each Array.from({ length: session.breakoutCount }, (_, i) => i + 1) as n}
									<button class="ctl" onclick={() => session?.assignBreakout(p, String(n))}>{n}</button>
								{/each}
							</div>
						{/each}
						<button class="ctl danger" onclick={() => session?.closeBreakouts()}>Close all</button>
					{/if}
				</div>
			</aside>
		{/if}

		{#if chatOpen}
			<aside class="chat">
				<div class="log">
					{#each session.chatLog as line}
						<p>
							<strong>{line.from === session.selfId ? 'You' : (session.names[line.from] ?? 'Peer')}</strong
							>{line.whisper ? ' (whisper)' : ''}: {line.text}
						</p>
					{/each}
				</div>
				<form
					onsubmit={(e) => {
						e.preventDefault();
						if (chatText.trim()) session?.sendChat(chatText.trim(), whisperTo || undefined);
						chatText = '';
					}}
				>
					<select bind:value={whisperTo} aria-label="Chat target">
						<option value="">everyone</option>
						{#each session.peers as p}
							<option value={p}>whisper → {session.names[p] ?? 'peer'}</option>
						{/each}
					</select>
					<input bind:value={chatText} placeholder="Whisper to the circle…" />
				</form>
			</aside>
		{/if}
	</main>
{/if}

<style>
	.prejoin {
		min-height: 100dvh;
		display: grid;
		place-items: center;
		background: var(--bg);
	}
	.prejoin .card {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		box-shadow: var(--shadow-md);
		padding: 2.5rem;
		width: min(24rem, 90vw);
		text-align: center;
	}
	.prejoin h1 {
		font-family: var(--font-serif);
		font-weight: 400;
	}
	.hint {
		color: var(--ink-soft);
	}
	.prejoin input {
		width: 100%;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		padding: 0.75rem 1rem;
		margin-bottom: 1rem;
		font: inherit;
		background: var(--bg);
		color: var(--ink);
		box-sizing: border-box;
	}
	.primary {
		background: var(--accent-strong);
		color: #fff;
		border: 0;
		border-radius: var(--radius-sm);
		padding: 0.75rem 1.5rem;
		font-weight: 600;
		width: 100%;
	}
	.primary:disabled {
		opacity: 0.5;
	}
	.privacy {
		font-size: 0.8rem;
		color: var(--ink-soft);
	}

	.room {
		height: 100dvh;
		display: grid;
		grid-template-rows: auto 1fr auto;
		background: var(--bg);
	}
	header {
		display: flex;
		justify-content: space-between;
		padding: 0.75rem 1.25rem;
		color: var(--ink-soft);
		font-size: 0.85rem;
	}
	.badges {
		display: flex;
		gap: 0.5rem;
	}
	.badge {
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 0.15rem 0.6rem;
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.05em;
	}
	.badge.e2ee {
		color: var(--accent);
		border-color: var(--accent-strong);
	}
	.badge.warn {
		color: var(--credit-warning);
		border-color: var(--credit-warning);
	}
	.badge.rec {
		color: var(--danger);
		border-color: var(--danger);
	}

	.circle {
		place-self: center;
		position: relative;
		width: min(70vmin, 34rem);
		aspect-ratio: 1;
	}
	.center {
		position: absolute;
		inset: 32%;
		border-radius: 50%;
		display: grid;
		place-items: center;
		align-content: center;
		gap: 0.25rem;
		background: var(--surface);
		border: 1px solid var(--line);
		transition: border-color 0.4s var(--ease-out);
	}
	.center.active {
		border-color: var(--accent-strong);
		box-shadow: 0 0 40px var(--accent-mist);
	}
	.stick {
		font-size: 2rem;
	}
	.label {
		font-size: 0.75rem;
		color: var(--ink-soft);
	}

	.seat {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 5.5rem;
		height: 5.5rem;
		margin: -2.75rem;
		transform: rotate(calc(var(--i) * (360deg / var(--n)))) translateY(calc(min(35vmin, 17rem) * -1));
	}
	.avatar,
	.vid {
		width: 100%;
		height: 100%;
		border-radius: 50%;
		display: grid;
		place-items: center;
		background: var(--surface);
		border: 2px solid var(--line);
		font-weight: 700;
		font-size: 1.5rem;
		object-fit: cover;
		transition: border-color 0.3s;
	}
	.vid {
		transform: rotate(calc(var(--i) * (360deg / var(--n)) * -1));
	}
	.avatar.empty {
		opacity: 0.25;
		border-style: dashed;
	}
	.seat.holder .avatar,
	.seat.holder .vid {
		border-color: var(--accent-strong);
		box-shadow: 0 0 24px var(--accent-soft);
	}
	.seat.me .avatar,
	.seat.me .vid {
		border-color: var(--ink-soft);
	}
	.hand {
		position: absolute;
		top: -0.5rem;
		right: -0.25rem;
		font-size: 1.1rem;
	}

	.caption {
		position: fixed;
		bottom: 5.5rem;
		left: 50%;
		transform: translateX(-50%);
		background: var(--bg-deep);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		padding: 0.4rem 1rem;
		font-size: 1.05rem;
		max-width: 80vw;
		text-align: center;
	}

	.controls {
		display: flex;
		justify-content: center;
		gap: 0.5rem;
		padding: 1rem;
		flex-wrap: wrap;
	}
	.ctl {
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--ink);
		border-radius: 999px;
		padding: 0.6rem 1.1rem;
		font-weight: 600;
		font-size: 0.9rem;
	}
	.ctl.accent {
		background: var(--accent-strong);
		border-color: var(--accent-strong);
		color: #fff;
	}
	.ctl.danger {
		color: var(--danger);
	}
	.ctl.off {
		background: var(--danger);
		color: #fff;
		border-color: var(--danger);
	}

	.chat {
		position: fixed;
		right: 0;
		top: 0;
		bottom: 0;
		width: min(20rem, 85vw);
		background: var(--surface);
		border-left: 1px solid var(--line);
		display: grid;
		grid-template-rows: 1fr auto;
	}
	.chat .log {
		overflow-y: auto;
		padding: 1rem;
		font-size: 0.9rem;
	}
	.chat form {
		padding: 0.75rem;
		border-top: 1px solid var(--line);
	}
	.chat input {
		width: 100%;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--bg);
		color: var(--ink);
		padding: 0.6rem 0.9rem;
		font: inherit;
		box-sizing: border-box;
	}

	.notes {
		position: fixed;
		left: 0;
		top: 0;
		bottom: 0;
		width: min(22rem, 85vw);
		background: var(--surface);
		border-right: 1px solid var(--line);
		display: grid;
		grid-template-rows: auto 1fr;
	}
	.notes-head {
		padding: 0.9rem 1rem;
		border-bottom: 1px solid var(--line);
		font-family: var(--font-serif);
		font-size: 1.1rem;
	}

	.share {
		position: fixed;
		inset: 0;
		display: grid;
		place-content: center;
		gap: 1rem;
		justify-items: center;
		background: color-mix(in srgb, var(--bg-deep), transparent 30%);
		backdrop-filter: blur(8px);
		z-index: 20;
	}
	.share > * {
		max-width: 22rem;
	}
	.qr {
		background: #fff;
		padding: 1rem;
		border-radius: var(--radius);
	}
	.share-link {
		font-size: 0.75rem;
		color: var(--ink-soft);
		word-break: break-all;
		background: var(--surface);
		padding: 0.6rem;
		border-radius: var(--radius-sm);
	}

	.breakout-banner {
		position: fixed;
		top: 3rem;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 0.75rem;
		background: var(--surface);
		border: 1px solid var(--accent);
		border-radius: 999px;
		padding: 0.5rem 1rem;
		font-size: 0.9rem;
		z-index: 15;
	}
	.panel {
		position: fixed;
		right: 0;
		top: 0;
		bottom: 0;
		width: min(20rem, 85vw);
		background: var(--surface);
		border-left: 1px solid var(--line);
		z-index: 12;
	}
	.panel-body {
		padding: 1rem;
		display: grid;
		gap: 0.75rem;
	}
	.assign-row {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
	}
	.chat form {
		display: grid;
		grid-template-rows: auto auto;
		gap: 0.4rem;
	}
	.chat select {
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--bg);
		color: var(--ink);
		padding: 0.4rem;
		font: inherit;
		font-size: 0.8rem;
	}
</style>
