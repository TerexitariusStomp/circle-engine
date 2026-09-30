/**
 * SfuLoopback — the SFU node, in-browser. The production frontend treats us
 * as its media server: it sends `publish` (SDP offer) / `subscribe` (track
 * list) over the room socket; we terminate those on a local RTCPeerConnection
 * pair and relay the tracks into the Trystero mesh (and back).
 *
 * Both PCs live in this page — host candidates connect over loopback
 * instantly, no STUN/TURN needed. This is real WebRTC negotiation, not a
 * simulation: codecs, DTLS, and RTP all actually run.
 */
import type { RoomSession } from '../state/room.svelte';

type Frame = Record<string, unknown>;
interface BridgeLike {
	frame(f: Frame): void;
	readonly isOpen: boolean;
}

const RTC_CFG: RTCConfiguration = { iceServers: [] }; // loopback — host candidates only

export class SfuLoopback {
	private pubPc: RTCPeerConnection | null = null;
	private pullPc: RTCPeerConnection | null = null;
	private pubConnectionId = '';
	private pendingRequestId = '';
	private wantedTracks = new Map<string, string>(); // sessionId -> kind
	private midToSession = new Map<string, string>();
	private published = new Set<string>(); // sessionIds already offered
	private renegotiating = false;
	private pendingOffer = false;

	constructor(private bridge: BridgeLike) {}

	private session: RoomSession | null = null;
	bind(session: RoomSession) {
		this.session = session;
	}

	// ---- publish leg: frontend offers its local mic/cam/screen to us ----
	publishReady(connectionId: string, requestId: string) {
		this.pubConnectionId = connectionId;
		this.pendingRequestId = requestId;
	}

	async publish(sdpOffer: string, connectionId?: string, requestId?: string) {
		if (!sdpOffer) return;
		this.pubConnectionId = connectionId ?? this.pubConnectionId;
		const pc = (this.pubPc ??= new RTCPeerConnection(RTC_CFG));

		pc.ontrack = (ev) => {
			// frontend's captured media — relay to the mesh
			this.session?.publishLocal(ev.streams[0] ?? new MediaStream([ev.track]));
		};
		pc.onicecandidate = () => {}; // candidates embedded in answer after gathering

		await pc.setRemoteDescription({ type: 'offer', sdp: sdpOffer });
		const answer = await pc.createAnswer();
		await pc.setLocalDescription(answer);
		await iceGathered(pc);
		this.bridge.frame({
			t: 'sfu-answer',
			sdp: pc.localDescription?.sdp ?? answer.sdp,
			connectionId: this.pubConnectionId,
			requestId: requestId ?? this.pendingRequestId
		});
	}

	// ---- pull leg: we offer the mesh's remote tracks to the frontend ----
	subscribe(tracks: { sessionId: string }[], connectionId: string) {
		for (const t of tracks) {
			const kind = t.sessionId.split(':')[1] ?? 'audio';
			this.wantedTracks.set(t.sessionId, kind);
		}
		void this.negotiatePull(connectionId);
	}

	answer(sdp: string, _connectionId: string) {
		void this.pullPc?.setRemoteDescription({ type: 'answer', sdp });
		this.renegotiating = false;
		if (this.pendingOffer) {
			this.pendingOffer = false;
			void this.negotiatePull(_connectionId);
		}
	}

	/** called by the bridge whenever session.remoteStreams changes */
	notifyStreams() {
		if (!this.session) return;
		const available = this.availableTracks();
		// tell the client which mesh tracks exist — it decides what to subscribe
		const fresh = available.filter((t) => !this.published.has(t.sessionId));
		if (fresh.length) {
			for (const t of fresh) this.published.add(t.sessionId);
			this.bridge.frame({ t: 'sfu-pull', tracks: available });
		}
		if (this.wantedTracks.size) void this.negotiatePull('');
	}

	private availableTracks(): { sessionId: string; kind: string; mid?: string }[] {
		const s = this.session;
		if (!s) return [];
		const out: { sessionId: string; kind: string }[] = [];
		for (const [peerId, stream] of Object.entries(s.remoteStreams)) {
			for (const track of stream.getTracks()) {
				out.push({ sessionId: `${peerId}:${track.kind}`, kind: track.kind });
			}
		}
		return out;
	}

	private async negotiatePull(connectionId: string) {
		if (this.renegotiating) {
			this.pendingOffer = true;
			return;
		}
		const s = this.session;
		if (!s) return;
		this.renegotiating = true;
		try {
			const pc = (this.pullPc ??= new RTCPeerConnection(RTC_CFG));
			// (re)attach the wanted tracks we actually have
			const have = new Map<string, MediaStreamTrack>();
			for (const [peerId, stream] of Object.entries(s.remoteStreams))
				for (const track of stream.getTracks()) have.set(`${peerId}:${track.kind}`, track);
			const existingSenders = new Set(pc.getSenders().map((sn) => sn.track));
			for (const [sessionId] of this.wantedTracks) {
				const track = have.get(sessionId);
				if (track && !existingSenders.has(track)) pc.addTrack(track, new MediaStream([track]));
			}
			const offer = await pc.createOffer();
			await pc.setLocalDescription(offer);
			await iceGathered(pc);
			// map m-lines → sessionIds so the client can demux
			const pulls = pc.getTransceivers().map((tr) => {
				const senderTrack = tr.sender.track;
				const sessionId = [...this.wantedTracks.keys()].find((sid) => have.get(sid) === senderTrack) ?? '';
				if (sessionId) this.midToSession.set(tr.mid ?? '', sessionId);
				return { sessionId, mid: tr.mid ?? undefined };
			});
			this.bridge.frame({
				t: 'sfu-offer',
				sdp: pc.localDescription?.sdp ?? offer.sdp,
				pulls,
				connectionId
			});
		} finally {
			this.renegotiating = false;
		}
	}

	dispose() {
		this.pubPc?.close();
		this.pullPc?.close();
		this.pubPc = this.pullPc = null;
		this.wantedTracks.clear();
		this.published.clear();
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
