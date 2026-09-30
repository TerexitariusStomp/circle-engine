/**
 * installCicShims — presented to the vendored production app before it boots.
 *
 * The app expects a backend; we are that backend, in-process:
 *   /ws/room/{code}      → RoomSocket → RoomBridge → RoomSession (mesh engine)
 *   /ws/caption/{code}   → CaptionSocket → sherpa-onnx streaming ASR
 *   /api/room-ui/*       → localStorage persistence (themes/preferences/defaults)
 *   /api/site-brand/*    → local brand assets
 *   /api/ux-events|room-ui/events|feedback → accepted (204) — no telemetry sink exists
 *   /_app/version.json   → local build stamp
 *   /rec/abort|/rec-local/* → local recorder artifact store (memory-backed, real bytes)
 *   other same-origin /ws/* → refused (nothing claims those paths)
 *   external wss://      → real WebSocket passthrough (browser enforces CSP)
 */
import { RoomSocket } from './roomBridge.svelte';
import { CaptionSocket } from './stt';
import { LocalSocket } from './localSocket';
import type { RoomSession } from '../state/room.svelte';

const LS_PREFIX = 'cic.ui.';
const recArtifacts = new Map<string, Blob>();

let activeSession: RoomSession | null = null;
export function bridgeSession(): RoomSession | null {
	return activeSession;
}

// room-socket registry so caption sockets find their bridge's session
const roomSockets = new Map<string, RoomSocket>();
export function roomSocketFor(code: string): RoomSocket | null {
	return roomSockets.get(code) ?? null;
}

export function installCicShims(roomKey?: string) {
	seedLocalStorage();
	patchFetch();
	patchWebSocket(roomKey);
}

function seedLocalStorage() {
	try {
		if (!localStorage.getItem('cic.pid')) localStorage.setItem('cic.pid', crypto.randomUUID());
	} catch {
		/* storage unavailable — production code handles it */
	}
}

// ------------------------------------------------------------- fetch

function patchFetch() {
	const orig = window.fetch.bind(window);
	window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
		if (url.origin !== location.origin) return orig(input, init); // external → real fetch (CSP-bound)
		const path = url.pathname;

		// UI persistence — real localStorage-backed store
		if (path === '/api/room-ui/themes' || path === '/api/room-ui/preferences' || path === '/api/room-ui/defaults') {
			const key = LS_PREFIX + path.split('/').pop();
			if (init?.method === 'PUT' || init?.method === 'POST') {
				try {
					localStorage.setItem(key!, String(init.body ?? '{}'));
				} catch {}
				return json({});
			}
			const saved = localStorage.getItem(key!);
			return json(saved ? JSON.parse(saved) : {});
		}

		// brand assets — real local files
		if (path.startsWith('/api/site-brand/')) {
			const name = path.split('/').pop() ?? 'symbol-light';
			return orig(`/brand/${name === 'symbol-dark' ? 'logo.svg' : `${name}.png`}`, init);
		}

		// telemetry sinks — accepted locally, stored nowhere else
		if (path === '/api/ux/events' || path === '/api/room-ui/events' || path === '/api/ux/revoke' || path === '/api/feedback')
			return new Response(null, { status: 204 });

		// version.json → our own build stamp (prevents their reload loop)
		if (path === '/_app/version.json' || path === '/cic/version.json')
			return json({ version: `circle-engine-${Date.now()}` });

		// recorder abort
		if (path.startsWith('/rec/abort')) return json({ ok: true });

		// local recorder artifact store — real bytes, real download
		if (path.startsWith('/rec-local/')) {
			const key = path.slice('/rec-local/'.length);
			if (init?.method === 'PUT' || init?.method === 'POST') {
				const body = init.body instanceof Blob
					? init.body
					: new Blob([init.body as unknown as BlobPart]);
				recArtifacts.set(key, body);
				return json({ ok: true, bytes: body.size });
			}
			const blob = recArtifacts.get(key);
			if (!blob) return new Response('not found', { status: 404 });
			return new Response(blob, { headers: { 'content-type': 'video/webm' } });
		}

		if (path.startsWith('/api/')) return json({ error: 'not found' }, 404);
		return orig(input, init);
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// ------------------------------------------------------------- WebSocket

class RefusedSocket extends LocalSocket {
	constructor(url: string) {
		super(url);
		queueMicrotask(() => this.terminate());
	}
	send() {}
}

function patchWebSocket(roomKey?: string) {
	const NativeWS = window.WebSocket;
	class RoutedSocket {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;
		constructor(url: string | URL, protocols?: string | string[]) {
			const u = new URL(String(url), location.href);
			// the production app always builds wss://{host}/ws/… even on http dev —
			// ws/wss ↔ http/https are the same site, so compare hosts not origins
			const local = (u.protocol === 'ws:' || u.protocol === 'wss:') && u.host === location.host;
			console.debug('[cic-ws] open', u.pathname, local ? '(local)' : '(external)');
			if (local) {
				if (u.pathname.startsWith('/ws/room/')) {
					const code = decodeURIComponent(u.pathname.split('/ws/room/')[1]);
					const sock = new RoomSocket(u.href, roomKey);
					roomSockets.set(code, sock);
					return sock as unknown as WebSocket;
				}
				if (u.pathname.startsWith('/ws/caption/')) {
					const code = u.pathname.split('/ws/caption/')[1].split('?')[0];
					const room = roomSockets.get(decodeURIComponent(code));
					return new CaptionSocket(u.href, room?.emitter() ?? { frame: () => {} }, room?.session ?? null, room?.selfId ?? '') as unknown as WebSocket;
				}
				return new RefusedSocket(u.href) as unknown as WebSocket;
			}
			return new NativeWS(url, protocols) as unknown as WebSocket; // external → real socket
		}
	}
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	window.WebSocket = RoutedSocket as any;
}
