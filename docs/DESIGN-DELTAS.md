# Design Deltas — where this build intentionally departs from the original spec

1. **Zero server runtime** (was: CF Worker/DO for rendezvous/admission/checkpoints).
   Rendezvous = Trystero public relays. Admission = client-side approval.
   Checkpoints = peer-replicated encrypted state.
2. **Recording survives the host** (was: capture dies with recorder client).
   `recorder-primary` + `recorder-standby` roles on separate devices; explicit
   end-recording/end-room/last-peer ops are the only terminators.
3. **Milo is an elected role** (was: host-bound or cloud function).
   `milo-brain`/`milo-voice` auctioned to the most capable device(s), failover
   via lease+epoch. wllama inference, sherpa-onnx TTS — local by default.
4. **E2EE by default** (was: optional/off). SFrame pairwise keys; visible
   downgrade badge only, never silent.
5. **Scale via topology, not SFU** (was: CF Realtime for >12 seats).
   mesh ≤12 → active-set ≤30 → peer-assisted stage ≤60+/audience. CF SFU
   exists only as paid gap-filler (cic-cloud), client-first always.
6. **Paid tier is additive** (B.14): client resources primary; Cloudflare
   engages only per-deficiency (NAT relay, oversized room, durable capture).
   Entitlements = signed VC-JWT scope claims, verified offline.

## Entry surface (co-intelligence.online landing)

The entry page mirrors the deployed marketing page — structure, copy, palette
(ea-light: `#faf9f6` base, sand/sky/sage atmo blobs, feTurbulence grain), pill
buttons, capsule form, benefit cards with the production SVG icons, and the
brand logo — with these deliberate deviations:

7. **No email capture.** Production's "Request early access" capsule is
   re-purposed as the room-code join capsule (there is no backend to hold
   addresses — that is the product, not a limitation). "Log in" removed; no
   accounts exist. Steps rewritten for reality: Open → Invite → Gather.
8. **AA contrast floor.** Production ships `--ea-mute:#8f8f8f` on `#faf9f6`
   (3.07:1 — axe-serious). We keep it only for the 72px display heading (3:1
   legal for large text) and use `#6e6e6e` (≥4.5:1) for small muted text.
9. **Fonts**: entry surface uses Switzer Variable + Caveat + EB Garamond
   variable (self-hosted copies of the deployed woff2 files); the room app
   keeps Lato + EB Garamond exactly as deployed.
10. **Brand**: `logo-b.svg`, `symbol-light.png` (512), `favicon.png` (64),
    `og.png`, `manifest.webmanifest` copied verbatim from the deployed origin
    (icon URLs repointed to local paths — no `/api/site-brand` exists here).
