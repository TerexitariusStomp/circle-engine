/**
 * SfuLoopback — the SFU node, in-browser. The production frontend treats us
 * as its media server over a SINGLE RTCPeerConnection: it sends `publish`
 * (SDP offer containing its mic/cam/screen transceivers) and `subscribe`
 * (wanted pull tracks); we answer publish and drive renegotiation offers for
 * pulls — all on one shared pc, so our offer m-lines must preserve the
 * transceiver order established by their publish offer.
 *
 * Both PCs live in this page — host candidates connect over loopback
 * instantly, no STUN/TURN needed. Received publish tracks are relayed into
 * the Trystero mesh; mesh streams are offered back as pull m-lines.
 */
import type { RoomSession } from '../state/room.svelte';

type Frame = Record<string, unknown>;
interface BridgeLike {
	frame(f: Frame): void;
	readonly isOpen: boolean;
}

const RTC_CFG: RTCConfiguration = { iceServers: [] }; // loopback — host candidates only

export class SfuLoopback {
	private pc: RTCPeerConnection | null = null;
	private wanted = new Map<string, { kind: string; trackName: string }>(); // sessionId -> pull request
	private negotiating = false;
	private pendingOffer = false;
	private session: RoomSession | null = null;
	private sentSessionIds = new Set<string>(); // announced in sfu-pull
	private pullMidSession = new Map<string, string>(); // mid -> sessionId (ours)

	constructor(private bridge: BridgeLike) {}

	bind(session: RoomSession) {
		this.session = session;
	}

	private ensurePc(): RTCPeerConnection {
		if (this.pc) return this.pc;
		const pc = new RTCPeerConnection(RTC_CFG);
		pc.ontrack = (ev) => {
			// frontend's captured media — relay to the mesh
			this.session?.publishLocal(ev.streams[0] ?? new MediaStream([ev.track]));
		};
		pc.onicecandidate = () => {}; // candidates embedded after gathering
		this.pc = pc;
		return pc;
	}

	// ---- publish leg: frontend offers its local mic/cam/screen to us ----
	publishReady(_connectionId: string, _requestId: string) {}

	async publish(sdpOffer: string, connectionId?: string, requestId?: string) {
		if (!sdpOffer) return;
		const pc = this.ensurePc();
		await pc.setRemoteDescription({ type: 'offer', sdp: sdpOffer });
		const answer = await pc.createAnswer();
		await pc.setLocalDescription(answer);
		await iceGathered(pc);
		this.bridge.frame({
			t: 'sfu-answer',
			sdp: pc.localDescription?.sdp ?? answer.sdp,
			connectionId,
			requestId
		});
		// pulls parked before publish now have a transport to ride
		if (this.wanted.size) void this.negotiatePull(connectionId ?? '');
	}

	// ---- pull leg: we offer mesh tracks to the frontend ----
	subscribe(tracks: { sessionId: string; trackName?: string; kind?: string; ownerId?: string }[], connectionId: string) {
		for (const t of tracks) {
			const kind = t.kind ?? t.sessionId.split(':')[1] ?? 'audio';
			this.wanted.set(t.sessionId, { kind, trackName: t.trackName ?? kind });
		}
		void this.negotiatePull(connectionId);
	}

	answer(sdp: string, _connectionId: string) {
		void this.pc?.setRemoteDescription({ type: 'answer', sdp });
		this.negotiating = false;
		if (this.pendingOffer) {
			this.pendingOffer = false;
			void this.negotiatePull(_connectionId);
		}
	}

	/** bridge calls this whenever session.remoteStreams changes */
	notifyStreams() {
		if (!this.session) return;
		const available = this.availableTracks();
		const fresh = available.filter((t) => !this.sentSessionIds.has(t.sessionId));
		if (fresh.length) {
			for (const t of fresh) this.sentSessionIds.add(t.sessionId);
			this.bridge.frame({ t: 'sfu-pull', tracks: fresh });
		}
		if (this.wanted.size) void this.negotiatePull('');
	}

	private trackFor(sessionId: string): MediaStreamTrack | null {
		const s = this.session;
		if (!s) return null;
		const [peerId, kind] = sessionId.split(':');
		const stream = s.remoteStreams[peerId];
		return stream?.getTracks().find((t) => t.kind === kind) ?? null;
	}

	private availableTracks(): { sessionId: string; trackName: string; kind: string; ownerId: string }[] {
		const s = this.session;
		if (!s) return [];
		const out = [];
		for (const [peerId, stream] of Object.entries(s.remoteStreams))
			for (const track of stream.getTracks())
				out.push({ sessionId: `${peerId}:${track.kind}`, trackName: track.kind, kind: track.kind, ownerId: peerId });
		return out;
	}

	private async negotiatePull(connectionId: string) {
		if (!this.pc) return; // no shared transport until publish arrives
		if (this.negotiating) {
			this.pendingOffer = true;
			return;
		}
		this.negotiating = true;
		try {
			const pc = this.pc;
			const senders = new Set(pc.getSenders().map((sn) => sn.track));
			for (const [sessionId] of this.wanted) {
				const track = this.trackFor(sessionId);
				if (track && !senders.has(track)) pc.addTrack(track, this.session!.remoteStreams[sessionId.split(':')[0]]);
			}
			const offer = await pc.createOffer();
			await pc.setLocalDescription(offer);
			await iceGathered(pc);
			const pulls = pc
				.getTransceivers()
				.filter((tr) => tr.sender.track && this.wanted.has(this.sessionIdForTrack(tr.sender.track)))
				.map((tr) => {
					const sessionId = this.sessionIdForTrack(tr.sender.track!);
					this.pullMidSession.set(tr.mid ?? '', sessionId);
					return { mid: tr.mid ?? '', ownerId: sessionId.split(':')[0], kind: tr.sender.track!.kind, sessionId };
				});
			this.bridge.frame({ t: 'sfu-offer', sdp: pc.localDescription?.sdp ?? offer.sdp, pulls, connectionId });
		} finally {
			this.negotiating = false;
		}
	}

	private sessionIdForTrack(track: MediaStreamTrack): string {
		const s = this.session;
		if (!s) return `:${track.kind}`;
		for (const [peerId, stream] of Object.entries(s.remoteStreams))
			if (stream.getTracks().includes(track)) return `${peerId}:${track.kind}`;
		return `:${track.kind}`;
	}

	dispose() {
		this.pc?.close();
		this.pc = null;
		this.wanted.clear();
		this.sentSessionIds.clear();
	}
}

async function iceGathered(pc: RTCPeerConnection): Promise<void> {
	if (pc.iceGatheringState === 'complete') return;
	await new Promise<void>((resolve) => {
		const check = () => {
			if (pc.iceGatheringState === 'complete') {
				pc.removeEventListener('icegatheringstatechange', check);
				resolve();
			}
		};
		pc.addEventListener('icegatheringstatechange', check);
		setTimeout(() => {
			pc.removeEventListener('icegatheringstatechange', check);
			resolve();
		}, 1500);
	});
}
