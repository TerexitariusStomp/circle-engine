# CIC Protocol — Ground Truth

Message and state vocabulary extracted from the deployed production bundle
(`site-mirrors/cic-app`, SvelteKit immutable chunks, 2026-09). These names are
the wire contract our implementation must remain compatible with.

## Confirmed message types (verbatim strings in production JS)

| Category | Observed names |
|---|---|
| Presence | `hello`, `welcome`, `join`, `join-room`, `leave`, `admit`, `admitted`, `lobby`, `participant` |
| Stick/round | `round`, `stick`, `open-throw`, `question`, `hand-*` (implied), `seat` fields |
| Chat/notes | `chat`, `note`, `notes`, `notes-state`, `notes-save`, `reaction`, `whisper` |
| Captions | `captions`, `caption-ticket`, `caption-subscribe`, `caption-state`, `caption-source`, `caption-source-ready`, `caption-source-failed`, `caption-update`, `caption-clear`, `caption-capture`, `caption-capability`, `caption-audio`, `caption-audio-stop` |
| Transcript | `transcript`, `transcription`, `transcript-line-flash`, `transcript-translated`, `participant-translation` |
| Recording | `recording`, `recording-state`, `recording-consent`, `recording-ready`, `recordings`, `recorder`, `rec-upload`, `rec-upload-begin`, `rec-uploaded`, `rec-server`, `opfs`, `recording-budget`, `recording-purchase`, `recording-choice-title` |
| Breakouts | `breakouts`, `breakout-open`, `breakout-assign`, `breakout-hop`, `breakout-move`, `breakout-close`, `breakout-return`, `breakout-broadcast` |
| Milo | `milo`, `milo-wake` |
| Room | `room-defaults`, `room-controls-panel`, `snapshot`, `delta`, `mute`, `unmute`, `mute-state`, `muted`, `grant`, `sfu` |
| WebRTC internals | `offer`, `answer`, `candidate-pair` |
| Provider backends | `openai`, `deepgram`, `gemini` (CSP-confirmed) |

## Confirmed state fields

`stick.holderId`, `stick.atSeatOf`, `stick.resumeTo`, `on_table`,
`circle_round`, `open_round`, `sunwise`, `earthwise`, `heartMode`,
`speakingTimerEveryone`, `canManageRoom`.

## Design tokens (deployed CSS, `0.B0NZKGKX.css`)

Fonts: Lato (sans), EB Garamond (serif), self-hosted woff2.
Themes: mist `#f3f6f6`, deep `#181d23`, sand `#f7f1e6`.
Accent `#1abc9c`, fire `#d9823f`, radius 18px.
Full set: `design/tokens.json` (DTCG format).

## Production CSP (worth preserving)

`default-src 'self'`; `worker-src 'self' blob:`; `media-src 'self' blob: mediastream:`;
`object-src 'none'`; `script-src 'self' 'wasm-unsafe-eval'`.

## Deviations from production (intentional)

- Production uses server-side caption tickets + provider STT (Deepgram/OpenAI/Gemini in CSP).
  Ours: sherpa-onnx in-browser, zero provider calls.
- Production `rec-upload`/`rec-server` implies server recording path.
  Ours: `recorder-primary`/`recorder-standby` peer roles + OPFS journal, local export.
- Production ships a Cloudflare Insights beacon despite its own no-analytics comment.
  Ours: none.
