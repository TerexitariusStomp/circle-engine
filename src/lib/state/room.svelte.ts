import { createActor } from 'xstate';
import { stickMachine } from '../domain/stick.machine';
import { openRoom, type RoomHandle } from '../net/room';
import type { OpEnvelope, RealtimeMessage, RoomState } from '../wire/messages';
import { createIdentity, registerPeerKey, dropPeerKey, type Identity } from '../crypto/identity';
import { OpLog, authorityOf, LEASE_MS } from '../authority/authority';
import { E2EESession } from '../crypto/e2ee';
import { denyReasons, initPolicy, type Actor } from '../policy/engine';
import { electAll, type Capability, type Role } from '../roles/auction';
import { capture, wireE2EE, type LocalMedia } from '../media/capture';
import { Recorder } from '../rec/recorder';
import { NotesDoc } from '../notes/notes';
import { BreakoutSession } from '../net/breakout';
import { CaptionPipeline, LocalTts } from '../ai/speech';
import { Milo } from '../ai/milo';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * Room session — composition root for the declarative stack:
 *   Trystero transport + XState stick + zod wire + OPA policy +
 *   OpLog (signed, epoch-fenced) + RoomRatchet (SFrame E2EE) +
 *   capability auction (authority/milo/recorder roles) + Recorder.
 */

export class RoomSession {
	handle: RoomHandle;
	identity: Identity;
	oplog: OpLog;
	e2ee: E2EESession;
	stick = createActor(stickMachine);
	recorder: Recorder;
	notes: NotesDoc;

	selfMuted = $state(true); // join muted — never auto-open the mic
	peers = $state<string[]>([]);
	names = $state<Record<string, string>>({});
	caps = $state<Record<string, Capability>>({});
	roles = $state<Record<Role, string | null> | null>(null);
	authorityId = $derived(authorityOf([this.selfId, ...this.peers]));
	stickHolderId = $derived(this.stick.getSnapshot().context.holderId);
	stickState = $derived(this.stick.getSnapshot().value);
	chatLog = $state<{ from: string; text: string; whisper?: boolean }[]>([]);
	captions = $state<{ from: string; text: string; final: boolean }[]>([]);
	raisedHands = $state<Set<string>>(new Set());
	consentAsked = $state(false); // someone proposed recording — dialog shown
	consents = $state<Record<string, 'granted' | 'denied'>>({});
	recording = $state(false);
	e2eeActive = $state(false);
	breakoutCount = $state(0);
	pendingBreakout = $state<string | null>(null);
	breakout = $state<BreakoutSession | null>(null);
	remoteStreams = $state<Record<string, MediaStream>>({});
	localMedia: LocalMedia | null = null;
	captionsAvailable = $state(false);
	miloState = $state<'off' | 'standby' | 'listening' | 'speaking'>('off');

	private heartbeat = 0;
	private pipeline = new CaptionPipeline();
	private milo = new Milo();
	private tts = new LocalTts();
	private ttsReady: boolean | null = null;
	private transcriptWindow: string[] = [];
	private captionTap: { close(): void } | null = null;

	constructor(
		public roomSecret: string,
		public displayName: string,
		public roomCode: string
	) {
		this.identity = createIdentity('');
		this.handle = openRoom(roomSecret);
		this.e2ee = new E2EESession(this.handle);
		this.recorder = new Recorder(roomCode);
		this.notes = new NotesDoc(this.handle);
		this.oplog = new OpLog(this.identity, (env) =>
			denyReasons(env.op, this.actorFor(env.senderId), this.stateSnapshot())
		);
		this.stick.start();
		void initPolicy();
		(globalThis as { __room?: RoomHandle }).__room = this.handle; // e2e/debug handle

		this.handle.onPeerJoin((peerId) => {
			this.peers = [...this.peers, peerId];
			this.handle.sendRealtime(
				{ t: 'hello', name: displayName, cap: [bytesToHex(this.identity.publicKey), this.e2ee.publicKeyHex] },
				peerId // targeted hello so the joiner gets our keys
			);
			this.syncSeats();
		});
		this.handle.onPeerLeave((peerId) => {
			this.peers = this.peers.filter((p) => p !== peerId);
			delete this.remoteStreams[peerId];
			dropPeerKey(peerId);
			this.syncSeats();
			void this.rotateKeys('leave', peerId); // FS: departed peer can't read new frames
			this.stick.send({ type: 'HOLDER_LOST' }); // orphan deadline: authority refines timing
		});
		this.handle.onPeerStream((stream, peerId) => {
			this.remoteStreams[peerId] = stream;
		});
		this.handle.onRealtime((msg, peerId) => this.onRealtime(msg, peerId));
		this.handle.onOp((env, peerId) => this.onOp(env, peerId));

		// authority heartbeat — lease renewal; missed 2x -> takeover via authorityOf()
		this.heartbeat = window.setInterval(() => {
			if (this.authorityId === this.selfId) {
				this.handle.sendRealtime({ t: 'authority-heartbeat', leaseUntil: Date.now() + LEASE_MS });
			}
		}, LEASE_MS / 2);
	}

	get selfId() {
		return this.handle.selfId;
	}

	get selfActor(): Actor {
		return { id: this.selfId, canManageRoom: this.authorityId === this.selfId };
	}

	private actorFor(peerId: string): Actor {
		return { id: peerId, canManageRoom: peerId === this.authorityId };
	}

	private stateSnapshot(): RoomState {
		return {
			epoch: this.oplog.epoch,
			config: {
				mode: 'circle_round', direction: 'sunwise',
				speakingTimerEveryone: false, heartMode: false,
				transcriptScope: 'holder', recording: this.recording,
				maxSeats: 12, questionMoments: true
			},
			seats: {}, occupants: {},
			stick: {
				state: this.stickState === 'held' ? 'held' : 'on_table',
				holderId: this.stickHolderId, atSeatOf: null, resumeTo: null, questionActive: false
			},
			recording: { active: this.recording, startedBy: null, consentRequired: true },
			authorityId: this.authorityId,
			roles: {
				miloBrain: this.roles?.['milo-brain'] ?? null,
				miloVoice: this.roles?.['milo-voice'] ?? null,
				recorderPrimary: this.roles?.['recorder-primary'] ?? null,
				recorderStandby: this.roles?.['recorder-standby'] ?? null
			}
		};
	}

	private syncSeats() {
		const seats = [this.selfId, ...this.peers].sort();
		this.stick.send({ type: 'SEATS_SET', seats });
		this.roles = electAll(Object.values(this.caps));
		void this.ensureMilo();
	}

	private async rotateKeys(kind: 'join' | 'leave', peerId: string) {
		const announcements = await this.e2ee.onMembershipChange(kind, peerId);
		for (const [to, data] of announcements) {
			this.handle.sendRealtime({ t: 'e2ee-key', epoch: this.e2ee.epoch, data }, to);
		}
		this.e2eeActive = this.e2ee.active;
	}

	private onRealtime(msg: RealtimeMessage, peerId: string) {
		switch (msg.t) {
			case 'hello':
				this.names[peerId] = msg.name;
				if (msg.cap[0]) registerPeerKey(peerId, msg.cap[0]);
				if (msg.cap[1]) {
					this.e2ee.addPeerIdentity(peerId, msg.cap[1]);
					void this.rotateKeys('join', peerId);
				}
				break;
			case 'chat':
				this.chatLog = [...this.chatLog, { from: peerId, text: msg.text, whisper: !!msg.whisperTo }];
				break;
			case 'caption-update':
				this.captions = [...this.captions.slice(-50), { from: peerId, text: msg.text, final: msg.final }];
				if (msg.final) void this.maybeMilo(msg.text);
				break;
			case 'milo-state':
				this.miloState = msg.state;
				break;
			case 'hand-raise':
				this.raisedHands = new Set([...this.raisedHands, peerId]);
				break;
			case 'hand-lower':
				this.raisedHands.delete(peerId);
				this.raisedHands = new Set(this.raisedHands);
				break;
			case 'recorder-heartbeat':
				// standby promotion: if primary heartbeats stop >2 leases, re-elect
				break;
			case 'e2ee-key':
				void this.e2ee.consumeAnnouncement(msg.data);
				break;
			case 'breakout-assign':
				if (msg.to === this.selfId) this.pendingBreakout = msg.room;
				break;
			case 'breakout-broadcast':
				this.chatLog = [...this.chatLog, { from: 'host', text: `📢 ${msg.text}` }];
				break;
			case 'breakout-return':
				void this.leaveBreakout();
				break;
			case 'recording-consent':
				if (msg.state === 'pending') this.consentAsked = true;
				else this.consents[peerId] = msg.state;
				break;
			case 'recording-state':
				this.recording = msg.active;
				break;
		}
	}

	private onOp(env: OpEnvelope, _peerId: string) {
		const denies = this.oplog.apply(env);
		if (denies) return; // rejected: replay/stale-epoch/bad-sig/policy
		switch (env.op.t) {
			case 'stick-request': this.stick.send({ type: 'REQUEST', by: env.senderId }); break;
			case 'stick-pass': this.stick.send({ type: 'PASS' }); break;
			case 'stick-table': this.stick.send({ type: 'TABLE' }); break;
			case 'stick-resume': this.stick.send({ type: 'QUESTION_END' }); break;
			case 'mode-set': this.stick.send({ type: 'MODE_SET', mode: env.op.mode }); break;
			case 'direction-set': this.stick.send({ type: 'DIRECTION_SET', direction: env.op.direction }); break;
			case 'recording-start': this.recording = true; void this.maybeRecord(); break;
			case 'recording-stop': this.recording = false; void this.recorder.stop(); break;
			case 'room-end': void this.leave(); break;
			case 'breakout-open': this.breakoutCount = env.op.count; break;
			case 'breakout-close':
				this.breakoutCount = 0;
				void this.leaveBreakout();
				break;
		}
	}

	private emitOp(op: OpEnvelope['op']) {
		const unsigned = { v: 1, t: 'op', opId: crypto.randomUUID(), roomEpoch: this.oplog.epoch, senderId: this.selfId, sentAt: Date.now(), op };
		const sig = this.identity.sign(new TextEncoder().encode(JSON.stringify(unsigned)));
		const env = { ...unsigned, sig } as OpEnvelope;
		this.onOp(env, this.selfId); // self-apply through the same validation path
		this.handle.sendOp(op, sig, this.oplog.epoch);
	}

	async join() {
		this.localMedia = await capture({ video: true, audio: true });
		this.localMedia.setMuted(this.selfMuted);
		this.handle.addStream(this.localMedia.stream);
		wireE2EE(this.handle, this.e2ee);
		this.handle.sendRealtime({
			t: 'hello', name: this.displayName,
			cap: [bytesToHex(this.identity.publicKey), this.e2ee.publicKeyHex]
		});
		this.caps[this.selfId] = await measureCapability(this.selfId);
		this.syncSeats();
		void this.startCaptions();
	}

	/** tap local mic → resample to 16kHz mono → sherpa ASR → caption-update frames */
	private async startCaptions() {
		const audioTrack = this.localMedia?.stream.getAudioTracks()[0];
		if (!audioTrack) return;
		if (!(await this.pipeline.init())) return; // model packs absent — degrade visibly
		this.captionsAvailable = true;
		this.pipeline.onSegment = (seg) => {
			this.captions = [...this.captions.slice(-50), { from: this.selfId, text: seg.text, final: seg.final }];
			this.handle.sendRealtime({ t: 'caption-update', text: seg.text, final: seg.final, lang: 'en' });
			if (seg.final) void this.maybeMilo(seg.text);
		};
		const ctx = new AudioContext();
		const src = ctx.createMediaStreamSource(this.localMedia!.stream);
		const proc = ctx.createScriptProcessor(4096, 1, 1);
		const mute = ctx.createGain();
		mute.gain.value = 0; // tap only — never feed local mic back to speakers
		proc.onaudioprocess = (e) =>
			this.pipeline.push(resampleTo16k(e.inputBuffer.getChannelData(0), ctx.sampleRate));
		src.connect(proc);
		proc.connect(mute);
		mute.connect(ctx.destination);
		this.captionTap = {
			close() {
				src.disconnect();
				proc.disconnect();
				mute.disconnect();
				void ctx.close();
			}
		};
	}

	/** Milo is an elected role — init the LLM only on the milo-brain device */
	private async ensureMilo() {
		if (this.miloState !== 'off' || this.roles?.['milo-brain'] !== this.selfId) return;
		const ok = await this.milo.init({
			modelUrl: '/models/llm/SmolLM2-135M-Instruct-Q4_K_M.gguf',
			maxContextTokens: 2048
		});
		this.miloState = this.milo.state;
		this.milo.onSay = (text) => {
			this.handle.sendRealtime({ t: 'chat', text: `Milo: ${text}` });
			this.chatLog = [...this.chatLog, { from: this.selfId, text: `Milo: ${text}` }];
			void this.speakMilo(text);
			this.handle.sendRealtime({ t: 'milo-state', state: this.milo.state });
		};
		this.handle.sendRealtime({ t: 'milo-state', state: this.milo.state });
		void ok;
	}

	/** direct-address trigger: final transcript lines starting with "milo" */
	private async maybeMilo(text: string) {
		this.transcriptWindow = [...this.transcriptWindow.slice(-39), text];
		if (this.roles?.['milo-brain'] !== this.selfId) return;
		const match = text.trim().match(/^milo[\s,.:;-]+(.+)/i);
		if (!match) return;
		this.miloState = 'listening';
		await this.milo.ask(match[1], this.transcriptWindow);
		this.miloState = this.milo.state;
	}

	/** milo-voice role synthesizes Milo replies locally via sherpa VITS */
	private async speakMilo(text: string) {
		if (this.roles?.['milo-voice'] !== this.selfId) return;
		if (this.ttsReady === null) this.ttsReady = await this.tts.init();
		if (!this.ttsReady) return;
		const audio = this.tts.speak(text);
		if (!audio) return;
		const ctx = new AudioContext({ sampleRate: audio.sampleRate });
		const buf = ctx.createBuffer(1, audio.samples.length, audio.sampleRate);
		buf.copyToChannel(audio.samples as Float32Array<ArrayBuffer>, 0);
		const node = ctx.createBufferSource();
		node.buffer = buf;
		node.connect(ctx.destination);
		node.onended = () => void ctx.close();
		node.start();
	}

	private async maybeRecord() {
		if (this.roles?.['recorder-primary'] === this.selfId || this.roles?.['recorder-standby'] === this.selfId) {
			await this.recorder.start();
		}
	}

	requestStick() { this.emitOp({ t: 'stick-request' }); }
	passStick() {
		this.emitOp(this.stick.getSnapshot().context.mode === 'circle_round'
			? { t: 'stick-pass', to: '' }
			: { t: 'stick-table' });
	}
	tableStick() { this.emitOp({ t: 'stick-table' }); }
	raiseHand(up: boolean) {
		this.handle.sendRealtime({ t: up ? 'hand-raise' : 'hand-lower' });
		if (up) this.raisedHands = new Set([...this.raisedHands, this.selfId]);
		else { this.raisedHands.delete(this.selfId); this.raisedHands = new Set(this.raisedHands); }
	}
	/** recording requires universal consent — propose first, start when all grant */
	proposeRecording() {
		this.handle.sendRealtime({ t: 'recording-consent', state: 'pending' });
		this.consentAsked = true;
		this.consents[this.selfId] = 'granted';
	}
	answerConsent(granted: boolean) {
		this.consents[this.selfId] = granted ? 'granted' : 'denied';
		this.handle.sendRealtime({ t: 'recording-consent', state: granted ? 'granted' : 'denied' });
		this.consentAsked = false;
	}
	get allConsented() {
		return this.peers.every((p) => this.consents[p] === 'granted') && this.consents[this.selfId] === 'granted';
	}
	startRecording() {
		if (!this.allConsented) return this.proposeRecording();
		this.emitOp({ t: 'recording-start' });
	}
	stopRecording() { this.emitOp({ t: 'recording-stop' }); }
	endRoom() { this.emitOp({ t: 'room-end' }); }

	// --- breakouts (authority only per cic.rego) ---
	openBreakouts(count: number) { this.emitOp({ t: 'breakout-open', count }); }
	closeBreakouts() { this.emitOp({ t: 'breakout-close' }); }
	assignBreakout(peerId: string, room: string) {
		this.handle.sendRealtime({ t: 'breakout-assign', room, to: peerId }, peerId);
	}
	broadcastToBreakouts(text: string) {
		this.handle.sendRealtime({ t: 'breakout-broadcast', text });
	}
	async joinBreakout(roomId: string) {
		this.breakout = new BreakoutSession(this.roomSecret, roomId);
		if (this.localMedia) this.breakout.publish(this.localMedia.stream);
		this.pendingBreakout = null;
	}
	async leaveBreakout() {
		await this.breakout?.leave();
		this.breakout = null;
	}
	async returnFromBreakout() {
		this.handle.sendRealtime({ t: 'breakout-return' });
		await this.leaveBreakout();
	}

	sendChat(text: string, whisperTo?: string) {
		// whisper = DC-targeted frame — only the recipient's client decodes it
		this.handle.sendRealtime({ t: 'chat', text, whisperTo }, whisperTo);
		this.chatLog = [...this.chatLog, { from: this.selfId, text, whisper: !!whisperTo }];
	}

	/** mute sovereignty: self|auto|remote — remote can never force-open */
	setSelfMuted(muted: boolean) {
		this.selfMuted = muted;
		this.localMedia?.setMuted(muted);
		this.handle.sendRealtime({ t: 'mute-state', muted });
	}

	async leave() {
		clearInterval(this.heartbeat);
		this.captionTap?.close();
		await this.recorder.stop();
		this.notes.destroy();
		this.localMedia?.stop();
		this.e2ee.dispose();
		this.stick.stop();
		return this.handle.leave();
	}
}

/** linear-interpolation resampler → 16kHz mono for sherpa */
function resampleTo16k(input: Float32Array, fromRate: number): Float32Array {
	if (fromRate === 16000) return input;
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

async function measureCapability(peerId: string): Promise<Capability> {
	const nav = navigator as Navigator & { deviceMemory?: number };
	return {
		peerId,
		cpuScore: nav.hardwareConcurrency ?? 2,
		memoryGB: nav.deviceMemory ?? 4,
		batterySaver: false,
		webgpu: 'gpu' in navigator,
		models: [],
		uplinkKbps: 2000,
		isRecorderDevice: false
	};
}
