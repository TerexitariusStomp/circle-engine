# Security Model

Serverless architecture — there is no server to breach. The threat model is
peers, relays, and the user's own device.

## Invariants

1. **Mute sovereignty**: `effectiveMuted = selfMuted OR autoMuted OR remotelyMuted`.
   No remote op may force-open a microphone. Rejoin never un-mutes.
2. **E2EE default**: SFrame (sframe-ratchet, RFC 9605) over WebRTC insertable
   streams; pairwise X25519 sender keys, rotated on membership change.
   Authority peer cannot decrypt media. Unsupported browser → visible
   "not E2EE" badge, no silent downgrade.
3. **Signed op-log**: every state transition is an Ed25519-signed op validated
   by every client; epoch fencing rejects stale-epoch ops.
4. **Server-blind storage**: anything leaving the device (peer checkpoints,
   optional PDS/paid R2) is encrypted client-side; keys live in the room
   secret / URL fragment — never transmitted.
5. **Metadata minimization**: no cookies, no analytics, pseudonymous IDs,
   public relays see timing only. `privacyMax` mode routes media via
   forwarder peers (audience sees 1 peer IP). Tor is NOT viable for WebRTC;
   VPN/relay is the real path — documented honestly.
6. **CSP**: self-only scripts, wasm-scoped eval, self-hosted fonts, no
   third-party connections in the free path (matches production CSP).
7. **Erasure**: tombstone ops propagate deletion; departed peers' local
   copies are best-effort purged; transcript lines are hash-pinned.
8. **No secrets in repo** — enforced by gitleaks/trufflehog/semgrep gates.

## Trust boundaries

- **Rendezvous relays** (public Nostr/MQTT): see join timing + rough room
  occupancy. Mitigation: room-secret hashing, multi-strategy fallback.
- **Peers**: can always screen-record — disclosed, not preventable.
- **Authority peer**: schedules ops but cannot forge signatures or decrypt
  E2EE media; hostile authority → deterministic takeover on lease expiry.
