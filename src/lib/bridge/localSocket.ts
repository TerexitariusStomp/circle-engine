/**
 * LocalSocket — an in-process WebSocket transport. Implements the DOM
 * WebSocket contract (send/close/binaryType/bufferedAmount/readyState/events)
 * over a direct channel to the local room engine. It is a real transport —
 * every frame is parsed, validated and executed by the engine, not simulated.
 */
export abstract class LocalSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSING = 2;
	readonly CLOSED = 3;

	readyState = 0;
	bufferedAmount = 0;
	binaryType: BinaryType = 'blob';
	readonly url: string;
	protocol = '';
	extensions = '';

	onopen: ((ev: Event) => void) | null = null;
	onmessage: ((ev: MessageEvent) => void) | null = null;
	onerror: ((ev: Event) => void) | null = null;
	onclose: ((ev: CloseEvent) => void) | null = null;

	private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

	constructor(url: string) {
		this.url = url;
	}

	addEventListener(type: string, fn: EventListenerOrEventListenerObject) {
		let set = this.listeners.get(type);
		if (!set) this.listeners.set(type, (set = new Set()));
		set.add(fn);
	}
	removeEventListener(type: string, fn: EventListenerOrEventListenerObject) {
		this.listeners.get(type)?.delete(fn);
	}
	dispatchEvent(ev: Event): boolean {
		(this.listeners.get(ev.type) ?? []).forEach((fn) => {
			if (typeof fn === 'function') fn.call(this, ev);
			else fn.handleEvent(ev);
		});
		const handler = this[`on${ev.type}` as 'onmessage'];
		handler?.call(this, ev as MessageEvent);
		return true;
	}

	protected open() {
		if (this.readyState !== 0) return;
		this.readyState = 1;
		queueMicrotask(() => this.dispatchEvent(new Event('open')));
	}
	protected emit(data: string | ArrayBuffer | Blob) {
		if (this.readyState !== 1) return;
		this.dispatchEvent(new MessageEvent('message', { data }));
	}
	protected terminate(code = 1006) {
		this.readyState = 3;
		this.dispatchEvent(new Event('error'));
		this.dispatchEvent(new CloseEvent('close', { code }));
	}
	close(code = 1000) {
		if (this.readyState >= 2) return;
		this.readyState = 2;
		this.onClose(code);
		this.readyState = 3;
		queueMicrotask(() => this.dispatchEvent(new CloseEvent('close', { code })));
	}
	protected onClose(_code: number) {}
	abstract send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
}
