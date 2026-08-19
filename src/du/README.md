# tools du

> **Clone-aware disk usage for APFS.**

Measures the real on-disk footprint of trees full of clonefiles, which plain `du` massively overcounts because every clone reports its full size even though clones share physical blocks.

On this machine that is not a corner case. `bun install` uses `clonefile(2)`, so twenty git worktrees can share one physical copy of `node_modules`. `du` counts those bytes twenty times.

---

## Commands

| Command | Description |
|---------|-------------|
| `clonesize <dir>` | Naive (du-style) versus real unique on-disk bytes for a tree, deduping APFS clones |
| `volume [mount]` | Reconcile a whole volume: APFS used-bytes versus what a scan can actually see |
| `clones <dir>` | Find where else a directory's blocks live, the concrete clone partners |
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

tools du clones ~/.bun --against ~/Projects
tools du clones ~/repo/.worktrees/feat-x --against ~/repo
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

## `clones`

| Flag | Description |
|------|-------------|
| `--against <root>` | Where to search for partners (default: the dir's parent) |
| `--format <fmt>` | `human` or `json` |
| `--threads <n>` | Worker threads |
| `--top <n>` | Rows to show (default: 30) |

`clonesize` tells you a directory shares N bytes with something. This tells you **with what**. That is the question that decides whether a package-manager cache is safe to delete: blocks a live `node_modules` still references are not freed by deleting the cache.

---

## ⚠️ `--include-cloud` can cost you

Reading a cloud placeholder file can trigger a download. On a metered or slow connection, or with a large iCloud Drive, that is expensive and slow. It is off by default for exactly that reason. Turn it on only when you specifically need cloud roots counted.

## 🛑 Before changing anything under `src/du/`

Read `.claude/docs/benchmarks-du.md` and append a new dated section for every feature you add.

The native core (`src/du/native/clonesize.c`) is syscall-bound and runs in the hot loop of multi-million-file scans, so an unmeasured feature is a silent regression. Measure with `src/du/native/bench.sh <label>`, record **system CPU time** as the primary metric (wall time on this machine swings with load average, so note `uptime`), and diff the `--json` byte totals.

Identical totals are required only when the change is meant to preserve scan semantics: refactors, performance work, validation hardening. Features that deliberately change what is counted, such as `--changed-within` filtering or cloud-boundary pruning, must state which totals move, by how much, and why. Unexplained movement is a bug either way.

## Notes

- The extent cache makes repeat scans much faster. `--no-cache` ignores it for reading but still writes it, so a cold-start measurement is a one-run cost.
- `--engine bun` exists mostly for the cross-check in `bench`. The C engine is the one to use.
- Related: the `disk-reclaim` skill wraps this tool in a guided cleanup that asks before deleting anything.
