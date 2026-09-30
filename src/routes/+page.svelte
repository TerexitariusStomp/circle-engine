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

<svelte:head><title>Co-Intelligence Circle — Find coherence through human connection</title></svelte:head>

<main class="ea ea-light">
	<!-- hero — mirrors the deployed ea-hero: atmosphere blobs + grain, header, status pill -->
	<section class="ea-hero">
		<div class="ea-atmo" aria-hidden="true">
			<span class="ea-blob ea-b1"></span>
			<span class="ea-blob ea-b2"></span>
			<span class="ea-blob ea-b3"></span>
			<span class="ea-grain"></span>
		</div>

		<header class="ea-header">
			<div class="ea-shell ea-header-in">
				<a class="ea-brand" href="/">
					<img src="/brand/logo.svg" alt="" width="28" height="28" />
					<span>Co-Intelligence Circle</span>
				</a>
				<nav class="ea-nav">
					<a href="#circle">The circle</a>
					<a href="#faq">FAQ</a>
				</nav>
				<div class="ea-header-actions">
					<button class="ea-btn ea-btn-dark" onclick={newCircle}>Open a circle</button>
				</div>
			</div>
		</header>

		<div class="ea-hero-in ea-shell">
			<p class="ea-status"><i aria-hidden="true"></i>No account · no server · end-to-end encrypted</p>
			<h1>
				<span class="ea-h1a">Help your group</span>
				<span class="ea-h1b">find coherence.</span>
			</h1>
			<p class="ea-lead">
				Bring what you know, feel, and sense into the circle. Individual intelligence meets the
				group's collective intelligence to create co-intelligence, with deep listening and trust
				making room for higher wisdom to emerge.
			</p>

			<div class="ea-request">
				<form class="ea-form" onsubmit={(e) => { e.preventDefault(); join(); }}>
					<div class="ea-capsule">
						<label class="sr-only" for="room-code">6-digit room code</label>
						<input
							id="room-code"
							bind:value={code}
							inputmode="numeric"
							placeholder="6-digit circle code"
							maxlength="6"
							aria-label="Room code"
						/>
						<button class="ea-btn" type="submit" disabled={code.replace(/\D/g, '').length !== 6}>
							Join circle
						</button>
					</div>
					<p class="ea-fine">
						Circles run entirely on the participants' devices — peer to peer, encrypted.
						Share the code and the link's key fragment; no server ever sees your words.
					</p>
				</form>
			</div>
		</div>
	</section>

	<!-- benefits — real copy + real icons from the deployed landing -->
	<section class="ea-benefits ea-shell" id="circle">
		<div class="ea-section-head">
			<p class="ea-eyebrow">Your people, in one circle</p>
			<h2>Stay present with the person speaking.</h2>
			<p>See everyone around a shared center and follow whose turn it is. Give your attention to the person speaking.</p>
		</div>
		<div class="ea-section-head">
			<p class="ea-eyebrow">What you discover together</p>
			<h2>Hear each person. Build coherence.</h2>
		</div>
		<div class="ea-benefit-grid">
			<article class="ea-benefit">
				<span class="ea-benefit-icon ea-tint-blue">
					<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
						<circle cx="12" cy="12" r="7" stroke="currentColor" stroke-opacity=".35"></circle>
						<g class="ea-ic-ring" fill="currentColor">
							<circle cx="12" cy="5" r="2.1"></circle><circle cx="18.7" cy="9.8" r="2.1"></circle>
							<circle cx="16.1" cy="17.7" r="2.1"></circle><circle cx="7.9" cy="17.7" r="2.1"></circle>
							<circle cx="5.3" cy="9.8" r="2.1"></circle>
						</g>
						<circle cx="12" cy="12" r="1.6" fill="#c49a72"></circle>
					</svg>
				</span>
				<h3>Give every voice room.</h3>
				<p>Let each person finish their thought. Hear different perspectives and understand what each person brings.</p>
			</article>
			<article class="ea-benefit">
				<span class="ea-benefit-icon ea-tint-sky">
					<svg viewBox="0 0 14 40" class="ea-ic-stick" aria-hidden="true">
						<path d="M5.1 6.5h3.8l-.5 30a1.4 1.4 0 0 1-2.8 0Z" fill="currentColor"></path>
						<rect x="3.4" y="13" rx="0.95" fill="currentColor" opacity="0.45"></rect>
						<rect x="3.6" y="27" rx="0.95" fill="currentColor" opacity="0.45"></rect>
						<circle cx="7" cy="4.4" r="3.4" fill="currentColor"></circle>
					</svg>
				</span>
				<h3>Build trust, one round at a time.</h3>
				<p>A turn for everyone gives quieter voices space. Work through tensions together and find a next step your group understands.</p>
			</article>
			<article class="ea-benefit">
				<span class="ea-benefit-icon ea-tint-sage">
					<svg viewBox="0 0 24 24" class="ea-ic-spark" aria-hidden="true">
						<path d="M12 3c.8 4.6 3.4 7.2 8 8-4.6.8-7.2 3.4-8 8-.8-4.6-3.4-7.2-8-8 4.6-.8 7.2-3.4 8-8Z" fill="currentColor"></path>
						<circle cx="19" cy="4.5" r="1.4" fill="currentColor" opacity=".5"></circle>
					</svg>
				</span>
				<h3>Give decisions a shared foundation.</h3>
				<p>Shared understanding can save time in later collaboration and help your group work with trust and peace of mind.</p>
			</article>
		</div>
	</section>

	<!-- invite → adapted: no request queue, the circle is yours to open -->
	<section class="ea-invite ea-shell">
		<div class="ea-invite-copy">
			<p class="ea-eyebrow">Start a circle</p>
			<h2>What could your group understand together?</h2>
			<p>
				Bring your people into a circle. Give each voice time, listen deeply, and discover what
				takes shape between you. Every circle is hosted by its participants — nothing is stored
				or routed through us.
			</p>
			<button class="ea-btn" onclick={newCircle}>Open a circle</button>
		</div>
		<div>
			<ol class="ea-steps">
				<li>
					<span class="ea-step-n">1</span>
					<div><strong>Open</strong><p>Create a circle — you get a 6-digit code and a link that carries the encryption key.</p></div>
				</li>
				<li>
					<span class="ea-step-n">2</span>
					<div><strong>Invite</strong><p>Share the link or code with your people. They join straight from their browser.</p></div>
				</li>
				<li>
					<span class="ea-step-n">3</span>
					<div><strong>Gather</strong><p>Take your seats around the fire. The talking stick gives every voice its turn.</p></div>
				</li>
			</ol>
		</div>
	</section>

	<!-- faq — adapted to this zero-server product -->
	<section class="ea-faq ea-shell" id="faq">
		<div class="ea-faq-head">
			<p class="ea-eyebrow">FAQ</p>
			<h2>Questions</h2>
		</div>
		<details class="ea-q">
			<summary>Do I need an account?</summary>
			<p>No. There is nothing to sign up for. Open a circle, share the code, and you're in — peers connect directly to each other.</p>
		</details>
		<details class="ea-q">
			<summary>Where does our conversation go?</summary>
			<p>Nowhere. Audio and video travel end-to-end encrypted between participants' browsers. Transcripts, notes and recordings stay on your devices unless you choose to share them.</p>
		</details>
		<details class="ea-q">
			<summary>Is Milo a person?</summary>
			<p>Milo is an AI participant that runs on one of the devices in the circle — elected as the most capable. It only hears what's spoken while it holds attention, and it speaks only when addressed.</p>
		</details>
		<details class="ea-q">
			<summary>How do my guests join?</summary>
			<p>Share the room link or the 6-digit code. The link's fragment carries the room key — it never touches a server, so keep it in your invite channel.</p>
		</details>
	</section>

	<footer class="ea-footer ea-shell">
		<span>Co-Intelligence Circle</span>
		<span class="ea-footer-note">Runs entirely on your devices. No account. No server sees your words.</span>
	</footer>
</main>

<style>
	/* Landing surface — values lifted from the deployed marketing bundle
	   (ea-light palette, atmo blobs, capsule, pill buttons). */
	.ea {
		--ea-ink: #0d0d0d;
		--ea-soft: #5d5d5d;
		--ea-mute: #8f8f8f;
		--ea-mute-text: #6e6e6e; /* production uses #8f8f8f at 13.5px = 3.07:1 (AA fail); bumped to >=4.5:1 */
		--ea-line: #e5e5e5;
		--ea-line-strong: #d4d4d4;
		--ea-fill: #f7f7f7;
		--atmo-base: #faf9f6;
		--atmo-1: #f2dac3;
		--atmo-2: #c3daf2;
		--atmo-3: #dfece6;
		--atmo-grain: 0.3;
		font-family: var(--font-entry);
		color: var(--ea-ink);
		background: var(--atmo-base);
	}
	.ea-shell {
		width: min(1120px, 100% - 48px);
		margin-inline: auto;
	}
	.sr-only {
		position: absolute;
		width: 1px; height: 1px;
		overflow: hidden; clip-path: inset(50%);
		white-space: nowrap;
	}

	/* atmosphere */
	.ea-hero {
		isolation: isolate;
		display: grid;
		grid-template-rows: auto 1fr;
		min-height: 100svh;
		position: relative;
		overflow: hidden;
	}
	.ea-atmo {
		position: absolute; inset: 0;
		z-index: -1;
		background: var(--atmo-base);
		pointer-events: none;
		overflow: hidden;
		-webkit-mask-image: linear-gradient(#000 58%, #0000 100%);
		mask-image: linear-gradient(#000 58%, #0000 100%);
	}
	.ea-blob {
		position: absolute;
		border-radius: 50%;
		aspect-ratio: 1;
		filter: blur(90px);
		will-change: transform;
	}
	.ea-b1 { background: var(--atmo-1); width: 62vw; bottom: -30vw; left: -18vw; animation: 19s ease-in-out infinite ea-drift-a; }
	.ea-b2 { background: var(--atmo-2); width: 58vw; top: -12vw; right: -16vw; animation: 21s ease-in-out infinite ea-drift-b; }
	.ea-b3 { background: var(--atmo-3); width: 40vw; top: 34%; left: 34vw; opacity: 0.8; animation: 15s ease-in-out infinite ea-drift-c; }
	.ea-grain {
		position: absolute; inset: 0;
		opacity: var(--atmo-grain);
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 .55 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
	}
	@keyframes ea-drift-a { 0%,100% { transform: translate(0) scale(1); } 30% { transform: translate(12vw,-7vw) scale(1.1); } 62% { transform: translate(4vw,-13vw) scale(.94); } }
	@keyframes ea-drift-b { 0%,100% { transform: translate(0) scale(1); } 35% { transform: translate(-11vw,9vw) scale(.92); } 70% { transform: translate(-3vw,15vw) scale(1.08); } }
	@keyframes ea-drift-c { 0%,100% { transform: translate(0) scale(1); } 25% { transform: translate(-14vw,-5vw) scale(1.14); } 55% { transform: translate(-6vw,8vw) scale(.9); } 80% { transform: translate(9vw,3vw) scale(1.05); } }
	@media (prefers-reduced-motion: reduce) { .ea-blob { animation: none; } }

	/* header */
	.ea-header-in {
		display: flex;
		align-items: center;
		gap: 24px;
		padding: 20px 0;
	}
	.ea-brand {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		font-weight: 600;
		font-size: 16px;
		color: var(--ea-ink);
		text-decoration: none;
		letter-spacing: -0.01em;
	}
	.ea-nav { display: flex; gap: 22px; margin-left: 12px; }
	.ea-nav a { color: var(--ea-soft); text-decoration: none; font-size: 15px; }
	.ea-nav a:hover { color: var(--ea-ink); }
	.ea-header-actions { margin-left: auto; }

	/* hero copy */
	.ea-hero-in {
		display: grid;
		justify-items: center;
		align-self: center;
		text-align: center;
		padding: 48px 0 96px;
	}
	.ea-status {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		margin: 0 0 28px;
		padding: 6px 14px;
		border: 1px solid var(--ea-line);
		border-radius: 999px;
		background: #ffffffbf;
		color: var(--ea-mute-text);
		font-size: 13.5px;
		font-weight: 450;
	}
	.ea-status i {
		width: 7px; height: 7px;
		border-radius: 50%;
		background: var(--accent);
	}
	.ea h1 {
		display: grid;
		margin: 0;
		font-size: clamp(40px, 6vw, 72px);
		font-weight: 500;
		line-height: 1.04;
		letter-spacing: -0.035em;
	}
	.ea-h1b { color: var(--ea-mute); }
	.ea-lead {
		max-width: 32em;
		margin: 24px 0 0;
		color: var(--ea-soft);
		font-size: clamp(17px, 1.4vw, 18px);
		line-height: 1.6;
	}

	/* buttons — pill, ink fill, arrow cue */
	.ea-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		min-height: 48px;
		padding: 0 22px;
		border: 0;
		border-radius: 999px;
		background: var(--ea-ink);
		color: #fff;
		font: inherit;
		font-size: 15px;
		font-weight: 500;
		text-decoration: none;
		white-space: nowrap;
		cursor: pointer;
		transition: background-color 0.2s, transform 0.3s cubic-bezier(0.2, 0.7, 0.3, 1), box-shadow 0.3s;
	}
	.ea-btn::after { content: '→'; display: inline-block; }
	.ea-btn:hover:not(:disabled) {
		background: #333;
		transform: translateY(-2px);
		box-shadow: 0 10px 22px -10px #0d0d0d80, 0 0 0 4px #5d7fa624;
	}
	.ea-btn:active:not(:disabled) { transform: translateY(0) scale(0.97); box-shadow: none; }
	.ea-btn:disabled { background: #555; cursor: progress; }
	.ea-btn:disabled::after { content: none; }
	.ea-btn-dark { min-height: 40px; padding: 0 18px; font-size: 14px; }

	/* capsule join form */
	.ea-request { margin-top: 40px; width: min(560px, 100%); }
	.ea-capsule {
		display: flex;
		gap: 6px;
		padding: 5px;
		border: 1px solid var(--ea-line-strong);
		border-radius: 999px;
		background: #fff;
		transition: border-color 0.15s;
	}
	.ea-capsule:focus-within { border-color: var(--ea-ink); }
	.ea-capsule input {
		flex: 1;
		min-width: 0;
		min-height: 46px;
		padding: 0 18px;
		border: 0;
		outline: none;
		background: none;
		color: var(--ea-ink);
		font: inherit;
		font-size: 16px;
		letter-spacing: 0.15em;
	}
	.ea-capsule input::placeholder { color: var(--ea-mute); letter-spacing: normal; }
	.ea-fine {
		margin: 14px auto 0;
		max-width: 46em;
		color: var(--ea-mute-text);
		font-size: 13px;
		line-height: 1.55;
	}

	/* sections */
	.ea-eyebrow {
		margin: 0 0 10px;
		color: var(--ea-soft);
		font-size: 13px;
		font-weight: 600;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}
	.ea-section-head { max-width: 40em; }
	.ea-section-head + .ea-section-head { margin-top: 56px; }
	.ea h2 {
		margin: 0 0 12px;
		font-size: clamp(28px, 3.4vw, 44px);
		font-weight: 500;
		line-height: 1.1;
		letter-spacing: -0.03em;
	}
	.ea-section-head > p:last-child { color: var(--ea-soft); line-height: 1.65; margin: 0; }

	.ea-benefits { padding: clamp(72px, 9vw, 120px) 0 clamp(56px, 7vw, 88px); }
	.ea-benefit-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 20px;
		margin-top: 40px;
	}
	.ea-benefit {
		position: relative;
		padding: 28px 28px 32px;
		border: 1px solid var(--ea-line);
		border-radius: 22px;
		background: #fff;
		transition: transform 0.45s cubic-bezier(0.2, 0.7, 0.3, 1), border-color 0.3s, box-shadow 0.45s;
	}
	.ea-benefit:hover {
		transform: translateY(-4px);
		border-color: var(--ea-line-strong);
		box-shadow: 0 22px 44px -28px #0d0d0d47;
	}
	.ea-benefit-icon {
		display: grid;
		place-items: center;
		width: 52px; height: 52px;
		margin-bottom: 36px;
		border-radius: 15px;
	}
	.ea-tint-blue { background: #e8f1fa; color: #5d7fa6; }
	.ea-tint-sky { background: #eef6f4; color: #4a8f82; }
	.ea-tint-sage { background: #f6efe4; color: #a3743d; }
	.ea-benefit-icon svg { width: 26px; height: 26px; overflow: visible; }
	.ea-benefit-icon .ea-ic-stick { width: 12px; height: 32px; }
	.ea-ic-ring { transform-origin: center; transition: transform 0.6s cubic-bezier(0.2, 0.7, 0.3, 1); }
	.ea-ic-spark { transition: transform 0.6s cubic-bezier(0.2, 0.7, 0.3, 1); }
	.ea-benefit:hover .ea-ic-ring { transform: rotate(144deg); }
	.ea-benefit:hover .ea-ic-spark { transform: rotate(90deg) scale(1.12); }
	.ea-benefit h3 { margin: 0 0 8px; font-size: 18px; font-weight: 500; letter-spacing: -0.01em; }
	.ea-benefit p { margin: 0; color: var(--ea-soft); line-height: 1.65; }

	.ea-invite {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: clamp(40px, 6vw, 96px);
		padding: clamp(56px, 7vw, 88px) 0;
		border-top: 1px solid var(--ea-line);
	}
	.ea-invite-copy p:not(.ea-eyebrow) { color: var(--ea-soft); line-height: 1.65; margin: 0 0 28px; }
	.ea-steps { list-style: none; margin: 0; padding: 0; }
	.ea-steps li { display: flex; gap: 16px; position: relative; padding: 0 0 28px 0; }
	.ea-steps li:not(:last-child)::before {
		content: '';
		position: absolute;
		left: 15px; top: 36px; bottom: 0;
		width: 1px;
		background: var(--ea-line-strong);
	}
	.ea-step-n {
		flex: none;
		display: grid;
		place-items: center;
		width: 32px; height: 32px;
		border: 1px solid var(--ea-line-strong);
		border-radius: 50%;
		background: #fff;
		font-size: 13px;
		font-weight: 600;
	}
	.ea-steps strong { display: block; margin-bottom: 4px; }
	.ea-steps p { margin: 0; color: var(--ea-soft); font-size: 14.5px; line-height: 1.6; }

	.ea-faq { padding: clamp(48px, 6vw, 80px) 0; border-top: 1px solid var(--ea-line); }
	.ea-q { border-top: 1px solid var(--ea-line); }
	.ea-q:last-of-type { border-bottom: 1px solid var(--ea-line); }
	.ea-q summary {
		padding: 18px 4px;
		font-weight: 500;
		cursor: pointer;
		list-style: none;
	}
	.ea-q summary::after { content: '+'; float: right; color: var(--ea-mute-text); }
	.ea-q[open] summary::after { content: '–'; }
	.ea-q p { margin: 0 0 18px; max-width: 44em; color: var(--ea-soft); line-height: 1.65; }

	.ea-footer {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 16px;
		padding: 28px 0 40px;
		border-top: 1px solid var(--ea-line);
		color: var(--ea-mute-text);
		font-size: 13.5px;
	}
	.ea-footer > span:first-child { color: var(--ea-soft); font-weight: 600; }

	@media (max-width: 820px) {
		.ea-benefit-grid, .ea-invite { grid-template-columns: 1fr; }
		.ea-nav { display: none; }
		.ea-b1 { width: 110vw; bottom: -50vw; left: -40vw; }
		.ea-b2 { width: 100vw; top: -30vw; right: -40vw; }
	}
</style>
