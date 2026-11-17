---
paths:
  - "src/utils/genesis-tools/actions/**"
  - "src/utils/genesis-tools/areas/**"
  - "src/utils/genesis-tools/capability/**"
  - "src/utils/genesis-tools/service/**"
  - "src/genesis-tools/commands/{action,config,request,serve}.ts"
  - "scripts/gen-genesis-tools-rpc-swift.ts"
  - "src/macos/GenesisTools/Sources/Host/RequestPresent.swift"
---

# GenesisTools actions

The frozen interface is in the main checkout's `.claude/plans/2026-11-17-GenesisToolsActions.md` and the build contract is `.claude/plans/specs/genesis-tools-actions/actions.v1.md`.

- Callers use `gt.<area>.<action>()`. Needs, ways, fixes and delivery choices belong in the area definition.
- An area adds itself by declaration merging and one entry in `areas/index.ts`. Shared code never imports a tool.
- Explain reads only. `--fresh` may report state, but never changes config, posts a request or builds the app.
- App, service, notification and terminal effects refuse test processes at their boundary. Tests inject isolated stores and peers.
- Persist request transitions by appending journal events. A terminal request cannot be answered or executed again.
- The service uses the shared RPC host and descriptor. Keep it asleep between calls and the idle-exit check; every call and wait has a deadline.
- Regenerate Swift and the wire fixtures together, then run the generator with `--check`.
