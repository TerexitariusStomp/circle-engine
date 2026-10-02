<script lang="ts">
	/**
	 * Landing — the scraped production marketing page (site-mirrors/
	 * co-intelligence/www.* → static/site/), rendered verbatim. Assets resolve
	 * under /site/*; the page's JS is stripped (hydration + gtag don't belong
	 * in a privacy-preserving build). "Log in" links to /join, our entry.
	 */
	import { onMount } from 'svelte';
	import { base } from '$app/paths';

	let markup = $state('');
	let host: HTMLElement;

	onMount(async () => {
		const html = await (await fetch(`${base}/site/index.html`)).text();
		const doc = new DOMParser().parseFromString(html, 'text/html');
		// the page's styles live in head links — hoist them into our head
		for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"], link[href*=".css"]')) {
			const el = document.createElement('link');
			el.rel = 'stylesheet';
			el.href = link.href;
			document.head.appendChild(el);
		}
		// inline style blocks too
		for (const style of doc.querySelectorAll('style'))
			document.head.appendChild(document.createElement('style')).textContent = style.textContent;
		markup = doc.body.innerHTML;
	});

	// the early-access form is static markup — record the request locally and
	// acknowledge it, honestly (there is no list server behind it)
	function onSubmit(e: SubmitEvent) {
		e.preventDefault();
		const form = e.target as HTMLFormElement;
		const email = new FormData(form).get('email');
		try {
			const key = 'cic.earlyAccess';
			const list = JSON.parse(localStorage.getItem(key) ?? '[]');
			list.push({ email: String(email ?? ''), at: Date.now() });
			localStorage.setItem(key, JSON.stringify(list));
		} catch {}
		const btn = form.querySelector('button');
		if (btn) btn.textContent = 'Request noted — stored on this device';
	}
</script>

<svelte:head><title>Co-Intelligence Circle — Find coherence through human connection</title></svelte:head>

<!-- eslint-disable-next-line svelte/no-at-html-tags -->
<div bind:this={host} onsubmit={onSubmit}>{@html markup}</div>
