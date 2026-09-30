# circle-engine — Co-Intelligence Circle

Zero-server, client-only P2P video circle app. SvelteKit (adapter-static, `ssr=false`)
+ Trystero (WebRTC/DC via public relays) + XState (stick machine) + zod (wire protocol)
+ OPA-Wasm (policies) + sframe-ratchet (E2EE) + sherpa-onnx (speech) + wllama (Milo)
+ mediabunny (recording) + Yjs/TipTap (notes) + Dexie (OPFS journal).

## Commands
- `pnpm install` — pnpm 11; `pnpm-workspace.yaml` `allowBuilds` must stay (esbuild/msw/protobufjs).
- `pnpm check` / `pnpm test` / `pnpm build` — must all pass before done.
- `pnpm policy:build` — recompile `src/lib/policy/cic.rego` → `static/policy/cic.wasm` (needs `opa` CLI at ~/.local/bin/opa).
- `pnpm test:e2e` — Playwright, all three engines pass.
  Fedora WebKit workaround (Playwright ships Ubuntu-built WebKit): missing libs
  (icu74, libbacktrace0, libjxl 0.11→symlinked as 0.8, libjpeg.so.8) are extracted into
  `~/.cache/ms-playwright/webkit-*/minibrowser-wpe/lib/` — its wrapper script overwrites
  LD_LIBRARY_PATH, so libs MUST live there, not in a custom path. Run with
  `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1`. If Playwright updates webkit-*, re-copy
  libs into the new dir.

## Invariants (do not violate)
- No server code in `cic-core`. Static bundle only.
- `effectiveMuted = selfMuted OR autoMuted OR remotelyMuted` — no remote unmute, ever.
- E2EE is default-on via SFrame; unsupported browser → visible "not E2EE" badge, no silent downgrade.
- Room secret lives in URL `#fragment` — never sent to relays/servers.
- Ops are Ed25519-signed + epoch-fenced; policy denials (cic.rego) reject application.
- Recording/mic capture ends only on explicit ops or last-peer-leave.
- Message/state names must stay compatible with the deployed production bundle — see docs/PROTOCOL.md.

## Verification
`pnpm check && pnpm test && pnpm build && pnpm test:e2e` + gitleaks/semgrep clean.
