// MQTT strategy: 3 public brokers, redundancy=4 → peers share a broker reliably.
// Nostr's default relay pool fragmented discovery in e2e runs.
import { joinRoom, selfId, type Room, type ActionReceiver } from 'trystero/mqtt';
import { opEnvelope, realtimeMessage, type Op, type OpEnvelope, type RealtimeMessage } from '../wire/messages';

/**
 * Trystero transport adapter — the entire networking surface.
 * Rendezvous over public Nostr relays by default; strategy is swappable.
 * Media (WebRTC) and data channels both ride this connection.
 */

const trysteroConfig = { appId: 'co-intelligence-circle' };

export interface RoomHandle {
	selfId: string;
	sendOp: (op: Op, sig: string, roomEpoch: number) => void;
	sendRealtime: (msg: RealtimeMessage) => void;
	onOp: ActionReceiver<OpEnvelope>;
	onRealtime: ActionReceiver<RealtimeMessage>;
	makeAction: Room['makeAction'];
	onPeerJoin: (fn: (peerId: string) => void) => void;
	onPeerLeave: (fn: (peerId: string) => void) => void;
	onPeerStream: (fn: (stream: MediaStream, peerId: string) => void) => void;
	addStream: (stream: MediaStream) => void;
	removeStream: (stream: MediaStream) => void;
	leave: () => Promise<void>;
	raw: Room;
}

/** trystero's onPeer* setters are last-write-wins — wrap them as additive sets */
function mkListenerSet<A extends unknown[]>(set: (fn: (...args: A) => void) => void) {
	const listeners = new Set<(...args: A) => void>();
	set((...args: A) => listeners.forEach((fn) => fn(...args)));
	return (fn: (...args: A) => void) => {
		listeners.add(fn);
	};
}

export function openRoom(roomSecret: string): RoomHandle {
	const room = joinRoom(trysteroConfig, roomSecret);

	const [sendOpRaw, onOp] = room.makeAction<OpEnvelope>('op');
	const [sendRt, onRealtime] = room.makeAction<RealtimeMessage>('rt');

	let seq = 0;
	return {
		selfId,
		sendOp(op, sig, roomEpoch) {
			const envelope = opEnvelope.parse({
				v: 1, t: 'op', opId: crypto.randomUUID(), roomEpoch,
				senderId: selfId, sentAt: seq++, op, sig
			});
			sendOpRaw(envelope);
		},
		sendRealtime(msg) {
			sendRt(realtimeMessage.parse(msg));
		},
		onOp,
		onRealtime,
		makeAction: room.makeAction,
			onPeerJoin: mkListenerSet(room.onPeerJoin),
		onPeerLeave: mkListenerSet(room.onPeerLeave),
		onPeerStream: mkListenerSet(room.onPeerStream),
		addStream: (s) => room.addStream(s),
		removeStream: (s) => room.removeStream(s),
		leave: () => room.leave(),
		raw: room
	};
}

/** room secret derivation: URL fragment carries entropy; never sent anywhere */
export function roomSecretFromCode(code: string, fragmentKey?: string): string {
	return `cic:${code}${fragmentKey ? `:${fragmentKey}` : ''}`;
}
