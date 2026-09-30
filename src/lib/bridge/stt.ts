/**
 * CaptionSocket — terminates the production caption-audio socket.
 * The frontend pushes raw PCM (Int16) here after `caption-source-ready`;
 * we run it through the local sherpa-onnx streaming ASR and emit real
 * `caption-update` frames back over the room socket (and to the mesh so
 * remote bridges show our speech too). No audio ever leaves the device.
 */
import { LocalSocket } from './localSocket';
import { CaptionPipeline } from '../ai/speech';
import type { RoomSession } from '../state/room.svelte';

type Frame = Record<string, unknown>;
interface Emit {
	frame(f: Frame): void;
}

export class CaptionSocket extends LocalSocket {
	private pipeline = new CaptionPipeline();
	private ready = false;
	private sampleRate = 16000;
	private seq = 0;

	constructor(
		url: string,
		private sink: Emit,
		private session: RoomSession | null,
		private sourceId: string
	) {
		super(url);
		const gen = new URL(url).searchParams.get('gen') ?? '0';
		void this.init(gen);
	}

	private async init(generation: string) {
		this.ready = await this.pipeline.init();
		if (!this.ready) {
			this.sink.frame({ t: 'caption-state', state: 'error', reason: 'model_unavailable', generation });
			this.terminate();
			return;
		}
		this.pipeline.onSegment = (seg) => {
			const update = {
				sourceId: this.sourceId,
				generation,
				subscription: 0,
				sequence: ++this.seq,
				state: 'live',
				at: Date.now(),
				sections: [
					{
						id: 1,
						original: { final: seg.final ? seg.text : '', partial: seg.final ? '' : seg.text },
						translation: { final: '', partial: '' }
					}
				]
			};
			this.sink.frame({ t: 'caption-update', update });
			this.session?.broadcast({ t: 'caption-update', text: seg.text, final: seg.final, lang: 'en' });
			if (seg.final)
				this.sink.frame({
					t: 'transcript',
					entry: { id: crypto.randomUUID(), at: Date.now(), name: this.session?.displayName ?? 'You', text: seg.text }
				});
		};
		this.open();
	}

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
		if (!this.ready || typeof data === 'string' || data instanceof Blob) return;
		const bytes = data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer;
		const pcm16 = new Int16Array(bytes);
		const f32 = new Float32Array(pcm16.length);
		for (let i = 0; i < pcm16.length; i++) f32[i] = pcm16[i] / 32768;
		this.pipeline.push(this.sampleRate === 16000 ? f32 : resample(f32, this.sampleRate));
	}

	protected onClose() {
		this.pipeline = new CaptionPipeline(); // drop recognizer refs
	}
}

function resample(input: Float32Array, fromRate: number): Float32Array {
	const ratio = fromRate / 16000;
	const out = new Float32Array(Math.floor(input.length / ratio));
	for (let i = 0; i < out.length; i++) {
		const pos = i * ratio;
		const lo = Math.floor(pos);
		const hi = Math.min(lo + 1, input.length - 1);
		out[i] = input[lo] + (input[hi] - input[lo]) * (pos - lo);
	}
	return out;
}
