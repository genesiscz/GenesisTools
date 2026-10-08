# Build, install and verify

| Goal | Command |
| --- | --- |
| Compile the shared package | `cd src/macos/GenesisKit && swift build` |
| Compile the app as installed | `cd src/macos/GenesisTools && swift build -c debug -Xswiftc -O --scratch-path .build/opt` |
| Install (build, sign, swap, reap) | `bun run app`; `bun run app:status` names the installed commit |
| Tests | `swift test` in GenesisTools and in GenesisKit |
| Off-screen picture | `GenesisTools --hub … --snapshot /tmp/cc/<…>/x.png` (see the app CLAUDE.md) |
| Bench | `GenesisTools --hub --bench <out.json> …` (measuring.md §4) |
| Widget preview | `bun scripts/build-widget-preview.ts` in its worktree, then restart the app |

After installing, check what runs: `ps -Ao pid,lstart,command | rg "MacOS/GenesisTools"`. An old face
keeps answering with old code (the app CLAUDE.md explains the reap). Then let the monitor run through
the scenario you changed and read every event it reports.

Background screenshots never take focus: `tools control screenshot --app <pid> --window "<title>" --path …`.
Do not scroll or click in the user's own windows unless they asked; prefer the bench or a scripted window.
