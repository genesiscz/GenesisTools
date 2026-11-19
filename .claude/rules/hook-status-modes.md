---
paths:
  - "src/agents/lib/hooks/diff/status/**"
  - "src/utils/fs/watch-driver/**"
  - "src/utils/genesis-tools/worktree/**"
  - "src/utils/git/hook-status.ts"
  - "src/utils/git/narrow-status.ts"
  - "src/utils/git/status-inventory.ts"
  - "src/genesis-tools/commands/worktree.ts"
  - "src/agents/commands/hooks-status-modes.ts"
  - "scripts/benchmarks/hooks/status-ab.ts"
  - "scripts/benchmarks/hooks/watch-driver-probe.ts"
---

# Status modes of the Bash diff hooks, watch drivers, the worktree service

Loaded by Claude Code when you read, write or edit the status seam of the diff hooks (`diff/status/`), a watch driver,
the worktree service, or their benchmarks. The user docs: `src/agents/README.md` ("Status modes") and
`src/genesis-tools/README.md` ("worktree"). Every agent session on this Mac runs the hook files from the main checkout
on each Bash call: build in a linked worktree, never leave the main checkout half edited.

- **A mode is one file and one table row.** `STATUS_MODES` in `diff/status/modes.ts` is the only place that maps a
  mode id to its module, and `armsFor` the only place that turns config into arms. A mode module exports a
  `StatusModeModule` (`primary`, `variants`); a mode gets only the config keys its code reads, under
  `diff.status.modes.<mode>`. No `if (mode === …)` outside the table module: a difference is a member.
- **A driver is one file and one table row.** `WATCH_DRIVERS` in `src/utils/fs/watch-driver/registry.ts`; the id type
  comes from the table's keys. A difference between drivers is a member of `WatchDriverFacts`, never a name compare.
  No driver module loads until `load()` runs, and a driver makes its client in `open`, never at module scope.
- **The default must not change.** With no `diff.status` key, the hooks run today's two status reads at today's two
  places, start no RPC, load no mode module but `git`, and spawn no new process (`gitOnly` returns `gitReads` at
  once). Prove it with `bun scripts/benchmarks/hooks/status-ab.ts --before <checkout of the base> --runs 9`: equal
  `gitSpawns` and `statusSpawns` in both arms.
- **`unavailable`, a timeout and an error are never an empty answer.** Each one means "use Git for this root now". An
  empty entry list is a real answer: nothing is dirty.
- **A watcher never supplies an entry.** Every status entry was printed by Git; a driver only names paths to ask Git
  about again. Never use Parcel's `writeSnapshot` and `getEventsSince` for a boundary (3 of 15 edits found), never
  Git's builtin fsmonitor daemon (it crashed on shutdown here), and never prune with `DEFAULT_IGNORE_PATTERNS`: a
  tracked file under `node_modules/` still matters to Git.
- **Nothing switches a mode by itself.** The gates in `diff/status/gates.ts` are data the report prints. Setting
  `diff.status.active` or turning shadow on in the real `~/.genesis-tools/agents/hooks.json` is the owner's act; a
  test or a benchmark writes a sandbox `hooks.json` under its own `GENESIS_TOOLS_HOME`.
- **An active mode other than `git` still reads the reference on a sampled call** (`shadow.every`), so it saves CPU
  only on the calls that are not sampled.
- **The benchmark.** `bun scripts/benchmarks/hooks/status-ab.ts --modes --runs 15` runs one arm per mode and driver
  on this checkout with its own service and a private Watchman daemon, and prints hook CPU, daemon CPU and spawns per
  arm and shape; `renderedFiles` must be equal across arms. `bun scripts/benchmarks/hooks/watch-driver-probe.ts
  --driver <id> --trials 200` checks one driver against a scratch repository and a linked worktree.
