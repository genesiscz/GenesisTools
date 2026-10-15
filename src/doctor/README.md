# tools doctor

Diagnose and fix common macOS dev-machine problems — disk bloat, memory pressure, runaway processes, dev-cache cruft — with tiered safety and two renderers.

## Usage

    tools doctor                      # interactive TUI dashboard (default)
    tools doctor --plain              # linear clack flow (pipe-safe, CI-safe)
    tools doctor --only disk-space,memory
    tools doctor --thorough           # no time caps on deep scans
    tools doctor --dry-run            # show what would happen, change nothing
    tools doctor --json               # machine-readable output

## Subcommands

    tools doctor find --min-mb 500 --max-days 30   # ad-hoc "X files in last Y days bigger than Z"
    tools doctor log --since 7d                    # recent actions
    tools doctor stats --since 30d                 # rolled-up reclaim totals
    tools doctor wipe-cache                        # force next run to be fresh
    tools doctor cpu --window 3000                 # what burned CPU between two samples: busy-waits, stuck app faces
    tools doctor act delete-clone --analyzer temp-leaks --id <findingId> --method delete --yes   # one reclaim, no prompts

`cpu` is opt-in: it reads `ps -o cputime` twice, `--window` milliseconds apart, and lists every process that used at least `--threshold` percent of one core in between (default 25). Two readings of accumulated CPU time are exact where `pcpu` is a decaying average that smears an old spin and hides a fresh one. GenesisTools.app faces and `tools` processes are named as such, with the fix. It is not in the default `tools doctor` suite (that would sleep the window on every run). The static half of the same guard is `bun scripts/ci/lint-rules.ts` (timers under 100 ms, `sleepSync` in a loop, a Swift `.wait()` without a timeout).

## Disk analyzers

- `disk-space`: Downloads, Trash, Time Machine local snapshots, and files over 500 MB under `$HOME`. Large files are sized by **allocated** blocks (`st_blocks * 512`), never `st_size`. A VM or container disk (`Docker.raw`, `data.img.raw`, `swap.img`, `*.vmdk`, `*.qcow2`, anything under the Docker, OrbStack, Colima, Lima, UTM or Parallels data folders, the Photos library) and any file whose allocated size is far below its apparent size (sparse or compressed) is `blocked` with a reason and offers no action. Before 2026-10-13 the rule listed OrbStack's 926 GiB sparse `data.img.raw` first and moved it to the Trash on the TUI's first key.
- `dev-caches`: `node_modules` under the checkout roots (the folders one or two levels under `~` that directly hold git checkouts, plus `GENESIS_TOOLS_DEV_CACHE_ROOTS`; no folder names are assumed), Xcode DerivedData, simulators, Docker images (every call pinned to the context `docker context show` names; the prune removes dangling images only), package-manager caches, the Homebrew cache.
- `system-caches`: `~/Library/Caches` folders of 50 MB or more (Playwright and `*.ShipIt` are left to `app-bloat`, so no byte is listed twice), archived `/var/log` files.
- `temp-leaks`: leaked `code_sign_clone` app copies under `$(dirname $(getconf DARWIN_USER_TEMP_DIR))/X` (a clone is kept when it was born within 5 s before to 60 s after a running main process of its app started, or is younger than 10 minutes; the finding names the off switch `--disable-features=MacAppCodeSignClone` and "close automation Chrome with Browser.close, never a signal"), stale agent scratch `<root>/<project>/<session>` (only when `GENESIS_TOOLS_AGENT_SCRATCH_ROOT` names the root; 3 days, live sessions and git checkouts or worktrees left out), git worktrees in that scratch (report only: remove them with `tools hub worktrees remove`), moved-aside leftovers (GenesisTools' own `/tmp/<date>-agents-removals`, plus the `/tmp` names in `GENESIS_TOOLS_MOVED_ASIDE_GLOBS`), old `$TMPDIR` entries grouped by name prefix (1 day for GenesisTools-owned prefixes, 3 days otherwise), and SwiftPM `.build` copies outside the primary checkout.
- `app-bloat`: the Claude Desktop VM disks and caches, old `cursor-agent` versions, Cursor state of deleted projects and `CachedData`, Cursor's live `state.vscdb` (blocked), superseded ShipIt update downloads (the one `ShipItState.plist` stages is kept), Playwright browsers, Android emulator user data, logs of 1 GiB or more (only a finished GenesisTools day log is deletable; an open log frees nothing), and the Docker Desktop and OrbStack sparse VM disks (blocked, with the guest prune commands pinned to a context).

The new analyzers carry a reclaim metadata contract on every finding: `kind`, `paths` (what `act` removes), `allocatedBytes`, `apparentBytes`, `freeableFloorBytes` (clone-aware, when the volume can say), `ageDays`, `owner`, `requires.absentProcesses`, `regenerates`, `restoreHint`, `sizeKnown`, and `blockers` (why `act` must refuse now: a running owner, an open writer). Ids follow `<analyzerId>:<kind>:<key>` and are stable between scans. `reclaimableBytes` is the clone-aware floor when known, else the allocated ceiling.

**Scan gate.** When free space is under 1 GiB or `fseventsd` holds 1 GiB of memory or more, the walk-heavy rules (the large-file walk, the `node_modules` search, the agent-scratch and SwiftPM searches, Cursor's dead workspaces) do not run, and the others list names and ages only (`sizeKnown: false`). `--json` reports the gate as `scanGate`.

## `--json` document (schema 1)

`{schemaVersion, runId, startedAt, endedAt, analyzers, scanGate, findings[], errors[]}`. Each finding has `id, analyzerId, title, detail, severity, reclaimableBytes, blacklistReason, fromCache, pathsHash, availableActionIds, actions[], metadata` (`pathsHash` is `sha256:` of the sorted `metadata.paths` joined by newlines, null without paths), and each action `{id, label, confirm, confirmPhrase?, staged, kind: "remove-path" | "command" | "other", method?, actable}`. Frozen samples: `src/macos/GenesisKit/Sources/GenesisKitFixtures/Disk/contract-doctor-*` (GenesisKit's one copy; `act.test.ts` and `reclaim-analyzers.test.ts` keep real output's keys and nesting equal to them).

## `doctor act`

The non-interactive door the Disk Manager uses. It never takes a path, and it never reads a path out of an id: it runs the rule that produces the requested ids again (`Analyzer.recheck`, fresh, never the cache, whose findings have lost their `execute`), keeps only the findings whose id matches exactly, and acts only on their `metadata.paths`. An id the fresh scan does not produce is `not-found`; a hand-written `dev-node-modules-<any folder>` or `disk-large-<any file>` is refused that way. Then these guards run per finding, first failure wins: `not-found`, `blocked`, `unknown-action` / `category-not-allowed` (only `remove-path` and `command` actions of disk or system analyzers run; kill, install, reveal and reinstall never do), `method-required` / `method-not-applicable` / `method-conflict`, `confirm-required` (`--yes` for yes/no, the exact `--confirm <phrase>` for typed, and a dangerous finding always needs the phrase), `outside-allowlist` (see the path guard below), `in-use` (the finding's blockers, a process whose working folder is inside a path, or no process table at all), `stale` (`--expect <id>=<bytes>` is more than 25% away from the fresh `reclaimableBytes`, or `--expect-paths <id>=<pathsHash>` differs from the fresh path set).

The path guard refuses a path that is missing, relative or a **symbolic link** (both methods refuse links outright; `moveToTrash` also `lstat`s and refuses a link before invoking the system Trash command). The real path must sit strictly inside the analyzer's allow roots (folders, or globs such as `$X/*.code_sign_clone`; temp-leaks never allows all of `/tmp`), at least three components deep, and must not be `/`, `$HOME`, a system location (`/System`, `/usr`, `/Library`, `/Applications`, `/private/etc`, `/private/var/db`, ...), a git checkout or worktree root (a folder with a `.git` entry), a VM or container disk (Docker, OrbStack, Colima, Lima, Podman, Rancher Desktop, Tart, Multipass, `~/.docker/machine`, `*.raw`, `diffdisk`, `basedisk`, `disk.img`, `*.qcow2` except an Android emulator's `userdata-qemu.img.qcow2`) or the Photos library.

Confirm levels follow the reclaim catalog: caches and regenerable data are `yesno` (or `none` for a plain command such as `brew cleanup`); user data is never below typed. A large file from `disk-space` needs `--confirm "yes, trash"` for `stage-trash` and `--confirm "yes, delete"` for `direct-delete`; the Claude Desktop VM disks (they hold the Cowork session) and the dead Cursor workspaces (chat history) need `--confirm DELETE`. A Tresorit-synced large file is `blocked`; one in iCloud Drive or `~/Library/CloudStorage` carries `metadata.cloudSync` and the same typed phrases. A Cursor workspace counts as dead only when its project folder is positively gone (`ENOENT` on a mounted volume); an unmounted volume, `EACCES` or `EPERM` keeps it. The Docker finding id names its pinned context (`dev-docker-unused-images:<context>`), so a context switch between review and act re-derives nothing. "Is the app running" checks never count the `doctor act` process or its ancestors, and when `ps` fails every such check blocks instead of passing.

Passing items run under one lock (`~/.genesis-tools/doctor/act.lock`, taken before the re-derive; a second run is refused with `locked` and never re-checks). Right before each item the guard and the in-use check run again, and a run longer than 30 s re-derives the remaining findings, so an app started mid-run or a path swapped for a link refuses the later items. A Trash run invokes `/usr/bin/trash -v` for each path after a fresh path and in-use check. This requires macOS 15 or later and does not use Finder automation or require its Automation grant. A manifest or history write that fails after a removal is reported on that item's `error`; the run still finishes and prints its result. A JSONL manifest `~/.genesis-tools/doctor/manifests/<runId>.jsonl` gets its `plan` line fsynced before anything changes, then `item-start`, `item-done` and `volume-after`. Free space is read with `statfs` before and after. Every result goes to `history.jsonl`, Trash moves included (`--method trash` frees nothing until the Trash is emptied: `freesNow: "no"`). `--dry-run` re-checks and plans and writes nothing. `--ndjson` streams the same events and ends with `{"type":"result","result":{...}}`. Exit 0 when every item is ok, staged or (dry run) skipped; 1 when any is refused or failed; 2 for an invalid call, with `{"schemaVersion":1,"error":{"kind":"invalid-call","message"}}` on stdout.

## Safety tiers

Every finding is tagged:

- **safe** — green, executes on Apply
- **cautious** — yellow, yes/no confirm
- **dangerous** — red, must type a confirmation phrase
- **blocked** — gray, disabled with reason (e.g. JetBrains cache, kernel_task)

`blocked` is enforced in the executor too, so no caller can run a blocked finding's action.

## Trash staging

Large files from `disk-space` default to **moving to the Trash** in the interactive UIs, after you type `yes, trash` (they are your files, not caches); the other removal actions delete directly. Items stay in the Trash until you confirm with `DELETE` to empty it permanently, and emptying empties the whole Trash. A Trash move stays on the same volume, so it frees nothing until then. If you quit mid-way, items stay in the Trash and Finder's "Put Back" works to restore.

## Persistence

State lives under `~/.genesis-tools/doctor/`:

- `analysis/<run-id>/` — per-run raw JSON results
- `cache/` — analyzer caches (respect per-analyzer TTLs)
- `history.jsonl` — append-only log of every executed action (`doctor act` logs Trash moves too)
- `manifests/<run-id>.jsonl` — what each `doctor act` run planned and did, written before the first change
- `act.lock` — the single-instance lock of `doctor act`
- `stats.json` — rolled-up aggregates
- `blacklist.json` — your extra cache-glob overrides

## Configuration

Override the cache blacklist by creating `~/.genesis-tools/doctor/blacklist.json`:

    {
        "cacheGlobs": [
            "~/Library/Caches/com.example.myapp/**"
        ]
    }

## Performance

- Cold start < 200 ms.
- Standard scan < 6 s.
- `--thorough` < 30 s.
- Install `fd` (`brew install fd`) for ~10× faster file walks — the tool offers a one-tap install when missing.
