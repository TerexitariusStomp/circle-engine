import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({ fallback: 'index.html' }),
		csp: {
			mode: 'auto',
			directives: {
				'default-src': ['self'],
				// connect-src: same-origin + rendezvous relays (nostr/mqtt/bittorrent)
				// — all wss endpoints. Models/wasm/brand assets are same-origin; the
				// dotlottie CDN fetch is shimmed to the vendored copy in install.ts.
				// No https: — nothing leaves this origin except relay websockets.
				'connect-src': ['self', 'wss:'],
				// wasm-unsafe-eval: sherpa-onnx/opa-wasm/wllama instantiate WASM modules
				'script-src': ['self', 'wasm-unsafe-eval'],
				// style-src: Svelte transitions + qr-code-styling inject inline styles
				'style-src': ['self', 'unsafe-inline'],
				'worker-src': ['self', 'blob:'],
				'font-src': ['self'],
				'img-src': ['self', 'data:', 'blob:'],
				'media-src': ['self', 'blob:', 'mediastream:'],
				'object-src': ['none'],
				'base-uri': ['none'],
				'form-action': ['self']
			}
		}
	}
};

export default config;
