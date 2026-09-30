import {
	FrameCryptor,
	newIdentity,
	supportsSFrame,
	computeSas,
	buildPeerIndexMap,
	type PeerIndex,
	type SasData,
	type EpochParams
} from 'sframe-ratchet';
import { SimpleKex } from 'sframe-ratchet/kex-simple';
import type { RoomHandle } from '../net/room';

/**
 * E2EE via SFrame (RFC 9605) — sframe-ratchet owns the frame crypto and the
 * insertable-streams worker; SimpleKex derives epoch chain keys from the room
 * secret (entropy lives in the URL fragment — never transmitted).
 *
 * Membership change -> epoch++ -> rotateEpoch -> setEpoch on every cryptor.
 * Authority peer cannot decrypt: media keys derive from the room secret, which
 * all peers hold equally — there is no privileged decryption position.
 *
 * Unsupported browser -> active=false -> UI shows "not E2EE". Never silent.
 */

export class E2EESession {
	readonly supported = supportsSFrame();
	private kex: SimpleKex;
	private cryptors = new Map<string, FrameCryptor>();
	private worker?: Worker;
	private chainKey: Uint8Array | null = null;
	private peerIndexMap: Record<string, PeerIndex> = {};
	private _epoch = -1;
	active = false;

	constructor(
		private room: RoomHandle,
		roomSecret: string
	) {
		this.kex = new SimpleKex({
			sharedSecret: roomSecret,
			// acknowledged: SimpleKex has no forward secrecy — RoomRatchet (MLS-style
			// wrapped epochs) is the hardened upgrade path tracked in docs/SECURITY-MODEL.md
			acknowledgeInsecure: true
		});
		newIdentity(room.selfId); // session identity available for SAS/verify flows
		if (this.supported) {
			this.worker = new Worker(new URL('sframe-ratchet/worker', import.meta.url), { type: 'module' });
		}
	}

	get epoch() {
		return this._epoch;
	}

	/** (re)key for the current membership set. Deterministic on every client. */
	async onMembership(peerIds: string[]) {
		if (!this.supported) return;
		const ids = [...peerIds].sort();
		const nextEpoch = this._epoch + 1;
		this.chainKey =
			this._epoch < 0 || this.chainKey === null
				? await this.kex.initialEpoch()
				: this.kex.rotateEpoch(this.chainKey, nextEpoch);
		this.peerIndexMap = buildPeerIndexMap(ids);
		this._epoch = nextEpoch;

		const params: EpochParams = {
			epoch: this._epoch,
			peerIndexMap: this.peerIndexMap,
			chainKey: this.chainKey
		};
		for (const c of this.cryptors.values()) await c.setEpoch(params);
		this.active = true;
	}

	attachSender(peerId: string, sender: RTCRtpSender) {
		if (!this.supported || !this.worker || !this.chainKey) return;
		const c = new FrameCryptor({
			worker: this.worker,
			role: 'sender',
			peerId,
			peerIndex: this.peerIndexMap[this.room.selfId] ?? 0
		});
		void c.setEpoch({ epoch: this._epoch, peerIndexMap: this.peerIndexMap, chainKey: this.chainKey });
		c.attachSender(sender);
		this.cryptors.set(`s:${peerId}`, c);
	}

	attachReceiver(peerId: string, receiver: RTCRtpReceiver) {
		if (!this.supported || !this.worker || !this.chainKey) return;
		const c = new FrameCryptor({
			worker: this.worker,
			role: 'receiver',
			peerId,
			peerIndex: this.peerIndexMap[peerId] ?? 0
		});
		void c.setEpoch({ epoch: this._epoch, peerIndexMap: this.peerIndexMap, chainKey: this.chainKey });
		c.attachReceiver(receiver);
		this.cryptors.set(`r:${peerId}`, c);
	}

	/** SAS emoji fingerprint over the epoch chain key for MITM verify UI */
	sas(): Promise<SasData> {
		if (!this.chainKey) return Promise.reject(new Error('no epoch yet'));
		return computeSas(this.chainKey);
	}

	dispose() {
		for (const c of this.cryptors.values()) c.detach();
		this.cryptors.clear();
		this.worker?.terminate();
		this.chainKey?.fill(0);
		this.active = false;
	}
}
