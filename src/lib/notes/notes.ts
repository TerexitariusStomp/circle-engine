import * as Y from 'yjs';
import type { RoomHandle } from '../net/room';

/**
 * Collaborative notes — Yjs document synced over the room's data channel.
 * No server, no awareness provider: updates broadcast to peers, peers reply
 * with their pending deltas on join (state-vector exchange).
 */

export class NotesDoc {
	doc = new Y.Doc();
	get text() {
		return this.doc.getXmlFragment('notes');
	}
	onRemoteUpdate: (() => void) | null = null;

	constructor(room: RoomHandle) {
		const [sendSync, onSync] = room.makeAction<Uint8Array>('yjs-sync');
		const [sendUpdate, onUpdate] = room.makeAction<Uint8Array>('yjs-upd');

		this.doc.on('update', (update: Uint8Array, origin: unknown) => {
			if (origin !== 'remote') void sendUpdate(update);
		});

		onUpdate((update: Uint8Array) => {
			Y.applyUpdate(this.doc, update, 'remote');
			this.onRemoteUpdate?.();
		});
		onSync((sv: Uint8Array, peerId: string) => {
			const diff = Y.encodeStateAsUpdate(this.doc, sv);
			if (diff.byteLength > 2) void sendUpdate(diff, peerId);
		});

		room.onPeerJoin((peerId) => {
			sendSync(Y.encodeStateVector(this.doc), peerId);
		});
	}

	destroy() {
		this.doc.destroy();
	}
}
