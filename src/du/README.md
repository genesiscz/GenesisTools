# tools du

Measurement only: it never changes what it measures. The only things it writes
are its own caches and the `index` database under `~/.genesis-tools/du/`.
macOS/APFS: the engines map physical extents through `F_LOG2PHYS_EXT`, so every
verb exits 2 with an explanation on other platforms rather than failing to compile.

To *recover* the space this reports, see **`tools macos clones`** — `duplicates`,
`optimize` and `reclaim plan|apply` re-share byte-identical files that lost their
clone links. It calls this tool's engine for its on-disk figure, so the two
always agree; `src/macos/lib/clones/du-parity.test.ts` pins that.

> **Clone-aware disk usage for APFS.**

Measures the real on-disk footprint of trees full of clonefiles, which plain `du` massively overcounts because every clone reports its full size even though clones share physical blocks.

On this machine that is not a corner case. `bun install` uses `clonefile(2)`, so twenty git worktrees can share one physical copy of `node_modules`. `du` counts those bytes twenty times.

---

## Commands

| Command | Description |
|---------|-------------|
| `clonesize <dir>` | Naive (du-style) versus real unique on-disk bytes for a tree, deduping APFS clones |
| `volume [mount]` | Reconcile a whole volume: APFS used-bytes versus what a scan can actually see |
| `partners <dir>` | Find where else a directory's blocks live, the concrete clone partners |
| `index build\|update\|query\|diff\|schedule` | A persisted directory-size index (SQLite) behind the Disk Manager: space map, "what grew", prewarmed answers |
| `bench [dir]` | Benchmark the C engine against the Bun engine and plain `du -sh`, with a byte-for-byte cross-check |

## Quick start

```bash
tools du clonesize .                            # this dir, pretty output
tools du clonesize ~/repo --ignore-worktrees    # skip sibling worktrees
tools du clonesize ~/repo --format json         # machine-readable
tools du clonesize ~/repo --depth 2             # per-directory tree, du -d style
tools du clonesize ~ --changed-within 7d        # what GREW, not what is big

tools du volume                                 # the Data volume
sudo tools du volume                            # including root-only subtrees

tools du partners ~/.bun --against ~/Projects
tools du partners ~/repo/.worktrees/feat-x --against ~/repo

tools du index build                            # index $HOME into ~/.genesis-tools/du/index.db
tools du index query --path ~/Library           # one folder, its stored children, its largest files
tools du index update --paths ~/Downloads       # re-walk only what changed
tools du index diff --from 7d                   # what grew in the last week
```

---

## `clonesize`

| Flag | Description |
|------|-------------|
| `--format <fmt>` | `human` or `json` (default: `human`) |
| `--engine <engine>` | `c-ffi` (C core via `bun:ffi`, default), `c`, or `bun` |
| `--threads <n>` | Worker threads (default: number of CPUs) |
| `--freeable` | Also sum per-file `ATTR_CMNEXT_PRIVATESIZE` (C engine only) |
| `--min-bytes <n>` | Skip files whose allocated size is below N bytes |
| `--depth <n>` | Per-directory tree down to depth N |
| `--freeable-tree` | Per-node private size in the `--depth` tree (implies `--depth 1`) |
| `--ignore-worktrees` | Auto-detect and exclude git worktrees and `.worktrees/` dirs |
| `--changed-within <duration>` | Only count files modified inside this window (`7d`, `24h`, `30m`) |
| `--no-cache` | Ignore the extent cache when reading. It is still written, so the next run is warm. |
| `--include-cloud` | Also walk `~/Library/CloudStorage` and iCloud Drive |
| `--save <file>` | Write the raw JSON result to a file |
| `--diff <file>` | Compare against a previously saved scan and print the per-directory delta |

**`--freeable` is the delete-decision number.** Allocated size tells you how much space a tree occupies. Private size tells you how much you would actually get back by deleting it, because shared blocks stay alive for the other clone.

**`--save` plus `--diff` answers "what grew since yesterday"** without guessing. Save a scan, come back, diff it.

## `volume`

| Flag | Description |
|------|-------------|
| `--format <fmt>` | `human` or `json` |
| `--threads <n>` | Worker threads |
| `--depth <n>` | Also print a per-directory tree down to depth N |
| `--include-cloud` | Also walk cloud-provider roots |

Answers "my disk says 97% full, where is it?". The scan is compared against `ATTR_VOL_SPACEUSED`, the same number `diskutil` prints as Volume Used Space, so anything the walk could not read appears as an explicit **UNACCOUNTED** line instead of silently vanishing from the total.

Run it with `sudo` to include root-only subtrees. Without sudo, expect a large UNACCOUNTED figure.

## `partners`

| Flag | Description |
|------|-------------|
| `--against <root>` | Where to search for partners (default: the dir's parent) |
| `--format <fmt>` | `human` or `json` |
| `--threads <n>` | Worker threads |
| `--top <n>` | Rows to show (default: 30) |

`clonesize` tells you a directory shares N bytes with something. This tells you **with what**. That is the question that decides whether a package-manager cache is safe to delete: blocks a live `node_modules` still references are not freed by deleting the cache.

## `index`

A directory-size index that answers from SQLite in milliseconds instead of walking the disk. One
parallel C walk (`clonesize --index`, a subprocess, listing only: no file is opened) stores every
directory whose subtree is at least `--min-dir-bytes` (1 MiB). Smaller directories are folded into
their nearest stored ancestor; on a developer tree that keeps about 10% of the directories. A
denied, partly listed, skipped (cloud root, other volume) or blocked folder is always stored,
flagged (`dirs.flags`: 1 denied, 2 incomplete, 4 cloud, 8 mount, 16 gone, 32 blocked).

What a row holds, and how it relates to `clonesize`:

| Column | Meaning |
|---|---|
| `alloc_bytes` | Σ allocated size of the subtree's files, `du` style. Equals `clonesize`'s `naive_bytes` for the same tree. |
| `logical_bytes` | Σ datalength. Counts every listed file, including `alloc == 0` ones that `clonesize` leaves out of `apparent_bytes`. |
| `private_bytes` | Σ `ATTR_CMNEXT_PRIVATESIZE`: what deleting would free at least. `alloc - private` is shared with clones or hard links. NULL with `--no-private`. |
| `files`, `dirs` | Regular files and folders in the subtree (`dirs` excludes the row itself). |
| `max_file_bytes`, `newest_mtime_s` | Maxima. Exact after a build; after an update they only grow until the next build. |

Clone-aware "real" bytes are not stored: clones share blocks across sibling folders, so they do
not add up and an update cannot keep them right. Ask `clonesize --depth 1` for one folder on demand.
Hard links count once per entry (like `naive_bytes`), never deduplicated.

| Command | Does |
|---|---|
| `build` | Full walk of `--root` (default `$HOME`). The rows go in through one transaction, so readers see the previous build until the commit. Records a snapshot for `diff`. |
| `update --paths <p...>` | Re-walks only the region that holds each path: the owning stored folder's own files plus its folded subfolders. Stored children whose name and inode still match are not entered. The byte delta goes up the ancestor chain. `--shallow` treats the paths as entries (recheck the parent), `--recursive` re-walks whole subtrees (a path inside another recursive path is dropped, so nothing is counted twice), `--from-queue` drains paths queued while a build held the lock. Before the commit every written folder and its ancestors must cover their stored children; otherwise the update fails with `inconsistent` and writes nothing. |
| `query` | `--path <dir>`: the row, its stored children (`--sort`, `--limit`, `--min-bytes`, `--changed-within`), `local` (files here plus the folded subfolders), `--top-files` and `blocked_below` (given-up folders at or under it). A flagged child (denied, incomplete, skipped, blocked) ignores the size and time filters and is listed after the others, but it shares `--limit`: when ordinary rows fill it, flagged children are left out and `truncated` is set, so ask again with a larger limit. A folded path answers `found: false` with `folded_in`. `--largest dirs\|files` is a global list (dirs ranked by their own bytes), `--info` shows meta, counts (`blocked` included) and scans. |
| `diff` | Folders that grew, shrank, appeared or went, between snapshots (`--from` id, ISO date or `7d`; `--to` id or `now`). Only folders of at least the snapshot floor (64 MiB) take part; a side below it is `null` and `approx: true`. `--attribute leaf` drops a folder whose change one subfolder already explains (80%). |
| `schedule --on\|--off\|--status` | The nightly `du-index-refresh` build with `tools daemon` at 02:15. |

- **Output:** `--format human` on a terminal, `json` otherwise; `build` and `update` also take
  `ndjson` (`start`, `progress` at most twice a second, `blocked`, `phase` ingest/commit/checkpoint,
  then `result` or `error`). `--stop-on-stdin` cancels on EOF, for `ToolsLineStream`. Every machine
  shape has an example in GenesisKit's fixtures (`src/macos/GenesisKit/Sources/GenesisKitFixtures/Disk/contract-du-index-*`,
  the one copy the Swift tests read too), and `index.test.ts` keeps real output's keys and nesting
  equal to them. The SQLite schema is `contract-du-index-schema.sql` there.
- **Exit codes:** 0 ok; 1 failure (`walk_failed`, `disk_low`, `not_built`, `no_snapshot`,
  `root_changed`, `volume_changed`, `inconsistent`); 2 usage or not macOS; 3 `locked` (another build or update);
  4 `schema_newer`; 130 `aborted`.
- **Safety:** `build` and `update` refuse to start with less free space on the database's volume
  than twice the database plus 256 MiB, and never below 1 GiB (about 1 GiB for a `$HOME` index of
  20 MB). `--exclude` paths are made canonical (real path, no trailing slash), like the root. One writer at a time (`index.db.lock`); an `update` that finds a build running queues
  its paths instead. A database written by a newer schema is refused, never migrated down.
- **Blocked folders:** macOS can hold the `open()` of another app's data (under
  `~/Library/Containers`) until someone answers a privacy prompt. A folder whose listing makes no
  progress for `--stall-seconds` (10) is given up: flag 32, its own bytes missing, a `blocked`
  event, and the walk goes on with a fresh worker. One prompt gates every folder behind it, so the
  second given-up child of a folder (never the walk root) gives up all its other children at once,
  at most 64 threads may be stuck, and at that cap the queue is given up so the walk always ends.
  `meta.blocked_dirs`, `query --info` and `blocked_below` keep the count until a later build reads
  the folders. Grant the calling app access (Full Disk Access) and build again.
- **Readers (the Genesis app):** open read-only, `busy_timeout`, read `meta.schema_version` first,
  one short statement per read, never DDL or a checkpoint. WAL keeps the last commit visible while
  a build runs.

---

## ⚠️ `--include-cloud` can cost you

Reading a cloud placeholder file can trigger a download. On a metered or slow connection, or with a large iCloud Drive, that is expensive and slow. It is off by default for exactly that reason. Turn it on only when you specifically need cloud roots counted.

## 🛑 Before changing anything under `src/du/`

Read `docs/benchmarks-du.md` and append a new dated section for every feature you add.

The native core (`src/du/native/clonesize.c`) is syscall-bound and runs in the hot loop of multi-million-file scans, so an unmeasured feature is a silent regression. Measure with `src/du/native/bench.sh <label>`, record **system CPU time** as the primary metric (wall time on this machine swings with load average, so note `uptime`), and diff the `--json` byte totals.

Identical totals are required only when the change is meant to preserve scan semantics: refactors, performance work, validation hardening. Features that deliberately change what is counted, such as `--changed-within` filtering or cloud-boundary pruning, must state which totals move, by how much, and why. Unexplained movement is a bug either way.

## Notes

- The extent cache makes repeat scans much faster. `--no-cache` ignores it for reading but still writes it, so a cold-start measurement is a one-run cost.
- `--engine bun` exists mostly for the cross-check in `bench`. The C engine is the one to use.
- Related: the `disk-reclaim` skill wraps this tool in a guided cleanup that asks before deleting anything.
