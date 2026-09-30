import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * Participant identity — ephemeral Ed25519 signing keypair per room session.
 * Opaque participant ID = hex(sha256(pubkey))[:16]; signatures authenticate ops.
 */

export interface Identity {
	peerId: string; // opaque participant id
	publicKey: Uint8Array;
	sign(payload: Uint8Array): string; // hex sig
	verify(peerId: string, payload: Uint8Array, sigHex: string): boolean;
}

const pubkeys = new Map<string, Uint8Array>(); // peerId -> pubkey (from hello announcements)

export function createIdentity(peerId: string): Identity {
	const secretKey = ed25519.utils.randomSecretKey();
	const publicKey = ed25519.getPublicKey(secretKey);
	pubkeys.set(peerId, publicKey);
	return {
		peerId,
		publicKey,
		sign: (payload) => bytesToHex(ed25519.sign(payload, secretKey)),
		verify: (id, payload, sigHex) => {
			const pk = pubkeys.get(id);
			return pk ? ed25519.verify(hexToBytes(sigHex), payload, pk) : false;
		}
	};
}

export function registerPeerKey(peerId: string, pubkeyHex: string) {
	pubkeys.set(peerId, hexToBytes(pubkeyHex));
}
export function dropPeerKey(peerId: string) {
	pubkeys.delete(peerId);
}

export function participantId(pubkey: Uint8Array): string {
	return bytesToHex(sha256(pubkey)).slice(0, 24);
}

/** canonical op payload for signing — deterministic JSON, no whitespace */
export function canonicalBytes(obj: unknown): Uint8Array {
	return utf8ToBytes(stableStringify(obj));
}

function stableStringify(v: unknown): string {
	if (v === null || typeof v !== 'object') return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
	const o = v as Record<string, unknown>;
	return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

/** derive per-purpose keys from the room secret — never stored, never transmitted */
export function roomKey(roomSecret: string, purpose: string): Uint8Array {
	return hkdf(sha256, utf8ToBytes(roomSecret), undefined, utf8ToBytes(`cic:${purpose}`), 32);
}
