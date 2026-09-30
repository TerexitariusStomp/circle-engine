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
