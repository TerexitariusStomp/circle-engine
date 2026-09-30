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
	recording = $state(false);
	e2eeActive = $state(false);
	remoteStreams = $state<Record<string, MediaStream>>({});
	localMedia: LocalMedia | null = null;

	private heartbeat = 0;

	constructor(
		public roomSecret: string,
		public displayName: string,
		public roomCode: string
	) {
		this.identity = createIdentity('');
		this.handle = openRoom(roomSecret);
		this.e2ee = new E2EESession(this.handle, roomSecret);
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
			this.handle.sendRealtime({
				t: 'hello',
				name: displayName,
				cap: [bytesToHex(this.identity.publicKey)]
			});
			this.syncSeats();
			void this.rotateKeys();
		});
		this.handle.onPeerLeave((peerId) => {
			this.peers = this.peers.filter((p) => p !== peerId);
			delete this.remoteStreams[peerId];
			dropPeerKey(peerId);
			this.syncSeats();
			void this.rotateKeys();
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
	}

	private async rotateKeys() {
		// chain keys derive locally from the room secret — no key announcements needed
		await this.e2ee.onMembership([this.selfId, ...this.peers]);
		this.e2eeActive = this.e2ee.active;
	}

	private onRealtime(msg: RealtimeMessage, peerId: string) {
		switch (msg.t) {
			case 'hello':
				this.names[peerId] = msg.name;
				if (msg.cap[0]) registerPeerKey(peerId, msg.cap[0]);
				break;
			case 'chat':
				this.chatLog = [...this.chatLog, { from: peerId, text: msg.text, whisper: !!msg.whisperTo }];
				break;
			case 'caption-update':
				this.captions = [...this.captions.slice(-50), { from: peerId, text: msg.text, final: msg.final }];
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
			cap: [bytesToHex(this.identity.publicKey)]
		});
		this.caps[this.selfId] = await measureCapability(this.selfId);
		this.syncSeats();
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
	startRecording() { this.emitOp({ t: 'recording-start' }); }
	stopRecording() { this.emitOp({ t: 'recording-stop' }); }
	endRoom() { this.emitOp({ t: 'room-end' }); }

	sendChat(text: string, whisperTo?: string) {
		this.handle.sendRealtime({ t: 'chat', text, whisperTo });
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
		await this.recorder.stop();
		this.notes.destroy();
		this.localMedia?.stop();
		this.e2ee.dispose();
		this.stick.stop();
		return this.handle.leave();
	}
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
