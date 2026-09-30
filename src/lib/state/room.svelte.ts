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
	videoMuted = $state(true);
	peers = $state<string[]>([]);
	names = $state<Record<string, string>>({});
	caps = $state<Record<string, Capability>>({});
	roles = $state<Record<Role, string | null> | null>(null);
	authorityId = $derived(authorityOf([this.selfId, ...this.peers]));
	stickHolderId = $derived(this.stick.getSnapshot().context.holderId);
	stickState = $derived(this.stick.getSnapshot().value);
	stickCtx = $derived(this.stick.getSnapshot().context);
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

	// --- production-parity room state (authored via signed ops; bridged to prod frames) ---
	mode = $state<'open_round' | 'circle_round'>('circle_round');
	direction = $state<'sunwise' | 'earthwise'>('sunwise');
	heartMode = $state(false); // heart-sharing: recording + transcription forced off
	lobbyEnabled = $state(false);
	started = $state(true);
	coHostIds = $state<string[]>([]);
	hostLocks = $state<Record<string, boolean>>({});
	miloWake = $state<'hey_milo' | 'click'>('click');
	transcriptScope = $state<'off' | 'holder' | 'all'>('off'); // matches production default "Transcript off"
	turnTimerMinutes = $state(0);
	speakingTimerEveryone = $state(false);
	trFanout = $state<string[]>([]);
	appearance = $state<Record<string, string | undefined>>({});
	ai = $state<{
		name?: string; enabled?: boolean; transcription?: boolean; contextProcessing?: boolean;
		instructions?: string; voice?: string; standby?: boolean; scope?: string; storeTranscript?: boolean;
	}>({ name: 'Milo' });
	waiting = $state<{ id: string; name: string; joinedAt: number }[]>([]);
	peerMuted = $state<Record<string, { audio: boolean; video: boolean }>>({});
	peerAway = $state<Set<string>>(new Set());
	peerSharing = $state<Set<string>>(new Set());
	notesText = $state('');
	joinedAt = $state<Record<string, number>>({});
	remoteMutedBy = $state<Record<string, 'audio' | 'video' | null>>({});
	onReaction: ((kind: string, fromId: string, name: string) => void) | null = null;
	onTranscript: ((entry: { id: string; at: number; name: string; text: string }) => void) | null = null;

	private heartbeat = 0;
	private pipeline = new CaptionPipeline();
	private milo = new Milo();
	private tts = new LocalTts();
	private ttsReady: boolean | null = null;
	private transcriptWindow: string[] = [];
	private captionTap: { close(): void } | null = null;
	private publishedStreams = new Set<MediaStream>();

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
			if (!this.peers.includes(peerId)) this.peers = [...this.peers, peerId];
			this.joinedAt[peerId] = Date.now();
			if (this.lobbyEnabled) {
				// lobby: joiner enters the waiting room, not seats — admit moves them
				this.handle.sendRealtime(
					{ t: 'hello', name: displayName, cap: [bytesToHex(this.identity.publicKey), this.e2ee.publicKeyHex] },
					peerId
				);
				return;
			}
			this.handle.sendRealtime(
				{ t: 'hello', name: displayName, cap: [bytesToHex(this.identity.publicKey), this.e2ee.publicKeyHex] },
				peerId // targeted hello so the joiner gets our keys
			);
			// trystero addStream only reaches already-connected peers — re-offer
			// our published streams to late joiners or they never see our media
			for (const stream of this.publishedStreams) this.handle.addStream(stream, [peerId]);
			this.syncSeats();
		});
		this.handle.onPeerLeave((peerId) => {
			this.peers = this.peers.filter((p) => p !== peerId);
			this.waiting = this.waiting.filter((w) => w.id !== peerId);
			this.peerAway.delete(peerId);
			this.peerSharing.delete(peerId);
			this.peerMuted = { ...this.peerMuted, [peerId]: undefined as never };
			delete this.peerMuted[peerId];
			delete this.remoteStreams[peerId];
			dropPeerKey(peerId);
			this.syncSeats();
			void this.rotateKeys('leave', peerId); // FS: departed peer can't read new frames
			this.stick.send({ type: 'HOLDER_LOST' }); // orphan deadline: authority refines timing
		});
		this.handle.onPeerStream((stream, peerId) => {
			console.debug('[engine] remote stream', peerId, stream.getTracks().map((t) => t.kind).join('+'));
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
				mode: this.mode, direction: this.direction,
				speakingTimerEveryone: this.speakingTimerEveryone, heartMode: this.heartMode,
				transcriptScope: this.transcriptScope, recording: this.recording,
				maxSeats: 12, questionMoments: true
			},
			seats: {}, occupants: {},
			stick: {
				state: this.stickState === 'held' ? 'held' : 'on_table',
				holderId: this.stickHolderId, atSeatOf: this.stickCtx.atSeatOf,
				resumeTo: this.stickCtx.resumeTo, questionActive: this.stickState === 'question'
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
		const waitingIds = new Set(this.waiting.map((w) => w.id));
		const seats = [this.selfId, ...this.peers.filter((p) => !waitingIds.has(p))].sort();
		this.stick.send({ type: 'SEATS_SET', seats });
		this.roles = electAll(Object.values(this.caps));
		// milo brain is elected now, but the ~100MB GGUF loads lazily on first address
		if (this.roles?.['milo-brain'] === this.selfId && this.miloState === 'off') this.miloState = 'standby';
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
			case 'away':
				if (msg.on) this.peerAway = new Set([...this.peerAway, peerId]);
				else { this.peerAway.delete(peerId); this.peerAway = new Set(this.peerAway); }
				break;
			case 'sharing':
				if (msg.on) this.peerSharing = new Set([...this.peerSharing, peerId]);
				else { this.peerSharing.delete(peerId); this.peerSharing = new Set(this.peerSharing); }
				break;
			case 'rename':
				this.names[peerId] = msg.name;
				break;
			case 'muted':
				this.peerMuted = { ...this.peerMuted, [peerId]: { audio: msg.audio, video: msg.video } };
				break;
			case 'notes':
				this.notesText = msg.text;
				break;
			case 'ask-ai':
				if (msg.text) void this.maybeMilo(`milo ${msg.text}`);
				else void this.maybeMilo('milo check in');
				break;
			case 'reaction-kind':
				this.onReaction?.(msg.kind, peerId, this.names[peerId] ?? 'Peer');
				break;
			case 'lobby-join':
				if (this.lobbyEnabled && !this.waiting.some((w) => w.id === peerId)) {
					this.waiting = [...this.waiting, { id: peerId, name: msg.name, joinedAt: Date.now() }]
						.sort((a, b) => a.joinedAt - b.joinedAt);
				}
				break;
			case 'admit': {
				const w = this.waiting.find((x) => x.id === msg.to);
				if (w) {
					this.waiting = this.waiting.filter((x) => x.id !== msg.to);
					this.syncSeats();
				}
				break;
			}
			case 'breakout-move':
				break; // informational — peer's channel change
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
			case 'stick-give': this.stick.send({ type: 'GIVE', to: env.op.to }); break;
			case 'stick-table': this.stick.send({ type: 'TABLE' }); break;
			case 'stick-resume': this.stick.send({ type: 'QUESTION_END' }); break;
			case 'mode-set': this.mode = env.op.mode; this.stick.send({ type: 'MODE_SET', mode: env.op.mode }); break;
			case 'direction-set': this.direction = env.op.direction; this.stick.send({ type: 'DIRECTION_SET', direction: env.op.direction }); break;
			case 'heart-set':
				this.heartMode = env.op.on;
				// invariant: heart-sharing forces recording + transcription off
				if (env.op.on) {
					if (this.recording) { this.recording = false; void this.recorder.stop(); }
					this.captionsAvailable = false;
					this.captionTap?.close(); this.captionTap = null;
					// pipeline has no close — recognizer refs die with the tap
				}
				break;
			case 'lobby-set': this.lobbyEnabled = env.op.enabled; this.syncSeats(); break;
			case 'co-host-set': {
				const target = env.op.id;
				this.coHostIds = env.op.on
					? [...new Set([...this.coHostIds, target])]
					: this.coHostIds.filter((id) => id !== target);
				break;
			}
			case 'started-set': this.started = env.op.on; break;
			case 'host-locks-set': this.hostLocks = { ...env.op.locks }; break;
			case 'appearance-set': {
				const { t: _t, ...patch } = env.op;
				this.appearance = { ...this.appearance, ...patch };
				break;
			}
			case 'ai-set': {
				const { t: _t, ...patch } = env.op;
				this.ai = { ...this.ai, ...patch };
				break;
			}
			case 'milo-wake-set': this.miloWake = env.op.mode; break;
			case 'mute-set':
				if (env.op.id === this.selfId) {
					// remote can never force-open — only force-close
					if (env.op.on && env.op.kind === 'audio') this.setSelfMuted(true);
					if (env.op.on && env.op.kind === 'video') this.setVideoMuted(true);
					this.remoteMutedBy[env.op.kind] = env.op.on ? env.op.kind : null;
				}
				break;
			case 'tr-fanout-set': this.trFanout = [...env.op.lanes]; break;
			case 'turn-timer-set': this.turnTimerMinutes = env.op.minutes; break;
			case 'config-set': {
				const p = env.op.patch;
				if (p.mode) this.stick.send({ type: 'MODE_SET', mode: p.mode });
				if (p.direction) this.stick.send({ type: 'DIRECTION_SET', direction: p.direction });
				if (p.speakingTimerEveryone !== undefined) this.speakingTimerEveryone = p.speakingTimerEveryone;
				if (p.speakingTimerSeconds !== undefined) this.turnTimerMinutes = Math.round(p.speakingTimerSeconds / 60);
				if (p.transcriptScope !== undefined) {
					this.transcriptScope = p.transcriptScope;
					if (p.transcriptScope === 'off') {
						this.captionsAvailable = false;
						this.captionTap?.close(); this.captionTap = null;
					} else if (!this.captionsAvailable) void this.startCaptions();
				}
				if (p.recording === false && this.recording) { this.recording = false; void this.recorder.stop(); }
				break;
			}
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

	emitOp(op: OpEnvelope['op']) {
		const unsigned = { v: 1, t: 'op', opId: crypto.randomUUID(), roomEpoch: this.oplog.epoch, senderId: this.selfId, sentAt: Date.now(), op };
		const sig = this.identity.sign(new TextEncoder().encode(JSON.stringify(unsigned)));
		const env = { ...unsigned, sig } as OpEnvelope;
		this.onOp(env, this.selfId); // self-apply through the same validation path
		this.handle.sendOp(op, sig, this.oplog.epoch);
	}

	async join(opts: { capture?: boolean } = {}) {
		const wantCapture = opts.capture !== false;
		if (wantCapture) {
			this.localMedia = await capture({ video: true, audio: true });
			this.localMedia.setMuted(this.selfMuted);
			this.publishedStreams.add(this.localMedia.stream);
			this.handle.addStream(this.localMedia.stream);
		}
		wireE2EE(this.handle, this.e2ee);
		this.handle.sendRealtime({
			t: 'hello', name: this.displayName,
			cap: [bytesToHex(this.identity.publicKey), this.e2ee.publicKeyHex]
		});
		this.caps[this.selfId] = await measureCapability(this.selfId);
		this.syncSeats();
	}

	/** production-frontend path: media arrives over the loopback SFU — publish it to the mesh */
	publishLocal(stream: MediaStream) {
		this.publishedStreams.add(stream);
		this.handle.addStream(stream);
		if (this.transcriptScope !== 'off' && !this.captionsAvailable) void this.startCaptions(stream);
	}

	/** tap local mic → resample to 16kHz mono → sherpa ASR → caption-update frames */
	private async startCaptions(fromStream?: MediaStream) {
		const audioTrack = (fromStream ?? this.localMedia?.stream)?.getAudioTracks()[0];
		if (!audioTrack) return;
		if (!(await this.pipeline.init())) return; // model packs absent — degrade visibly
		this.captionsAvailable = true;
		this.pipeline.onSegment = (seg) => {
			this.captions = [...this.captions.slice(-50), { from: this.selfId, text: seg.text, final: seg.final }];
			this.handle.sendRealtime({ t: 'caption-update', text: seg.text, final: seg.final, lang: 'en' });
			if (seg.final) void this.maybeMilo(seg.text);
		};
		const ctx = new AudioContext();
		const src = ctx.createMediaStreamSource(fromStream ?? this.localMedia!.stream);
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

	/** Milo is an elected role — the model downloads only on first address, not on join */
	private miloInitStarted = false;
	private async ensureMilo() {
		if (this.miloInitStarted || this.roles?.['milo-brain'] !== this.selfId) return;
		this.miloInitStarted = true;
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
		await this.ensureMilo();
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
		this.handle.sendRealtime({ t: 'muted', audio: muted, video: this.videoMuted });
	}
	setVideoMuted(muted: boolean) {
		this.videoMuted = muted;
		if (this.localMedia) for (const t of this.localMedia.stream.getVideoTracks()) t.enabled = !muted;
		this.handle.sendRealtime({ t: 'muted', audio: this.selfMuted, video: muted });
	}

	// --- bridge-facing API (production frontend commands → signed ops / realtime) ---
	broadcast(msg: RealtimeMessage) { this.handle.sendRealtime(msg); }
	giveStick(to: string) { this.emitOp({ t: 'stick-give', to }); }
	setMode(mode: 'open_round' | 'circle_round') { this.emitOp({ t: 'mode-set', mode }); }
	setDirection(direction: 'sunwise' | 'earthwise') { this.emitOp({ t: 'direction-set', direction }); }
	setHeart(on: boolean) { this.emitOp({ t: 'heart-set', on }); }
	setLobby(on: boolean) { this.emitOp({ t: 'lobby-set', enabled: on }); }
	setCoHost(id: string, on: boolean) { this.emitOp({ t: 'co-host-set', id, on }); }
	setStarted(on: boolean) { this.emitOp({ t: 'started-set', on }); }
	setHostLocks(locks: Record<string, boolean>) { this.emitOp({ t: 'host-locks-set', locks }); }
	setAppearance(patch: Record<string, string>) { this.emitOp({ t: 'appearance-set', ...patch }); }
	setAi(patch: Record<string, unknown>) { this.emitOp({ t: 'ai-set', ...patch }); }
	setMiloWake(mode: 'hey_milo' | 'click') { this.emitOp({ t: 'milo-wake-set', mode }); }
	forceMute(id: string, kind: 'audio' | 'video', on: boolean) { this.emitOp({ t: 'mute-set', id, kind, on }); }
	setTrFanout(lanes: string[]) { this.emitOp({ t: 'tr-fanout-set', lanes }); }
	setTurnTimer(minutes: number) { this.emitOp({ t: 'turn-timer-set', minutes }); }
	setSpeakingTimerEveryone(on: boolean) { this.emitOp({ t: 'config-set', patch: { speakingTimerEveryone: on } }); }
	setTranscription(on: boolean) { this.emitOp({ t: 'config-set', patch: { transcriptScope: on ? 'all' : 'off' } }); }
	announceAway(on: boolean) {
		this.handle.sendRealtime({ t: 'away', on });
		if (on) this.peerAway = new Set([...this.peerAway, this.selfId]);
		else { this.peerAway.delete(this.selfId); this.peerAway = new Set(this.peerAway); }
	}
	announceSharing(on: boolean, audio = false) {
		this.handle.sendRealtime({ t: 'sharing', on, audio });
		if (on) this.peerSharing = new Set([...this.peerSharing, this.selfId]);
		else { this.peerSharing.delete(this.selfId); this.peerSharing = new Set(this.peerSharing); }
	}
	renameSelf(name: string) {
		this.names[this.selfId] = name;
		this.handle.sendRealtime({ t: 'rename', name });
	}
	saveNotes(text: string) {
		this.notesText = text;
		this.handle.sendRealtime({ t: 'notes', text });
	}
	askAi(text?: string) { this.handle.sendRealtime({ t: 'ask-ai', text }); void this.maybeMilo(`milo ${text ?? 'check in'}`); }
	react(kind: string) {
		this.handle.sendRealtime({ t: 'reaction-kind', kind, name: this.names[this.selfId] ?? this.displayName });
		this.onReaction?.(kind, this.selfId, this.names[this.selfId] ?? this.displayName);
	}
	/** lobby: announce a joiner into the waiting list (prod waiting-join) */
	announceLobbyJoin(name: string) { this.handle.sendRealtime({ t: 'lobby-join', name }); }
	admitWaiting(id: string) {
		const w = this.waiting.find((x) => x.id === id);
		if (w) {
			this.waiting = this.waiting.filter((x) => x.id !== id);
			this.syncSeats();
		}
		this.handle.sendRealtime({ t: 'admit', to: id });
	}
	hopBreakout(channel: number) { this.handle.sendRealtime({ t: 'breakout-move', channel }); }

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
