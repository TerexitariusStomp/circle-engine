# Discrepancies — spec vs production bundle vs this implementation

| # | Item | Production bundle | This implementation | Status |
|---|---|---|---|---|
| D1 | Stick fields `holderId`/`atSeatOf`/`resumeTo`/`on_table` | confirmed verbatim | same names, same semantics (stick.machine.ts) | aligned |
| D2 | `sunwise`/`earthwise` direction | confirmed | implemented via seat-order reversal | aligned |
| D3 | `circle_round`/`open_round` modes | confirmed | XState guards — pass is deterministic in circle_round | aligned |
| D4 | Captions via server tickets + Deepgram/OpenAI | confirmed (CSP) | sherpa-onnx WASM in-browser | deviation (privacy improvement) |
| D5 | Server recording (`rec-upload`, `rec-server`) | confirmed | peer recorder roles + OPFS | deviation (survivability improvement) |
| D6 | CF Insights beacon in shell | confirmed present | none | deviation (privacy improvement) |
| D7 | Lobby/`admit` flow | confirmed | planned (authority approval queue) | pending |
| D8 | `whisper` channel | confirmed | `chat.whisperTo` field, separate key pending | partial |
| D9 | `milo-wake` | confirmed | sherpa KWS planned | pending |
| D10 | `recording-purchase`/`recording-budget` | confirmed — paid path exists in prod | cic-cloud metering (B.14) | planned |
| D11 | `speakingTimerEveryone`, `heartMode`, `canManageRoom` | confirmed | in roomConfig schema | aligned |
| D12 | Two-step bypass prevention | not directly observable | structurally impossible in machine def | aligned |
