/**
 * Speech pipeline — sherpa-onnx WASM (single runtime for VAD, ASR, TTS).
 *
 * The npm `sherpa-onnx` package is the Node.js build; in the browser we load
 * the sherpa-onnx wasm-simd release packs served from /models/* (fetched by
 * scripts/fetch-models.sh, see models/manifest.json). Each pack ships its own
 * Emscripten loader (sherpa-onnx-wasm-main-*.js) + CJS API layer
 * (sherpa-onnx-*.js) + a .data bundle with the model weights baked into the
 * emscripten virtual FS.
 *
 * Everything degrades gracefully when a pack isn't deployed locally.
 */

export interface SpeechSegment {
	text: string;
	final: boolean;
	lang?: string;
	speaker?: number;
}

const PACKS = {
	vad: '/models/vad/sherpa-onnx-wasm-simd-v1.13.8-vad',
	asr: '/models/asr-en/sherpa-onnx-wasm-simd-v1.13.7-en-asr-zipformer',
	tts: '/models/tts-en/sherpa-onnx-wasm-simd-1.13.8-vits-piper-en_US-libritts_r-medium'
} as const;

type PackKind = keyof typeof PACKS;

type SherpaModule = Record<string, unknown> & {
	locateFile?: (path: string, dir?: string) => string;
	onRuntimeInitialized?: () => void;
};

type VadApi = {
	acceptWaveform(samples: Float32Array): void;
	isEmpty(): boolean;
	isDetected(): boolean;
	front(): unknown;
	pop(): void;
	flush(): void;
	config: { sileroVad: { windowSize: number } };
};

type AsrStream = { acceptWaveform(sampleRate: number, samples: Float32Array): void };
type AsrApi = {
	createStream(): AsrStream;
	isReady(s: AsrStream): boolean;
	decode(s: AsrStream): void;
	isEndpoint(s: AsrStream): boolean;
	getResult(s: AsrStream): { text: string };
	reset(s: AsrStream): void;
};

type TtsApi = {
	generate(o: { text: string; sid?: number; speed?: number; enableExternalBuffer?: boolean }): {
		samples: Float32Array;
		sampleRate: number;
	};
};

const loaded = new Map<PackKind, Promise<SherpaModule | null>>();

function injectScript(src: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const el = document.createElement('script');
		el.src = src;
		el.onload = () => resolve();
		el.onerror = () => reject(new Error(`load failed: ${src}`));
		document.head.appendChild(el);
	});
}

declare global {
	interface Window {
		Module?: SherpaModule;
		createVad?: (Module: SherpaModule, config: unknown) => VadApi;
		createOnlineRecognizer?: (Module: SherpaModule, config?: unknown) => AsrApi;
		createOfflineTts?: (Module: SherpaModule) => TtsApi;
	}
}

/**
 * Load a sherpa pack: inject the API script, set the global `Module` the
 * emscripten runtime expects, inject the wasm loader, await initialization.
 * Loads are serialized — all packs share the global `Module` name.
 */
async function loadPack(kind: PackKind): Promise<SherpaModule | null> {
	const dir = PACKS[kind];
	const apiScript = { vad: 'sherpa-onnx-vad.js', asr: 'sherpa-onnx-asr.js', tts: 'sherpa-onnx-tts.js' }[kind];
	const mainScript = `sherpa-onnx-wasm-main-${kind}.js`;
	try {
		await injectScript(`${dir}/${apiScript}`);
		const Module: SherpaModule = {};
		Module.locateFile = (path) => `${dir}/${path}`;
		const ready = new Promise<void>((res) => (Module.onRuntimeInitialized = res));
		window.Module = Module;
		await injectScript(`${dir}/${mainScript}`);
		await ready;
		return Module;
	} catch {
		return null; // pack not deployed — caller degrades visibly
	}
}

function pack(kind: PackKind): Promise<SherpaModule | null> {
	if (!loaded.has(kind)) loaded.set(kind, loadPack(kind));
	return loaded.get(kind)!;
}

/** Local VAD + streaming zipformer ASR → caption segments */
export class CaptionPipeline {
	private recognizer: AsrApi | null = null;
	private stream: AsrStream | null = null;
	private vad: VadApi | null = null;
	private vadBuf: Float32Array[] = [];
	onSegment: (seg: SpeechSegment) => void = () => {};

	async init(): Promise<boolean> {
		const [vadMod, asrMod] = [await pack('vad'), await pack('asr')];
		if (asrMod && window.createOnlineRecognizer) {
			this.recognizer = window.createOnlineRecognizer(asrMod);
			this.stream = this.recognizer.createStream();
		}
		if (vadMod && window.createVad) {
			this.vad = window.createVad(vadMod, {
				sileroVad: {
					model: 'silero_vad.onnx',
					threshold: 0.5,
					minSpeechDuration: 0.25,
					minSilenceDuration: 0.5,
					maxSpeechDuration: 20,
					windowSize: 512
				},
				sampleRate: 16000,
				numThreads: 1,
				debug: false
			});
		}
		return this.recognizer !== null;
	}

	/** feed 16kHz mono PCM frames from an AudioWorklet/ScriptProcessor tap */
	push(samples: Float32Array) {
		if (!this.recognizer || !this.stream) return;
		this.stream.acceptWaveform(16000, samples);
		while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream);
		const text = this.recognizer.getResult(this.stream).text;
		if (this.recognizer.isEndpoint(this.stream)) {
			this.recognizer.reset(this.stream);
			if (text) this.onSegment({ text, final: true });
		} else if (text) {
			this.onSegment({ text, final: false });
		}
	}
}

/** local TTS for Milo's voice via sherpa VITS models */
export class LocalTts {
	private tts: TtsApi | null = null;
	async init(): Promise<boolean> {
		const mod = await pack('tts');
		if (mod && window.createOfflineTts) this.tts = window.createOfflineTts(mod);
		return this.tts !== null;
	}
	speak(text: string): { samples: Float32Array; sampleRate: number } | null {
		return this.tts?.generate({ text, sid: 0, speed: 1.0 }) ?? null;
	}
}
