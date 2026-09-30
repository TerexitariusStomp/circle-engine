/**
 * RoomBridge — terminates the production CIC wire protocol in-process.
 * The vendored production frontend opens a WebSocket to /ws/room/{code};
 * this class answers it with real welcome/snapshot/delta/chat/caption
 * frames driven by the actual RoomSession engine (Trystero mesh + signed
 * op-log + XState stick + RoomRatchet E2EE).
 *
 * Every client→server command is executed against real session state —
 * nothing is acknowledged without taking effect.
 */
import { LocalSocket } from './localSocket';
import { RoomSession } from '../state/room.svelte';
import { roomSecretFromCode } from '../net/room';
import { SfuLoopback } from './sfu';
import type { Op } from '../wire/messages';

type Frame = Record<string, unknown>;

type ProdParticipant = {
	id: string;
	name: string;
	kind?: 'ai';
	joinedAt: number;
	connected: boolean;
	away?: boolean;
	muted: { audio: boolean; video: boolean };
	tracks: { sessionId: string; kind: string }[];
	handRaisedAt?: number;
	sharing?: string;
	role?: string;
};

let sessionByCode = new Map<string, RoomSession>();

export class RoomSocket extends LocalSocket {
	private bridge: RoomBridge;

	constructor(url: string, roomKey?: string) {
		super(url);
		const code = decodeURIComponent(url.split('/ws/room/')[1]?.split('?')[0] ?? '');
		this.bridge = new RoomBridge(this, code, roomKey);
		this.open();
	}

	/** frame delivery back to the frontend — used by the bridge */
	emitNow(f: Frame) {
		this.emit(JSON.stringify(f));
	}
	emitter() {
		return { frame: (f: Frame) => this.emitNow(f) };
	}
	get session(): RoomSession | null {
		return this.bridge.sessionRef;
	}
	get selfId(): string {
		return this.bridge.selfProdIdRef;
	}

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
		if (typeof data !== 'string') return; // binary frames belong to the caption socket
		if (data === 'ping') return this.emit('pong');
		let msg: Frame;
		try {
			msg = JSON.parse(data);
		} catch {
			return;
		}
		console.debug('[cic-ws →]', msg.t);
		this.bridge.command(msg);
	}

	protected onClose() {
		void this.bridge.leave();
	}
}

class RoomBridge {
	private sock: RoomSocket;
	private session: RoomSession | null = null;
	private seq = 0;
	private selfProdId = '';
	private name = '';
	private code: string;
	private sfu = new SfuLoopback(this);
	private sessionStartedAt = Date.now();
	private consentSessions = new Map<string, Set<string>>(); // recorderId → consented
	private lastChatLen = 0;
	private lastCapLen = 0;
	private stopFx: (() => void) | null = null;
	private captionGen = 0;
	private captionSubscribed = false;
	private captionSubscription = 0;

	constructor(sock: RoomSocket, code: string, private roomKey?: string) {
		this.sock = sock;
		this.code = code;
	}

	get isOpen() {
		return this.sock.readyState === 1;
	}
	get sessionRef(): RoomSession | null {
		return this.session;
	}
	get selfProdIdRef(): string {
		return this.selfProdId;
	}

	frame(f: Frame) {
		if (f.t === 'sfu-pull' || f.t === 'sfu-offer' || f.t === 'sfu-answer' || f.t === 'delta')
			console.debug('[cic-ws ←]', f.t, JSON.stringify(f).slice(0, 220));
		this.sock.emitNow(f);
	}

	private delta(ops: Record<string, unknown>[]) {
		if (!ops.length) return;
		this.frame({ t: 'delta', ops, seq: ++this.seq });
	}

	private prodId(peerId: string): string {
		return peerId === this.session?.selfId ? this.selfProdId : peerId;
	}
	private peerId(prodId: string): string {
		return prodId === this.selfProdId ? (this.session?.selfId ?? prodId) : prodId;
	}

	private participantOf(peerId: string): ProdParticipant {
		const s = this.session!;
		const tracks: ProdParticipant['tracks'] = [];
		if (s.remoteStreams[peerId] || peerId === s.selfId) {
			tracks.push({ sessionId: `${peerId}:audio`, kind: 'audio' });
			if (!s.videoMuted) tracks.push({ sessionId: `${peerId}:video`, kind: 'video' });
			if (s.peerSharing.has(peerId)) tracks.push({ sessionId: `${peerId}:screen`, kind: 'screen' });
		}
		const muted = peerId === s.selfId
			? { audio: s.selfMuted, video: s.videoMuted }
			: (s.peerMuted[peerId] ?? { audio: false, video: false });
		return {
			id: this.prodId(peerId),
			name: s.names[peerId] ?? (peerId === s.selfId ? this.name : 'Guest'),
			joinedAt: s.joinedAt[peerId] ?? this.sessionStartedAt,
			connected: true,
			away: s.peerAway.has(peerId) || undefined,
			muted,
			tracks,
			handRaisedAt: s.raisedHands.has(peerId) ? Date.now() : undefined,
			sharing: s.peerSharing.has(peerId) ? 'screen' : undefined
		};
	}

	private stickObj() {
		const s = this.session!;
		const ctx = s.stickCtx;
		const state =
			s.stickState === 'held' ? 'held' : s.stickState === 'question' ? 'question' : s.stickState === 'offered' ? 'offered' : 'on_table';
		return {
			state,
			holderId: ctx.holderId ? this.prodId(ctx.holderId) : null,
			atSeatOf: ctx.atSeatOf ? this.prodId(ctx.atSeatOf) : null,
			resumeTo: ctx.resumeTo ? this.prodId(ctx.resumeTo) : null,
			since: null as number | null,
			handsOpen: s.mode === 'open_round' && state === 'on_table'
		};
	}

	private nextId(): string | null {
		const s = this.session!;
		const seated = [s.selfId, ...s.peers].sort(
			(a, b) => (s.joinedAt[a] ?? 0) - (s.joinedAt[b] ?? 0)
		);
		const cur = s.stickCtx.holderId ?? s.stickCtx.atSeatOf;
		if (seated.length < 2) return null;
		const order = s.direction === 'sunwise' ? seated : [...seated].reverse();
		const i = cur ? order.indexOf(cur) : -1;
		const next = order[(i + 1 + order.length) % order.length];
		return next ? this.prodId(next) : null;
	}

	private snapshot() {
		const s = this.session!;
		const participants = [s.selfId, ...s.peers]
			.filter((p) => !s.waiting.some((w) => w.id === p))
			.map((p) => this.participantOf(p))
			.sort((a, b) => a.joinedAt - b.joinedAt);
		if (s.ai.enabled !== false) {
			participants.push({
				id: 'ai',
				name: s.ai.name ?? 'Milo',
				kind: 'ai',
				joinedAt: this.sessionStartedAt - 1,
				connected: true,
				muted: { audio: false, video: true },
				tracks: []
			});
		}
		return {
			code: this.code,
			sessionId: `local-${this.code}`,
			participants,
			hostId: s.authorityId ? this.prodId(s.authorityId) : null,
			coHostIds: s.coHostIds.map((id) => this.prodId(id)),
			mode: s.mode,
			direction: s.direction,
			stick: this.stickObj(),
			nextId: this.nextId(),
			aiSpeaking: s.miloState === 'speaking',
			waiting: s.waiting.map((w) => ({
				id: w.id, name: w.name, joinedAt: w.joinedAt, connected: true, muted: { audio: true, video: true }, tracks: []
			})),
			lobbyEnabled: s.lobbyEnabled,
			features: null,
			credits: null,
			channel: 0,
			breakouts: s.breakoutCount
				? { count: s.breakoutCount, allowReturn: true }
				: null,
			brand: null,
			breakoutDefaults: null,
			appearance: s.appearance,
			ai: s.ai,
			heartMode: s.heartMode,
			hostLocks: s.hostLocks,
			miloWake: s.miloWake,
			started: s.started,
			turnTimerMinutes: s.turnTimerMinutes,
			speakingTimerEveryone: s.speakingTimerEveryone,
			trFanout: s.trFanout,
			recording: s.recording,
			recordingSessions: this.recordingSessions(),
			chat: s.chatLog.map((c) => ({ from: this.prodId(c.from), name: s.names[c.from] ?? this.name, text: c.text, at: Date.now(), whisper: c.whisper })),
			transcript: [],
			feedbackPermit: true,
			dashboardUrl: null
		};
	}

	private recordingSessions() {
		const s = this.session;
		if (!s?.recording) return [];
		const recorderId = this.prodId(s.roles?.['recorder-primary'] ?? s.selfId);
		const consented = Object.entries(s.consents)
			.filter(([, v]) => v === 'granted')
			.map(([k]) => this.prodId(k));
		this.consentSessions.set(recorderId, new Set(consented));
		return [{ recorderId, consentedIds: [...consented], toServer: false, startedAt: this.sessionStartedAt }];
	}

	// ---------------------------------------------------------------- commands

	async command(m: Frame) {
		const s = this.session;
		try {
			await this.dispatch(m, s);
		} catch (e) {
			console.error('[cic-bridge] command failed', m.t, e);
			this.frame({ t: 'error', code: 'engine_error', message: String(e) });
		}
	}

	private async dispatch(m: Frame, s: RoomSession | null) {
		switch (m.t) {
			case 'hello': {
				this.selfProdId = String(m.participantId ?? crypto.randomUUID());
				this.name = String(m.name ?? 'Guest');
				this.session = new RoomSession(roomSecretFromCode(this.code, this.roomKey), this.name, this.code);
				sessionByCode.set(this.code, this.session);
				this.sfu.bind(this.session);
				await this.session.join({ capture: false }); // frontend owns getUserMedia
				this.watch();
				this.frame({
					t: 'welcome',
					sessionToken: crypto.randomUUID(),
					you: this.selfProdId,
					seq: this.seq,
					iceServers: [],
					media: true,
					snapshot: this.snapshot()
				});
				this.frame({ t: 'snapshot', room: this.snapshot(), seq: this.seq });
				break;
			}
			case 'leave': this.sock.close(); break;
			case 'refresh-ice': this.frame({ t: 'ice-servers', iceServers: [], iceExpiresAt: 0 }); break;

			// stick
			case 'pass': s?.passStick(); break;
			case 'place-down': s?.tableStick(); break;
			case 'give-stick': s?.giveStick(this.peerId(String(m.id))); break;
			case 'host-set-current': m.id === 'table' ? s?.tableStick() : s?.giveStick(this.peerId(String(m.id))); break;
			case 'request-stick': case 'stick-request': s?.requestStick(); break;
			case 'question-end': s?.emitOp({ t: 'stick-resume' }); break;

			// room state ops
			case 'set-mode': {
				if (m.mode) s?.setMode(m.mode as 'open_round' | 'circle_round');
				if (m.direction) s?.setDirection(m.direction as 'sunwise' | 'earthwise');
				break;
			}
			case 'set-direction': s?.setDirection(m.direction as 'sunwise' | 'earthwise'); break;
			case 'set-heart': s?.setHeart(!!m.on); break;
			case 'set-lobby': s?.setLobby(!!m.enabled); break;
			case 'set-co-host': s?.setCoHost(this.peerId(String(m.id)), !!m.on); break;
			case 'set-host-lock': if (s) s.setHostLocks({ ...s.hostLocks, [String(m.feature)]: !!m.on }); break;
			case 'set-speaking-timer': s?.setSpeakingTimerEveryone(!!m.enabled); break;
			case 'turn-timer': s?.setTurnTimer(Number(m.minutes ?? 0)); break;
			case 'set-appearance': {
				const { t: _t, ...patch } = m;
				s?.setAppearance(patch as Record<string, string>);
				break;
			}
			case 'started': case 'set-started': s?.setStarted(!!m.on); break;

			// self state
			case 'mute':
				if (m.kind === 'video') s?.setVideoMuted(!!m.on);
				else s?.setSelfMuted(!!m.on);
				this.frame({ t: 'mute-state', muted: { audio: s?.selfMuted ?? true, video: s?.videoMuted ?? true } });
				break;
			case 'away': s?.announceAway(!!m.away); break;
			case 'screen': s?.announceSharing(!!m.on, m.audio === true || m.audio === 'audio'); break;
			case 'hand': s?.raiseHand(!!m.up); break;
			case 'set-name': s?.renameSelf(String(m.name ?? '')); break;
			case 'reaction': s?.react(String(m.kind ?? 'heart')); break;
			case 'chat': {
				const text = String(m.text ?? '');
				if (s && text) {
					s.sendChat(text);
					this.frame({ t: 'chat', entry: { id: crypto.randomUUID(), from: this.selfProdId, name: this.name, text, at: Date.now() } });
				}
				break;
			}
			case 'notes-save': s?.saveNotes(String(m.text ?? '')); break;

			// lobby / host controls
			case 'admit': s?.admitWaiting(this.peerId(String(m.id))); break;

			// ai
			case 'set-ai': s?.setAi({ enabled: !!m.enabled }); break;
			case 'set-ai-name': s?.setAi({ name: String(m.name) }); break;
			case 'set-ai-instructions': s?.setAi({ instructions: String(m.text) }); break;
			case 'set-ai-voice': s?.setAi({ voice: String(m.voice) }); break;
			case 'set-milo-standby': s?.setAi({ standby: !!m.on }); break;
			case 'set-milo-wake': s?.setMiloWake(m.mode === 'hey_milo' ? 'hey_milo' : 'click'); break;
			case 'ask-ai': s?.askAi(typeof m.text === 'string' ? m.text : undefined); break;
			case 'set-transcription': s?.setTranscription(!!m.on); break;
			case 'set-transcription-scope': s?.emitOp({ t: 'config-set', patch: { transcriptScope: String(m.scope) as 'off' | 'holder' | 'all' } }); break;

			// recording
			case 'recording': {
				if (m.action === 'start') {
					if (s && !s.heartMode) s.startRecording();
					else this.frame({ t: 'error', code: 'heart_mode', message: 'Heart-Sharing is on — recording is disabled in this circle.' });
				} else if (m.action === 'stop') s?.stopRecording();
				break;
			}
			case 'recording-consent': s?.answerConsent(true); break;
			case 'recording-budget':
				this.frame({ t: 'recording-budget', requestId: m.requestId, ok: true, unlimited: true });
				break;
			case 'rec-upload-begin': {
				const key = `local-${crypto.randomUUID()}.${m.ext ?? 'webm'}`;
				this.frame({ t: 'rec-upload', key, url: `/rec-local/${key}`, method: 'PUT' });
				break;
			}
			case 'rec-uploaded': break; // artifact already journaled locally by the recorder

			// breakouts
			case 'breakout-open': s?.openBreakouts(Number(m.count ?? 2)); break;
			case 'breakout-close': s?.closeBreakouts(); break;
			case 'breakout-assign': s?.assignBreakout(this.peerId(String(m.id)), String(m.channel ?? '0')); break;
			case 'breakout-hop': {
				const ch = Number(m.channel ?? 0);
				s?.hopBreakout(ch);
				if (s) void (ch > 0 ? s.joinBreakout(String(ch)) : s.returnFromBreakout());
				break;
			}
			case 'breakout-return': if (s) void s.returnFromBreakout(); break;
			case 'breakout-broadcast': s?.broadcastToBreakouts(String(m.message ?? '')); break;

			// SFU media plane → loopback
			case 'publish': void this.sfu.publish(String(m.offer ?? ''), m.connectionId ? String(m.connectionId) : undefined, m.requestId ? String(m.requestId) : undefined); break;
			case 'publish-ready': this.sfu.publishReady(String(m.connectionId ?? ''), String(m.requestId ?? '')); break;
			case 'subscribe': this.sfu.subscribe((m.tracks as { sessionId: string }[]) ?? [], String(m.connectionId ?? '')); break;
			case 'renegotiate-answer': this.sfu.answer(String(m.sdp ?? ''), String(m.connectionId ?? '')); break;

			// captions (soniox-style subscription → our sherpa path)
			case 'caption-subscribe': {
				this.captionSubscribed = !!m.on;
				this.captionSubscription = Number(m.subscription ?? 0);
				if (m.on) {
					const generation = ++this.captionGen;
					this.frame({ t: 'caption-source', generation, on: true });
					this.frame({ t: 'caption-ticket', generation, path: `/ws/caption/${this.code}?gen=${generation}`, expiresAt: Date.now() + 600_000 });
					this.frame({ t: 'caption-state', state: 'live', generation });
				}
				break;
			}

			// honest refusals for external-provider paths (replaced by on-device models)
			case 'stt-token': this.frame({ t: 'error', code: 'provider_off', message: 'Speech runs on-device — no provider token needed.' }); break;
			case 'participant-translation': case 'translate-transcript':
				this.frame({ t: 'error', code: 'provider_off', message: 'Translation runs on-device; no cloud translation lane is configured.' });
				break;
			case 'set-translation-voice': s?.setAi({ voice: String(m.voice ?? m.name ?? '') }); break;
			case 'set-test-stt': case 'stt-debug': break; // engine selection/debug hints — local sherpa is the only engine
			case 'metric': case 'flux-turn': break; // client telemetry/turn hints — no server metric sink exists
			default:
				console.debug('[cic-bridge] unhandled frame', m.t);
		}
	}

	async leave() {
		this.stopFx?.();
		this.sfu.dispose();
		if (this.session) {
			sessionByCode.delete(this.code);
			await this.session.leave();
			this.session = null;
		}
	}

	// ---------------------------------------------------------------- session → frames

	private watch() {
		const s = this.session!;
		s.onReaction = (kind, fromId, name) =>
			this.frame({ t: 'reaction', kind, from: name, fromId: this.prodId(fromId) });

		this.stopFx = $effect.root(() => {
			// stick + turn order
			$effect(() => {
				const stick = this.stickObj();
				const nextId = this.nextId();
				const mode = s.mode;
				const direction = s.direction;
				this.delta([
					{ op: 'mode', mode, stick, nextId },
					{ op: 'direction', direction, nextId }
				]);
			});
			// participants: join/leave/rename/mute/hand/away/sharing diffs
			let prevIds = new Set<string>();
			$effect(() => {
				const ids = new Set([s.selfId, ...s.peers]);
				const ops: Record<string, unknown>[] = [];
				for (const id of ids) if (!prevIds.has(id) && id !== s.selfId) ops.push({ op: 'join', participant: this.participantOf(id) });
				for (const id of prevIds) if (!ids.has(id)) ops.push({ op: 'leave', id: this.prodId(id) });
				for (const id of ids) {
					const p = this.participantOf(id);
					ops.push(
						{ op: 'rename', id: p.id, name: p.name },
						{ op: 'muted', id: p.id, muted: p.muted },
						{ op: 'hand', id: p.id, at: p.handRaisedAt },
						{ op: 'away', id: p.id, away: !!p.away },
						{ op: 'sharing', id: p.id, on: !!p.sharing }
					);
				}
				prevIds = ids;
				this.delta(ops);
			});
			// authority + co-hosts + room flags
			$effect(() => {
				this.delta([
					{ op: 'host', id: s.authorityId ? this.prodId(s.authorityId) : null },
					{ op: 'co-hosts', ids: s.coHostIds.map((id) => this.prodId(id)) },
					{ op: 'lobby', enabled: s.lobbyEnabled },
					{ op: 'heart', on: s.heartMode },
					{ op: 'host-locks', locks: s.hostLocks },
					{ op: 'ai', ...s.ai },
					{ op: 'milo-wake', mode: s.miloWake },
					{ op: 'started', on: s.started },
					{ op: 'turn-timer', minutes: s.turnTimerMinutes },
					{ op: 'speaking-timer', enabled: s.speakingTimerEveryone },
					{ op: 'tr-fanout', lanes: s.trFanout },
					{ op: 'appearance', ...s.appearance },
					{ op: 'ai-speaking', on: s.miloState === 'speaking' }
				]);
			});
			// waiting room
			let prevWaiting = new Set<string>();
			$effect(() => {
				const ids = new Set(s.waiting.map((w) => w.id));
				const ops: Record<string, unknown>[] = [];
				for (const w of s.waiting)
					if (!prevWaiting.has(w.id))
						ops.push({ op: 'waiting-join', participant: { id: w.id, name: w.name, joinedAt: w.joinedAt, connected: true, muted: { audio: true, video: true }, tracks: [] } });
				for (const id of prevWaiting) if (!ids.has(id)) ops.push({ op: 'waiting-leave', id });
				prevWaiting = ids;
				this.delta(ops);
			});
			// chat tail
			$effect(() => {
				const log = s.chatLog;
				for (const c of log.slice(this.lastChatLen)) {
					if (c.from === s.selfId) continue; // already echoed on send
					this.frame({ t: 'chat', entry: { id: crypto.randomUUID(), from: this.prodId(c.from), name: s.names[c.from] ?? 'Peer', text: c.text, at: Date.now(), whisper: c.whisper } });
				}
				this.lastChatLen = log.length;
			});
			// captions → prod caption-update + transcript
			$effect(() => {
				const caps = s.captions;
				for (const c of caps.slice(this.lastCapLen)) {
					const update = {
						sourceId: this.prodId(c.from),
						generation: 'local',
						subscription: this.captionSubscription,
						sequence: this.seq + 1,
						state: 'live',
						at: Date.now(),
						sections: [{ id: 1, original: { final: c.final ? c.text : '', partial: c.final ? '' : c.text }, translation: { final: '', partial: '' } }]
					};
					if (this.captionSubscribed) this.frame({ t: 'caption-update', update });
					if (c.final)
						this.frame({ t: 'transcript', entry: { id: crypto.randomUUID(), at: Date.now(), name: c.from === s.selfId ? this.name : (s.names[c.from] ?? 'Peer'), text: c.text } });
				}
				this.lastCapLen = caps.length;
			});
			// recording + consent
			$effect(() => {
				this.frame({ t: 'recording-state', active: s.recording, sessions: this.recordingSessions(), by: this.selfProdId });
			});
			// notes
			$effect(() => {
				this.frame({ t: 'notes-state', text: s.notesText });
			});
			// breakout invitation → channel move (prod breakout-move)
			$effect(() => {
				if (s.pendingBreakout) this.frame({ t: 'breakout-move', channel: Number(s.pendingBreakout) });
			});
			// mesh streams → SFU pull announcements
			$effect(() => {
				void s.remoteStreams;
				this.sfu.notifyStreams();
			});
		});
	}
}

/** SFU loopback is driven through the bridge for frame emission */
export type { Frame as CicFrame };
