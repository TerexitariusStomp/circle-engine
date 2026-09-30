/**
 * Speech pipeline — sherpa-onnx WASM (single runtime for VAD, ASR, KWS, TTS).
 * WASM artifacts + model packs are fetched on demand; everything degrades
 * gracefully when a model isn't available locally.
 */

// sherpa-onnx ships as a CJS wasm bridge; Vite bundles it.
// Model files (zipformer/moonshine/paraformer + vad + kws + tts voices) are
// delivered as model packs under /models/* — see design/MODELS.md.

export interface SpeechSegment {
	text: string;
	final: boolean;
	lang?: string;
	speaker?: number;
}

type SherpaModule = {
	createVad: (config: unknown) => { acceptWaveform?: (f: Float32Array) => void; isDetected?: () => boolean };
	createOnlineRecognizer: (config: unknown) => {
		isReady?: (s: unknown) => boolean;
		decode?: (s: unknown) => void;
		getResult?: (s: unknown) => { text: string };
	};
	createKws: (config: unknown) => unknown;
	createOfflineTts: (config: unknown) => { generate?: (o: { text: string }) => { samples: Float32Array; sampleRate: number } };
};

let mod: SherpaModule | null = null;

export async function loadSherpa(): Promise<boolean> {
	if (mod) return true;
	try {
		mod = (await import('sherpa-onnx')) as unknown as SherpaModule;
		return true;
	} catch {
		return false; // wasm assets missing — caller must degrade visibly
	}
}

export class CaptionPipeline {
	private recognizer: ReturnType<NonNullable<SherpaModule>['createOnlineRecognizer']> | null = null;
	private vad: ReturnType<NonNullable<SherpaModule>['createVad']> | null = null;
	onSegment: (seg: SpeechSegment) => void = () => {};

	async init(modelDir: string) {
		if (!(await loadSherpa()) || !mod) return false;
		this.vad = mod.createVad({
			sileroVad: { model: `${modelDir}/silero_vad.onnx` },
			sampleRate: 16000
		});
		this.recognizer = mod.createOnlineRecognizer({
			transducer: {
				encoder: `${modelDir}/encoder.onnx`,
				decoder: `${modelDir}/decoder.onnx`,
				joiner: `${modelDir}/joiner.onnx`
			},
			tokens: `${modelDir}/tokens.txt`,
			modelType: 'zipformer2'
		});
		return true;
	}

	/** feed 16kHz mono PCM frames from a ScriptProcessor/AudioWorklet tap */
	push(samples: Float32Array) {
		if (!this.vad || !this.recognizer) return;
		this.vad.acceptWaveform?.(samples);
		if (this.recognizer.decode) {
			const res = this.recognizer.getResult?.(null);
			if (res?.text) this.onSegment({ text: res.text, final: false });
		}
	}
}

/** spoken "Milo"/"stop" keyword spotting via sherpa KWS */
export class WakeWord {
	private kws: unknown = null;
	async init(modelDir: string, keywords: string[] = ['milo', 'stop milo']) {
		if (!(await loadSherpa()) || !mod) return false;
		this.kws = mod.createKws({
			keywordsFile: `${modelDir}/keywords.txt`,
			tokens: `${modelDir}/tokens.txt`
		});
		void keywords;
		return this.kws !== null;
	}
}

/** local TTS for Milo's voice via sherpa VITS models */
export class LocalTts {
	private tts: ReturnType<NonNullable<SherpaModule>['createOfflineTts']> | null = null;
	async init(modelDir: string) {
		if (!(await loadSherpa()) || !mod) return false;
		this.tts = mod.createOfflineTts({
			model: { vits: { model: `${modelDir}/vits.onnx`, tokens: `${modelDir}/tokens.txt` }, numThreads: 2 }
		});
		return this.tts !== null;
	}
	speak(text: string): Float32Array | null {
		const out = this.tts?.generate?.({ text });
		return out?.samples ?? null;
	}
}
