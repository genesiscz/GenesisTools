# tools du

Clone-aware disk usage for APFS on macOS. It measures the real on-disk footprint of trees full of clonefiles, which
plain `du` overcounts, because every clone reports its full size even though clones share physical blocks. It also
lists and frees downloaded iCloud files, keeps a directory-size index for the Disk Manager in GenesisTools.app, and
answers plain `du -sk` sizes for scripts.

On a developer Mac the overcount is not a corner case. `bun install` uses `clonefile(2)`, so twenty git worktrees can
share one physical copy of `node_modules`, and `du` counts those bytes twenty times.

**Measurement only.** The tool never changes what it measures. The one exception is `evict --apply`, which frees the
local copy of iCloud files (never the cloud copy), and only after a dry run by default. What it writes: its caches and
the index under `~/.genesis-tools/du/`, the compiled engine into `src/du/native/`, a `--save` file where you name it,
and, for `index schedule --on`, a task in `tools daemon`'s config (`~/.genesis-tools/daemon/config.json`).

To *recover* the space this tool reports, use `tools macos clones`: `duplicates`, `optimize` and `reclaim plan|apply`
re-share byte-identical files that lost their clone links. It calls this tool's engine for its on-disk figure, so the
two always agree; `src/macos/lib/clones/du-parity.test.ts` pins that.

## Quick start

```bash
tools du clonesize ~/Projects/app                       # du-style total against the real unique bytes
tools du clonesize ~/Projects/app --depth 1 --freeable  # per folder, with what deleting each would free
tools du volume                                         # where the Data volume's used space went
tools du partners ~/.bun --against ~/Projects           # which trees still share a cache's blocks
tools du index build                                    # index $HOME once (minutes), then query in milliseconds
tools du downloaded ~/Documents                         # iCloud files that take space on this disk
```

## Commands

Every verb runs on macOS only. On another platform each one exits 2 with an explanation.

| Command | What it does |
|---|---|
| `clonesize <dir>` | Naive (du-style) against real unique bytes for a tree, with APFS clones counted once |
| `volume [mount]` | Reconcile a whole volume: APFS used bytes against what a scan can see |
| `partners <dir>` | Where else a directory's blocks live: the concrete clone partners |
| `size <paths...>` | The plain `du -sk` size of each path in KiB, as JSON, with an optional shared cache |
| `downloaded <dir>` | Cloud files (iCloud, File Provider folders) that are downloaded on this disk |
| `evict <dir>` | Free the local copy of iCloud files that are confirmed uploaded (dry run by default) |
| `index build` | Walk a root once and store every directory of at least 1 MiB in SQLite |
| `index update` | Re-walk only the regions that hold the given paths |
| `index query` | One directory with its children and largest files, a global top list, or `--info` |
| `index diff` | What grew and shrank between two snapshots |
| `index schedule` | Register or remove the nightly index build with `tools daemon` (02:15) |
| `bench [dir]` | Time the C engine, the Bun engine and `du -sh`, with a byte-for-byte cross-check |

Byte flags (`--min-bytes`, `--min-dir-bytes`, `--min-delta` and the like) take a plain integer: `10000000`, not `10M`.
Duration flags (`--changed-within`) take `30m`, `24h` or `7d`.

---

## Measure a tree: `clonesize <dir>`

```bash
tools du clonesize .                                     # this folder, pretty output
tools du clonesize ~/Projects/app --ignore-worktrees     # skip sibling worktrees
tools du clonesize ~/Projects/app --format json          # machine-readable
tools du clonesize ~/Projects/app --depth 2              # per-directory tree, du -d style
tools du clonesize ~/Projects/app --engine bun           # the independent Bun engine
tools du clonesize ~ --depth 1 --changed-within 7d       # what GREW this week, not what is big
tools du clonesize ~ --depth 2 --save mon.json           # save a scan; days later:
tools du clonesize ~ --depth 2 --diff mon.json           # per folder: grown, shrunk, new, gone
```

| Flag | Description |
|------|-------------|
| `--format <fmt>` | `human` or `json` (default: `human`) |
| `--engine <engine>` | `c-ffi` (default), `c` or `bun` (see below) |
| `--threads <n>` | Worker threads (default: the number of CPUs) |
| `--freeable` | Also sum the per-file `ATTR_CMNEXT_PRIVATESIZE` |
| `--min-bytes <n>` | Skip files whose allocated size is below N bytes |
| `--depth <n>` | Per-directory tree down to depth N |
| `--freeable-tree` | Per-node private size in the `--depth` tree (implies `--depth 1`) |
| `--ignore-worktrees` | Detect and exclude git worktrees and `.worktrees/` folders |
| `--changed-within <d>` | Only count files modified inside this window (`7d`, `24h`, `30m`) |
| `--no-cache` | Ignore the extent cache when reading. It is still written, so the next run is warm. |
| `--include-cloud` | Also walk the cloud-provider roots and open cloud-backed files. This may download them. |
| `--save <file>` | Write the raw JSON result to a file |
| `--diff <file>` | Compare against a saved scan and print the per-directory delta |

- **`--freeable` is the delete-decision number.** Allocated size tells you how much space a tree occupies. Private
  size is the least you get back by deleting it, because shared blocks stay alive for the other clone. It is a lower
  bound, not an exact figure: blocks that two files inside the tree share only with each other count in neither
  file's private size, yet deleting both frees them.
- **Point it at the PARENT of several worktrees** to see how much they share. Deleting a worktree frees only its
  unique blocks: blocks it shares with the main checkout's `node_modules` stay. So the du-reported size of a
  worktree is an upper bound, usually far above what is freed. When you scan one side of a clone pair, the JSON
  field `outside_shared_bytes` names the blocks that files outside the scan root also hold.
- **`--save` plus `--diff` answers "what grew since yesterday"** without guessing. The diff matches rows by absolute
  path, so the saved scan must have the same root (else exit 2) and a per-directory tree (else exit 2: save it again
  with `--depth N`). `--diff` and `--freeable-tree` imply `--depth 1` when you do not pass `--depth`.
- **`--diff` JSON is not a scan result.** With `--diff`, `--format json` prints `{ before, after, rows }`: `before`
  and `after` are the root paths of the two scans, and `rows[]` holds one entry per folder that changed, largest move
  first. Each row has `path`, `before` and `after` (the folder's `unique_allocated_bytes` in each scan, else its
  `unique_bytes`; 0 when the scan does not have the folder), `delta` (after minus before) and `status` (`grown`,
  `shrunk`, `new` or `gone`). Unchanged folders are left out.
- **The engines.** `c-ffi` runs the C core in-process through `bun:ffi` (the default). `c` runs the same C core as a
  subprocess. `bun` is the independent Bun engine.
- **The C engines only:** `--freeable`, `--depth`, `--freeable-tree` and `--changed-within` exit 2 with
  `--engine bun`. The Bun engine exists mostly for the cross-check in `bench`. Use the C engine.
- `--ignore-worktrees` prints each excluded path to stderr before the scan.
- Repeat scans are served from the extent cache (see [How it works](#how-it-works)). On this repo that is about 3x
  faster. `--no-cache` makes a cold-start measurement a one-run cost.

## Transparent compression: detect and suggest

```bash
tools du clonesize ./archive --json
tools du clonesize ./archive --compressed --json
tools du compressed ./archive --json
tools du compressible ./archive --json
tools du compression-schedule
```

The C scan and `volume`'s `scan` include `compressed: { files, logical_bytes, allocated_bytes }`.
These are per-file sums before clone deduplication. `logical_bytes - allocated_bytes` is the compression saving
before deduplication; `unique_allocated_bytes` counts physical resource-fork blocks once across compressed clones.
Compressed files are distinct from sparse files. Inline compressed metadata with no resource fork contributes
its reported allocation conservatively. `--compressed` lists files carrying `UF_COMPRESSED`, independent of ratio.

`compressible` only reads. It uses the shared transparent plan filters and configured age, minimum size and
extensions. It skips media, archives, SQLite, compressed, sparse, hard-linked and open files. Shared or unknown
allocation is excluded because a local scan cannot prove that every partner elsewhere will be replaced.
Each eligible file's first and middle 1 MiB are compressed in memory with LZFSE when afsctool is available,
otherwise the ditto writer's algorithm. Folders are ranked by estimated
saving and each row prints `tools compress transparent apply '<folder>'`. Estimates require at least 30% saving.
Sampling is an estimate, not a guaranteed result of apply. Compression writes belong to `tools compress`.

The directory index stores compression totals on builds and updates. Queries expose the same `compressed` object
on nodes and children. Older scans without these measurements omit the field until rebuilt or updated.
`compression-schedule` explicitly registers `du-cold-compress` daily at 05:00, low priority, disabled. It preserves
an existing registration. Only the user may decide to enable recurring history rewriting. The task delegates
battery checks, configured age limits, byte verification, recovery and the journal to `compress transparent`.

## Reconcile a volume: `volume [mount]`

```bash
tools du volume                 # the Data volume (/System/Volumes/Data)
sudo tools du volume            # including root-only subtrees
tools du volume --depth 1       # also a per-directory tree
```

| Flag | Description |
|------|-------------|
| `--format <fmt>` | `human` or `json` (default: `human`) |
| `--threads <n>` | Worker threads (default: the number of CPUs) |
| `--depth <n>` | Also print a per-directory tree down to depth N |
| `--include-cloud` | Also walk the cloud-provider roots and open cloud-backed files (may download them) |

It answers "my disk says 97% full, where is it?". The scan is compared against `ATTR_VOL_SPACEUSED`, the same number
`diskutil` prints as Volume Used Space, so anything the walk could not read appears as an explicit **UNACCOUNTED** line
instead of silently vanishing from the total. A whole volume takes minutes, not seconds. It always uses the `c-ffi`
engine with the extent cache.

Run it with `sudo` to include root-only subtrees. Without sudo, expect a large UNACCOUNTED figure.

JSON: `{ volume, scan, unaccounted_bytes }`. `volume` holds `mount`, `size_bytes`, `used_bytes`, `free_bytes` and
`available_bytes`; `scan` is a `clonesize` result; `unaccounted_bytes` is the used bytes minus the scan's unique
allocated bytes.

## Find clone partners: `partners <dir>`

```bash
tools du partners ~/.bun --against ~/Projects
tools du partners ~/Projects/app/.worktrees/feat-x --against ~/Projects/app
```

| Flag | Description |
|------|-------------|
| `--against <root>` | Where to search for partners (default: the dir's parent) |
| `--format <fmt>` | `human` or `json` (default: `human`) |
| `--threads <n>` | Worker threads (default: the number of CPUs) |
| `--top <n>` | Rows to show (default: 30) |

`--against` must contain `<dir>`, else the command exits 2.

`clonesize` tells you a directory shares N bytes with something. This tells you **with what**. That is the question
that decides whether a package-manager cache is safe to delete: blocks a live `node_modules` still references are not
freed by deleting the cache. JSON: `target_shared_bytes`, `partner_bytes` (double-counts a block that several partners
hold), `partner_files_total`, `partner_dirs[]`, `partner_files[]`, `denied_dirs`, `denied_files`.
A transparently compressed file (decmpfs) keeps its payload in its resource fork, so both the target and each candidate
holder are mapped through that fork; two compressed clones name each other.

## Plain sizes for scripts: `size <paths...>`

```bash
tools du size ~/Projects/app ~/Projects/app/node_modules     # {"<path>": KiB, ...}
tools du size ~/Projects/app --max-cache-age 1800            # accept a size measured in the last 30 minutes
```

| Flag | Description |
|------|-------------|
| `--max-cache-age <seconds>` | Serve a cached size at most this old (default: always measure fresh) |

It prints what `du -sk` prints (allocated KiB, clones at full size, a hard-linked inode once) as one JSON object keyed
by each path as you gave it. A path neither method could read gets `null`, and that answer is not cached.

- **How it measures.** First the engine's listing walk (`clonesize --dusize`: one parallel `getattrlistbulk` pass
  that opens no file), as a child process under a 120 s deadline, because `open()` on a protected folder can wait for
  a privacy prompt and only a process can be killed out of that wait. The system `du -sk` runs instead when the path
  is a file, the engine cannot compile, the walk passes its deadline, or the walk is incomplete: the root or a folder
  could not be read, a folder was denied, a cloud folder was skipped, or a mounted volume sits inside the root.
- **The cache.** Every answer is written to `~/.genesis-tools/du/cache/sizes/`, also a fresh one. With
  `--max-cache-age` above 0, callers on this Mac share it, and identical calls that miss at the same time run one walk
  and wait for its answer.
- **Measured** (2026-10-30, load 6 to 12): a 5.4 GB worktree of 369,151 files took 1.26 to 1.36 s with the native
  walk against 3.37 to 3.73 s with `du -sk`, and both gave the same KiB. The child process costs about 6 ms of spawn.
- The Session files row of the genesis-tools-mods plugin calls it for worktree sizes.

## Cloud files: `downloaded <dir>`

```bash
tools du downloaded ~/Documents
tools du downloaded ~ --min-bytes 10000000
```

| Flag | Description |
|------|-------------|
| `--format <fmt>` | `human` or `json` (default: `human`) |
| `--min-bytes <n>` | Only files with at least N allocated bytes |
| `--top <n>` | Rows to show in the human table (default: 30). JSON lists every file. |
| `--threads <n>` | Worker threads (default: the number of CPUs) |
| `--include-cloud` | Also walk the skipped provider roots under `<dir>` (listing only) |

Every cloud-backed file under `<dir>` that is on this disk: inside a File Provider domain, not dataless, allocated. It
is a listing walk, so it cannot download anything. These are the files `evict` can free. `clonesize` and `volume`
print the two commands as a **Reclaim** hint whenever their walk saw downloaded cloud files.

JSON: `files[]` (largest first) with `path`, `size`, `alloc`, `domain`, `provider`, plus `root`, `filesListed`,
`dirs`, `deniedDirs`, `readErrors`, `cloud` (the `cloud_backed` object below) and `skippedCloud`.

## Cloud files: `evict <dir>`

```bash
tools du evict ~/Documents                    # pick in a list, dry run
tools du evict ~/Documents --all --apply      # evict every eligible file
tools du evict ~/Documents --apply --path ~/Documents/big.mov
```

| Flag | Description |
|------|-------------|
| `--apply` | Really evict. Without it the command is a dry run that changes nothing. |
| `--all` | Select every eligible file (non-interactive) |
| `--path <file...>` | Select these files only (each must be eligible) |
| `--min-bytes <n>` | Only offer files with at least N allocated bytes |
| `--top <n>` | Offer the N largest iCloud Drive files (default: 50) |
| `--threads <n>` | Worker threads (default: the number of CPUs) |

List, select, evict. It lists like `downloaded`, asks iCloud for each file's state, offers the eligible files in a
multiselect (or takes `--all` or `--path` without a TTY), and prints what it would free. Other providers' files are
counted, not offered. With `--apply` it evicts through `FileManager.evictUbiquitousItem`. Eviction never deletes: the
file stays in iCloud and downloads again when opened.

- **What is eligible.** A file is evicted only when iCloud reports it uploaded, not uploading, without an upload
  error, with the local copy current. The helper reads that state again right before each eviction.
- **Refused, always:** Tresorit (on its Drive mount only reading the file back through the mount proves the server
  has it, and its File Provider snapshot and the mount listing both lie; use Tresorit's own "Remove download"), and
  every other provider, whose upload state GenesisTools has not verified.
- **The helper.** `native/cloudctl.swift`, compiled on demand. When `swiftc` is missing or does not compile it, the
  same verbs run as `native/cloudctl.js` through `osascript -l JavaScript`, which ships with macOS. The output names
  the helper that answered. Neither needs GenesisTools.app. A helper run has a deadline (60 s plus 2 s per path), so
  an unresponsive provider cannot hold it forever.
- **The listing still needs the C engine**, so on a Mac without Xcode or the Command Line Tools `evict` works only
  when the engine was compiled there before. Otherwise it stops with an error that names `xcode-select --install`
  (it never opens the install dialog).
- **Exit codes:** 1 when an `--apply` run did not evict a selected file or a file named by `--path`, and 1 without a
  TTY when neither `--all` nor `--path` picks the files.

---

## The directory-size index: `index`

A directory-size index that answers from SQLite in milliseconds instead of walking the disk. The Disk Manager in
GenesisTools.app reads it for its space map, "what grew", and prewarmed answers.

```bash
tools du index build                             # index $HOME into ~/.genesis-tools/du/index.db
tools du index query --path ~/Library            # one folder, its stored children, its largest files
tools du index query --largest files --limit 20  # the 20 largest files anywhere in the index
tools du index update --paths ~/Downloads        # re-walk only what changed
tools du index diff --from 7d                    # what grew in the last week
tools du index schedule --on                     # rebuild every night at 02:15
```

### What the index holds

One parallel C walk (`clonesize --index`, a subprocess, listing only: no file is opened) stores every directory whose
subtree is at least `--min-dir-bytes` (1 MiB). Smaller directories are folded into their nearest stored ancestor; on a
developer tree that keeps about 10% of the directories. A denied, partly listed, skipped (cloud root, other volume) or
blocked folder is always stored, flagged in `dirs.flags`: 1 denied, 2 incomplete, 4 cloud, 8 mount, 16 gone,
32 blocked.

What a row holds, and how it relates to `clonesize`:

- `alloc_bytes`: the sum of the allocated size of the subtree's files, `du` style. It equals `clonesize`'s
  `naive_bytes` for the same tree.
- `logical_bytes`: the sum of datalength. It counts every listed file, also the `alloc == 0` ones that `clonesize`
  leaves out of `apparent_bytes`.
- `private_bytes`: the sum of `ATTR_CMNEXT_PRIVATESIZE`, what deleting would free at least. `alloc - private` is
  shared with clones or hard links. NULL with `--no-private`.
- `files`, `dirs`: regular files and folders in the subtree (`dirs` excludes the row itself).
- `max_file_bytes`, `newest_mtime_s`: maxima. Exact after a build; after an update they only grow until the next
  build.

Clone-aware "real" bytes are not stored: clones share blocks across sibling folders, so they do not add up and an
update cannot keep them right. Ask `clonesize --depth 1` for one folder on demand. Hard links count once per entry
(like `naive_bytes`), never deduplicated.

`build`, `update`, `query` and `diff` take `--db <path>` (default `~/.genesis-tools/du/index.db`). `schedule` has no
`--db`: it always schedules the default index. Every index command takes `--format human|json|ndjson` (default:
`human` on a terminal, `json` otherwise).

### `index build`

A full walk of `--root`. The rows go in through one transaction, so readers see the previous build until the commit.
Each build records a snapshot for `diff`.

| Flag | Description |
|------|-------------|
| `--root <path>` | Directory to index (default: `$HOME`) |
| `--threads <n>` | Walker threads (default: min(8, CPUs); the kernel stops scaling near 8) |
| `--min-dir-bytes <n>` | Fold smaller subtrees into their parent (default: 1 MiB) |
| `--big-file-floor <n>` | Record files of at least this size (default: 8 MiB) |
| `--big-file-limit <n>` | Keep at most this many big files (default: 50000) |
| `--no-private` | Skip PRIVATESIZE (halves the kernel cost; no "shared" figure) |
| `--exclude <path...>` | Do not walk these directories |
| `--include-cloud` | Also walk the cloud-provider roots (may download placeholders) |
| `--no-snapshot` | Do not record a snapshot for `diff` |
| `--snapshot-floor <n>` | Snapshot folders of at least this size (default: 64 MiB) |
| `--reset` | Drop the existing rows first (needed to change the root of a database) |
| `--stop-on-stdin` | Cancel when stdin reaches EOF |
| `--stall-seconds <s>` | Give up a folder whose listing stalls this long (default: 10; 0 waits forever) |

- **One root per database.** A build with another `--root` fails with `root_changed`. Pass `--reset` to start over, or
  `--db` for a second index. When the volume under the root changed, the build starts from empty by itself and its
  result says `reset: "volume_changed"`.
- **Snapshots kept:** every snapshot of the last 24 hours, plus the newest of each of the last 14 days and of each of
  the last 8 weeks.
- **Measured** (2026-10-13, a checkout of about 900,000 files and 115,000 folders, medians of 5): `index build` took
  10 s wall and 35 s CPU. `index update --paths <one folder>` took 0.10 to 0.20 s wall at normal load (the 0.68 s
  median of that run was load noise). `--no-private` cut the walk's CPU from 43.9 s to 19.7 s. A `$HOME` build is
  estimated at 2 to 3.5 minutes.

### `index update`

Re-walks only the region that holds each path: the owning stored folder's own files plus its folded subfolders.
Stored children whose name and inode still match are not entered. The byte delta goes up the ancestor chain.

| Flag | Description |
|------|-------------|
| `--paths <path...>` | Changed paths (directories, or files with `--shallow`) |
| `--shallow` | The paths are entries: recheck their parent directory only |
| `--recursive` | Re-walk each path's whole subtree, stored folders included (FSEvents MustScanSubDirs) |
| `--from-queue` | Also drain the paths queued while a build held the lock |
| `--root <path>` | Fail unless the index root is this directory |
| `--threads <n>` | Walker threads per region (default: 4) |
| `--lock-wait <ms>` | Wait this long for a running build before queueing (default: 2000) |
| `--stop-on-stdin` | Cancel when stdin reaches EOF |
| `--stall-seconds <s>` | As for `build` (default: 10) |

- Pass `--paths` or `--from-queue`; with neither it exits 2.
- With `--recursive`, a path inside another recursive path is dropped, so nothing is counted twice.
- A path outside the indexed root, under a folder the build excluded (`--exclude`), or with no stored folder above it
  is listed in `ignored[]`, and nothing is done for it. The human output prints it as `ignored (outside the index or
  excluded)`.
- When a build holds the lock past `--lock-wait`, the paths go to a queue and the result says `deferred: true` with
  `queued: N`. The next `update --from-queue` drains them; a build drops every queued path it already saw.
- Before the commit every written folder and its ancestors must cover their stored children. Otherwise the update
  fails with `inconsistent` and writes nothing.
- A region on another volume than the index fails with `volume_changed`: run a build.

### `index query`

| Flag | Description |
|------|-------------|
| `--path <path>` | Directory to show (default: the indexed root) |
| `--children`, `--no-children` | Include the stored children (default) or leave them out |
| `--sort <key>` | Child order: `alloc` (default), `logical`, `private`, `files`, `mtime`, `name` |
| `--limit <n>` | At most this many rows (default: 200, 50 for `--largest`) |
| `--min-bytes <n>` | Only children of at least this size |
| `--changed-within <d>` | Only children holding a file modified within this window (`24h`, `7d`) |
| `--top-files <n>` | Largest files under the directory (default: 10) |
| `--largest <kind>` | A global list instead: `dirs` (ranked by their own bytes) or `files` |
| `--info` | Metadata, row counts (blocked included) and recent scans |

`--path` returns the row, its stored children, `local` (files here plus the folded subfolders), the top files and
`blocked_below` (given-up folders at or under it). A flagged child (denied, incomplete, skipped, blocked) ignores the
size and time filters and is listed after the others, but it shares `--limit`: when ordinary rows fill it, flagged
children are left out and `truncated` is set, so ask again with a larger limit. A folded path answers `found: false`
with `folded_in`, the stored folder that holds it. Before the first build, a query fails with `not_built`.

### `index diff`

Folders that grew, shrank, appeared or went, between two snapshots.

| Flag | Description |
|------|-------------|
| `--from <when>` | Snapshot id, ISO date or a duration back from now (`7d`) |
| `--to <when>` | Snapshot id or `now` (default: `now`) |
| `--min-delta <n>` | Only rows that moved by at least this many bytes |
| `--limit <n>` | At most this many rows (default: 200) |
| `--attribute <mode>` | `leaf` (default) or `all` |

- `--from` defaults to the latest snapshot before `--to`. A value that is not a snapshot id, an ISO date or a duration
  exits 2. An id with no snapshot fails with `no_snapshot`.
- Only folders of at least the snapshot floor (64 MiB) take part; a side below it is `null` and `approx: true`.
- `leaf` drops a folder when one folder below it explains at least 80% of its change. So "Library grew 9 GB" does not
  crowd out the subfolder that grew 8.5 GB of it. `all` keeps every row.

### `index schedule`

```bash
tools du index schedule --on       # register the nightly build
tools du index schedule            # show the registration (same as --status)
tools du index schedule --off      # remove it
```

| Flag | Description |
|------|-------------|
| `--on` | Register the nightly build |
| `--off` | Remove it |
| `--status` | Show the registration (the default) |
| `--format <fmt>` | `human`, `json` or `ndjson` |

`--on` with `--off` exits 2.

It registers the `du-index-refresh` task with `tools daemon`, every day at 02:15 (before the clones scan at 03:00 and
the cache prune at 04:00, so the three never overlap). The task is a full build, not an update sweep, because only a
full walk sees the growth that FSEvents missed. It rebuilds the default index with the options of its last build, or
indexes `$HOME` when there is none yet. It runs at low priority, with a 45 minute timeout and one retry, notifies only
on failure, and keeps its run history for 14 days (at least 14 runs). Scheduled from a linked worktree, it runs the
main checkout's copy of the script. The task fires only while `tools daemon` runs (`tools daemon install`).

### Output, exit codes and safety

- **Output:** with `--format ndjson`, `build` and `update` stream events: `start`, `progress` (at most twice a
  second), `blocked`, `phase` (`ingest`, `commit`, `checkpoint`), then `result` or `error`. `query`, `diff` and
  `schedule` print their one result as a single compact JSON line. `--stop-on-stdin` cancels on EOF, for
  `ToolsLineStream` in the app. Every machine shape has an example in GenesisKit's fixtures
  (`src/macos/GenesisKit/Sources/GenesisKitFixtures/Disk/contract-du-index-*`, the one copy the Swift tests read
  too), and `index.test.ts` keeps the keys and nesting of real output equal to them. The SQLite schema is
  `contract-du-index-schema.sql` there.
- **Exit codes.** In `json` and `ndjson`, an error the command detects is an `error` object with `code`, `message`
  and `exit_code`.
  - 0: OK.
  - 1: a failure: `walk_failed`, `disk_low`, `not_built`, `no_snapshot`, `root_changed`, `volume_changed`,
    `inconsistent`, `failed`.
  - 2: `usage`, a usage error the command detects: `update` with neither `--paths` nor `--from-queue`, `schedule`
    with both `--on` and `--off`, a `--root` that is not a directory, or a `diff --from`/`--to` it cannot read.
  - 3: `locked`, another build or update holds the database.
  - 4: `schema_newer`, a newer GenesisTools wrote the database.
  - 130: `aborted`.
- **Exit codes with no error object.** Not macOS exits 2 with a plain message. A flag the parser rejects (an unknown
  flag, a bad `--format` or `--sort` choice, a non-integer byte value such as `--min-dir-bytes 1M`, a bad duration)
  exits 1 with a plain message on stderr, in every format.

- **Free space:** `build` and `update` refuse to start with less free space on the database's volume than twice the
  database plus 256 MiB, and never below 1 GiB (about 1 GiB for a `$HOME` index of 20 MB). A fixed 8 GiB refused to
  run exactly when a nearly full disk made the index most useful. The hidden `--min-free-gb <n>` sets another floor.
- **One writer at a time** (`index.db.lock`). A `build` that finds another writer fails with `locked` after about a
  second; an `update` queues its paths instead (see above). `--exclude` paths are made canonical (real path, no
  trailing slash), like the root. A database written by a newer schema is refused, never migrated down.
- **Blocked folders:** macOS can hold the `open()` of another app's data (under `~/Library/Containers`) until someone
  answers a privacy prompt. A folder whose listing makes no progress for `--stall-seconds` (10) is given up: flag 32,
  its own bytes missing, a `blocked` event, and the walk goes on with a fresh worker. One prompt gates every folder
  behind it, so the second given-up child of a folder (never the walk root) gives up all its other children at once,
  at most 64 threads may be stuck, and at that cap the queue is given up so the walk always ends.
  `meta.blocked_dirs`, `query --info` and `blocked_below` keep the count until a later build reads the folders.
  Grant the calling app access (Full Disk Access) and build again.
- **Readers (the Genesis app):** open read-only, set `busy_timeout`, read `meta.schema_version` first, one short
  statement per read, never DDL or a checkpoint. WAL keeps the last commit visible while a build runs.

---

## Engine check: `bench [dir]`

```bash
tools du bench                       # the current folder
tools du bench ~/Projects/app --threads 8
```

| Flag | Description |
|------|-------------|
| `--threads <n>` | Worker threads for both engines (default: the number of CPUs) |

It times `du -sh`, the C engine through `bun:ffi`, the C engine as a subprocess, and the Bun engine (bun:ffi plus
Workers) on one tree, then cross-checks the C (ffi) and Bun results byte for byte: naive, unique, unique allocated and
shared bytes. A live tree can change between runs, so a DIFF on a busy tree is not proof of a bug; run it again on a
static tree. It flags a wall-time gap above 20% between the two engines. It runs the engines without the extent cache;
warm the OS cache first, because a cold first run is dominated by disk reads.

---

## How it works

### Engines

The core is C (`src/du/native/clonesize.c`). It walks with `getattrlistbulk`, maps each file's physical extents through
`F_LOG2PHYS_EXT`, and counts every physical block once. It is compiled on first use with `clang` into `src/du/native/`
(a `clonesize` binary and a `libclonesize` dylib) and again whenever the source is newer. Compiling needs Xcode or the
Command Line Tools; without them the command stops with an error that names `xcode-select --install`, and never opens
the install dialog. The Bun engine is an independent implementation (bun:ffi plus Workers, with the small
`l2p_shim.c` dylib) for cross-checks. Linux reflinks (btrfs, XFS) would need a FIEMAP backend, which this build does
not have; for a plain allocated-size total anywhere, use `du -sh`.

The scan is syscall-bound and the walk is multi-threaded. A 22.7M-file home scan took 618 s. The full performance
log is [docs/benchmarks-du.md](../../docs/benchmarks-du.md).

### Where data lives

| Path | What |
|---|---|
| `~/.genesis-tools/du/cache/extents-<fsid>.bin` | The extent cache, one file per volume |
| `~/.genesis-tools/du/cache/sizes/` | The answers of `tools du size` |
| `~/.genesis-tools/du/index.db` | The index (SQLite in WAL mode), with `index.db.lock` while a writer works |

The extent cache is keyed by the volume's fsid, so one cache serves every scan root on that volume. A file whose
(id, mtime, size, allocation) is unchanged cannot have moved blocks, so its extent map is reused instead of opened
again.

### What uses it

- The Disk Manager in GenesisTools.app runs `du volume`, `du clonesize`, `du partners` and the `index` commands with
  JSON output, and reads `index.db` directly.
- `tools macos clones` calls the engine in-process for its on-disk figure, and runs `clonesize --bigfiles` as a
  subprocess for its dedupe walk. The worktree sizes of `tools hub` call the engine in-process.
- The genesis-tools-mods plugin's Session files row calls `tools du size --max-cache-age`.
- `tools daemon` runs the nightly index build.

Nothing costs money, and the tool makes no network calls of its own. The one way it can cause network traffic is
`--include-cloud`, which can make a cloud provider download files.

### Permissions

Folders that macOS protects need Full Disk Access for the app that runs `tools` (the terminal, or GenesisTools.app).
Without it those folders count as denied, and their bytes are missing from every total (`denied_dirs` in JSON).
Root-only subtrees need `sudo`.

### Cloud-backed content: stat only by default

Opening a cloud placeholder (a *dataless* file) makes `fileproviderd` download it. So by default no verb opens
cloud-backed content, and none enters a dataless folder:

- **Detection.** A file is cloud-backed when it is dataless (`st_flags & SF_DATALESS`, `ls -lO` shows `dataless`),
  anywhere, or when it sits inside a File Provider domain. A domain root carries the
  `com.apple.file-provider-domain-id` xattr: Desktop and Documents synced to iCloud, `~/Library/Mobile Documents`,
  every `~/Library/CloudStorage/<provider>` (Dropbox, Tresorit, and others). Only the places a domain root can sit are
  asked for the xattr (children of a home folder, of `Library/CloudStorage`, and `Library/Mobile Documents`), plus the
  scan root and its ancestors.
- **Stat only.** Such files are counted from the listing, like `du`: their allocated size goes into `naive_bytes` and,
  in full, into the unique totals. They are never opened and their extents are never read, so clone sharing inside
  them is not deduped (an upper bound). A dataless folder is counted, never entered (entering it makes the provider
  fetch its listing).
- **Kernel guard.** Each walk thread sets `IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES` to off, so a case the rules
  miss fails in the kernel instead of downloading.
- **Skipped roots.** `~/Library/CloudStorage` and `~/Library/Mobile Documents` are not walked at all
  (`skipped_cloud`): a provider's listing can stall a walk for minutes.
- `--include-cloud` lifts all of it: it walks the provider roots and opens cloud-backed files for exact clone
  accounting. **That may download them.**

The human output names every folder, for example:

```
  ⚠ Cloud-backed content was measured by stat only, never opened (opening a placeholder
    can make the provider download it). Clone sharing inside it is not deduped:
     ~/Documents: 9,230 files cloud-backed, measured by stat only, not opened (155.4 MB local, 8,949 dataless = 1.20 GB cloud-only)
     ~/Library/CloudStorage/Tresorit-x: 24 dataless folder(s) not entered
```

JSON (`clonesize`, and `volume`'s `scan`) carries one object, `cloud_backed`:

| Field | Meaning |
|---|---|
| `mode` | `stat-only` (default) or `opened` (`--include-cloud`) |
| `materialize_guard` | The walk threads ran with dataless materialization off |
| `files` | Cloud-backed regular files listed |
| `dataless_files`, `dataless_dirs` | Placeholders; folders were not entered |
| `local_bytes` | Sum of the allocated bytes of the cloud-backed files: what is on this disk |
| `cloud_only_bytes` | Sum of the logical size of the dataless files: content that is only in the cloud |
| `folders[]` | The same counts per folder, plus `path`, `domain` and `provider` |

In `folders[]`, `domain: true` marks a File Provider domain root. `domain: false` marks a folder with stray dataless
files, and its `provider` is empty.

`--bigfiles` (the dedupe walk behind `tools macos clones`) leaves dataless files out of its list (`dataless_skipped`),
since its caller reads every candidate. `index` flags a dataless folder as a skipped cloud folder (flag 4) and does not
enter it. `size` hands a tree with a skipped cloud folder to `du -sk`.

## Configuration

The compression estimator reads `du.compress.defaults` from the shared GenesisTools config, with age `3d`,
minimum `64` KiB and text extensions when absent. Other scan choices are flags. Two environment variables matter:

- `GENESIS_TOOLS_HOME` replaces the home folder for GenesisTools data: the caches and the index go to
  `$GENESIS_TOOLS_HOME/.genesis-tools/du/`. With `GENESIS_TOOLS_HOME=~/alt`, the index is
  `~/alt/.genesis-tools/du/index.db`. The default index root (`--root`) is still `$HOME`.
- `PROFILE=du` times every phase of a scan (the scan and the engine's own sub-phases), on stderr and in
  `~/.genesis-tools/logs/<date>-profiling.log`. Use it instead of wrapping the command in `time`, which reports only
  the total.

`-v` / `--verbose` turns on verbose logging.

## For agents

- **JSON:** `clonesize`, `volume`, `partners` and `downloaded` take `--format json`. `size` always prints JSON. The
  `index` commands print JSON by default when stdout is not a terminal. With `--format ndjson`, `build` and `update`
  stream events, and `query`, `diff` and `schedule` print one compact JSON line.
- **`clonesize --diff` JSON** is `{ before, after, rows }`, not a scan result: the two root paths, then one row per
  changed folder with `path`, `before`, `after`, `delta` and `status`. The fields below are absent.
- **`clonesize` JSON fields:** `naive_bytes` (what `du` reports), `unique_allocated_bytes` (clone-deduped allocated
  bytes, the figure the volume's used-space counter agrees with), `unique_bytes` (clone-deduped mapped bytes, without
  block slack), `shared_bytes`, `shared_pct`, `private_sum_bytes` (with `--freeable`: the floor on what deleting
  frees), `outside_shared_bytes`, `denied_dirs`, `skipped_mounts`, `skipped_cloud`, `cloud_backed`, `nodes` (with
  `--depth`), plus `engine` and `elapsed_ms`.
- **Exit codes outside `index`:** 0 OK; 1 when the folder is not a directory, a `--diff` file is missing, or `evict`
  left a file it was asked for; 2 for a flag the engine cannot do, a `--diff` of another root, a `partners --against`
  that does not contain the folder, or not macOS. The `index` codes are listed in its section above.
- **A flag the parser rejects exits 1, in every command.** An unknown flag, a bad choice, a non-integer number (`10M`)
  or a bad duration prints a plain message on stderr. No JSON error object is printed, also in the `index` commands.
- **Batch by parent.** Each call pays the `tools` start-up, 0.21 to 0.42 s against 0.006 s for `du` (measured
  2026-10-22). On large trees the scan itself is as fast as `du` or faster (`~/.gradle`, 171,000 files: 35% faster).
  So run one `clonesize --depth` call per parent, never one call per small folder, and never run `du` and then
  `tools du` on the same tree: that is the same walk twice.
- Sizes for many callers: `tools du size <path> --max-cache-age <s>` shares one answer and one walk.
- `tools du --readme` prints this file.

## Troubleshooting

- **`volume` shows a large UNACCOUNTED figure.** The walk could not read root-only subtrees. Run `sudo tools du volume`.
- **`denied_dirs` is above 0, or totals look too small.** macOS protects those folders. Give the app that runs
  `tools` Full Disk Access, then scan again.
- **An index build reports `blocked` folders.** A privacy prompt holds the folders under `~/Library/Containers`.
  Answer the prompt or grant Full Disk Access, then build again; `query --info` shows the count until then.
- **"compiling it needs Xcode or the Command Line Tools".** The engine is not compiled yet. Run
  `xcode-select --install`, then run the command again.
- **`index build` exits 3 (`locked`).** Another build or update is running. Wait for it; an `update` queues its paths
  by itself.
- **`index build` fails with `root_changed`.** The database indexes another root. Pass `--reset`, or `--db` for a
  second index.
- **`index update` fails with `volume_changed`.** The region is on another volume than the index. Run `index build`.
- **`disk_low`.** The volume of the database has less free space than the index needs. Free some space first.
- **Exit 4 (`schema_newer`).** A newer GenesisTools wrote the database. Update this checkout; the tool never migrates
  a database down.
- **`--freeable` (or `--depth`, `--changed-within`) exits 2.** You passed `--engine bun`. Drop it.
- **`bench` prints a cross-check DIFF.** The tree changed between runs. Run it again on a static tree.

## Development: before changing anything under `src/du/`

Read [docs/benchmarks-du.md](../../docs/benchmarks-du.md) and append a new dated section for every feature you add.

The native core is syscall-bound and runs in the hot loop of multi-million-file scans, so an unmeasured feature is a
silent regression. Measure with `src/du/native/bench.sh <label>` (the index has `src/du/native/bench-index.ts`),
record **system CPU time** as the primary metric (wall time on a loaded machine swings with load average, so note
`uptime`), and diff the `--json` byte totals.

Identical totals are required only when the change is meant to preserve scan semantics: refactors, performance work,
validation hardening. Features that deliberately change what is counted, such as `--changed-within` filtering or
cloud-boundary pruning, must state which totals move, by how much, and why. Unexplained movement is a bug either way.

## Related

- [tools macos](../macos/README.md): `macos clones` turns duplicates into clones and recovers the space.
- [tools daemon](../daemon/README.md): runs the nightly `du-index-refresh` build.
- [tools hub](../hub/README.md): its worktree sizes use this engine.
- [tools doctor](../doctor/README.md): finds disk bloat, dev caches and leaked temp copies, and cleans them up.
- The `disk-reclaim` agent skill (kept outside this repository) wraps this tool in a guided cleanup that asks before
  deleting anything.
