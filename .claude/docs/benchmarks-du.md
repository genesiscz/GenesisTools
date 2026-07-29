# `tools du` — performance log

`src/du` exists for one reason: to be fast enough that a clone-aware scan of a
huge tree is worth running at all (a 22.7M-file home scan took 618s). Every
feature added to the native core sits in the hot loop, so an unmeasured feature
is a silent regression waiting to happen.

**Hard rule: read this file before touching `src/du/`, and append a section to it
for every feature you add.** No exceptions, including "this can't possibly cost
anything".

## How to measure

```bash
src/du/native/bench.sh <label>
```

The script rebuilds `native/clonesize.c` with `clang -O2 -pthread`, then runs
hyperfine (`--warmup 1 --runs 5`) over a fixed matrix:

| Name | Target | Mode |
|---|---|---|
| `T1 flat` | repo root | no `--depth` |
| `T1 depth2` | repo root | `--depth 2` |
| `T2 flat` | repo `node_modules` | no `--depth` |
| `T2 depth2` | repo `node_modules` | `--depth 2` |

It finishes by printing the `--json` totals for T1 so byte-level output can be
diffed across commits.

### Read the numbers correctly

- **System CPU time is the primary metric, not wall time.** The scan is
  syscall-bound (`getattrlistbulk` + `openat` + `fcntl`), and this machine is
  frequently under heavy load — the baseline below was taken at load average
  **109**, which inflates and destabilises wall time (σ ≈ 7%). System CPU time
  moves far less with unrelated load.
- **Treat < 15% wall-time movement as noise** unless system CPU time moved with
  it in the same direction.
- **Always record the load average** (`uptime`) next to the numbers.
- A run that changes `naive_bytes` / `unique_bytes` / `files_scanned` on an
  unchanged tree is a correctness bug, not a benchmark result. Check that first.

## Machine

- Mac16,5 · Apple M4 Max · 16 cores · macOS 26.3.1
- APFS, 995 GB Data volume

---

## 2026-07-27 23:05 — Baseline (before the 9-task feature wave)

Baseline commit state: `src/du/` as of `acb76f91f` (feature work stashed away for
this measurement). Load average at run time: **109.39** (heavily loaded machine).

| Benchmark | Wall mean ± σ | User | System |
|---|---|---|---|
| T1 flat | 14.150 s ± 0.914 s | 0.540 s | 76.359 s |
| T1 depth2 | 14.158 s ± 1.039 s | 0.540 s | 66.895 s |
| T2 flat | 1.356 s ± 0.180 s | 0.051 s | 6.455 s |
| T2 depth2 | 1.385 s ± 0.131 s | 0.052 s | 7.132 s |

Correctness totals for T1 (repo root), to diff against after every change:

```json
{
  "files_scanned": 711959,
  "files_listed": 713388,
  "files_opened": 468222,
  "extents": 472445,
  "threads": 16,
  "naive_bytes": 19616407552,
  "unique_bytes": 12157453308,
  "shared_bytes": 7458954244,
  "shared_pct": 38.02,
  "cross_group_shared_bytes": 253217023
}
```

Notes:

- `--depth 2` costs nothing measurable over flat — the per-file `FileRec` push
  and the node post-pass are both cheap next to the syscall load.
- 468k of 712k files get opened + extent-scanned; the private-file skip
  (`priv >= alloc && nlink <= 1 && alloc >= dlen`) avoids ~34% of the opens.
- `du -sh` on T1 runs in ~10 s and reports 18 GB against clonesize's 11.32 GB
  real unique, i.e. plain `du` overstates this tree by ~6.9 GB.

### Cross-engine reference (`tools du bench .`, same session)

| tool | wall | files/s | reported |
|---|---|---|---|
| `du -sh` | 10.01 s | - | 18G |
| clonesize (C ffi) | 12.73 s | 55,949 | 11.32 GB |
| clonesize (C proc) | 15.85 s | 44,907 | 11.32 GB |
| clonesize (Bun) | 19.84 s | 35,885 | 11.32 GB |

C-ffi and the Bun engine agreed byte-for-byte
(`naive=19616395264 unique=12157444559`) on a quiesced run.

---

## 2026-07-27 23:30 — Step 1: native-core feature wave (handoff h_c4x0xc9a t1/t3/t5/t7 + entry points for t2/t8)

What landed in `native/clonesize.c`:

- **Denial tracking** — every `open()`/`openat()` that fails with EACCES/EPERM is
  counted and the first 64 paths kept (`denied_dirs`, `denied_files`,
  `denied_paths[]`). Costs one `errno` check on an already-failing syscall.
- **`ATTR_CMN_MODTIME` added to the attrlist** (for `--changed-since`). This is
  the only change that touches the per-file hot path: the entry grew from 80 to
  96 bytes, so `getattrlistbulk` returns fewer entries per 64 KB buffer and the
  walk issues marginally more syscalls.
- **Sparse accounting** — `apparent_bytes`, `sparse_bytes`, `sparse_files`
  (per-node too). Two compares and two adds per file.
- **Second, block-aligned merge pass** — the cluster merge was extracted into
  `merge_pass(align)` and now runs twice over the same sorted extent array:
  raw (mapped bytes, unchanged semantics) and rounded out to 4096-byte
  allocation blocks (`unique_allocated_bytes`). This is the only added *pass*,
  and it is O(extents) with no extra sort.
- **`clonesize_volume_json`** (ATTR_VOL_SPACEUSED) and
  **`clonesize_partners_json`** (two-phase clone-partner query) — new entry
  points, zero cost to the normal scan path.

### A/B, same machine, binaries built from the same clang invocation

Baseline binary rebuilt from `git show HEAD:src/du/native/clonesize.c`, so this
is a true before/after rather than a comparison against yesterday's conditions.
Load average during the run: **79** (T2) / **~75** (T1).

T2 (`node_modules`), `--warmup 2 --runs 10`:

| | Wall mean ± σ | System CPU |
|---|---|---|
| BASE | 1.438 s ± 0.447 s | 5.856 s |
| NEW | 1.209 s ± 0.098 s | 6.233 s |

T1 (repo root, 712k files), `--warmup 1 --runs 5`:

| | Wall mean ± σ | System CPU |
|---|---|---|
| BASE | 13.242 s ± 1.574 s | 67.409 s |
| NEW | 12.700 s ± 0.475 s | 61.567 s |

**Verdict: no regression.** Wall time is flat-to-slightly-better on both targets
(inside σ either way). System CPU moved +6.4% on T2 and −8.7% on T1, i.e. the
two figures disagree in sign, which is the signature of machine load rather than
code. The added work (one extra O(extents) pass, a 16-byte-wider attribute entry)
is small next to the syscall floor.

An earlier single-sided run of `bench.sh` showed T2 flat at +21% wall; the direct
A/B above disproves it. **This is exactly why the A/B has to rebuild the baseline
binary rather than compare against a stored number.**

### Correctness (T1, unchanged tree semantics)

`unique_bytes`, `naive_bytes`, `extents` and `files_opened` all track the
baseline (the small drift is the live repo, ±130 KB across runs):

```
naive_bytes            19616546816
unique_bytes           12157523815   <- mapped, same definition as baseline
unique_allocated_bytes 13371289600   <- NEW: +1.21 GB the mapped figure was dropping
apparent_bytes         17448549166
private_sum_bytes       9956433920   <- "deleting this frees >= " floor
extents                     472443
files_opened                468220
```

The 1.21 GB gap between mapped and allocated on a single 712k-file repo is the
concrete evidence for handoff task t7: summing mapped extents understates real
consumption by the per-file sub-block slack, ~10% here.

---

## 2026-07-27 23:45 — Step 2: extent cache (`--no-cache` to bypass)

### Why this and not something else

Measured first, as the rule requires:

```
[profile] walk+scan 13.415s · merge 0.002s · sort+cluster 0.029s · total 13.445s
          (opened 468220/711981 files, 472443 extents)
```

**99.8% of a scan is the walk.** Merge, sort and clustering together are 0.03 s —
caching *those* would buy nothing. So the question is what inside the walk costs
the most, answered with the built-in `NOSKIP=1` escape hatch, which forces every
file open instead of only the shared ones:

| | files opened | walk+scan |
|---|---|---|
| normal | 468,220 | 13.781 s |
| `NOSKIP=1` | 711,981 | 17.969 s |

+243,761 opens cost +4.188 s → **~17.2 µs per `open()` + `fcntl(F_LOG2PHYS_EXT)`
loop + `close()`**. The 468,220 opens in a normal run are therefore ≈ **8.0 s of
the 13.8 s**. That is the thing worth caching, and nothing else is.

### What the cache stores

A file's physical extent list, keyed by `(fileid, mtime_ns, datalength, allocsize)`.
Anything that rewrites a file bumps its mtime; anything that changes its length
changes dlen/alloc. So an exact match means the extents cannot have moved and the
syscalls are skipped. `ATTR_CMN_FILEID` was added to the attrlist for the key
(entry size 96 → 104 bytes).

- One file per **volume**, `~/.genesis-tools/du/cache/extents-<fsid>.bin`, because
  fileids are volume-wide — one cache serves every scan root on that volume.
- mmap'd read-only and binary-searched, so worker threads share it lock-free.
- Written to a temp path and `rename(2)`d, so a killed scan cannot corrupt it.
- Records the previous run never saw are **carried over**, not dropped. Verified:
  scanning only `node_modules` against a whole-repo cache left the file at 29.8 MB
  rather than truncating it to the subtree.
- A fully-warm run (zero opens) **skips the rewrite entirely** — visible below as
  the merge phase going 0.500 s → 0.002 s.
- Not covered: an in-place rewrite that restores the exact mtime *and* size, and
  APFS relocating blocks without touching file metadata. `--no-cache` exists for
  both.

`--no-cache` suppresses reading only. The cache is still WRITTEN, so the run after
a `--no-cache` run is warm.

### Numbers (T1 = repo root, 712k files, 468k shared)

Phase timings from `PROFILE=1`, same session, back to back:

| run | walk+scan | merge | total | opened | cached |
|---|---|---|---|---|---|
| cold (`--no-cache`, writes) | 12.356 s | 0.487 s | 12.960 s | 468,220 | 0 |
| warm | 4.811 s | 0.198 s | 5.037 s | 0 | 468,220 |
| warm again | 4.194 s | 0.190 s | 4.413 s | 0 | 468,220 |

**~2.9× on a warm repeat scan** (12.96 s → 4.41 s), which lands within 15% of the
8.0 s the NOSKIP measurement predicted was removable.

End to end through the CLI (`tools du clonesize .`), including bun startup:

```
--no-cache   13.80s
(warm)        4.59s
```

Cache file: **29,815,928 bytes** for 468,220 records + 472,443 extents.

A later repeat under heavy load (load average ~90) measured 21.7 s → 6.6 s, i.e.
the ratio holds even when the absolute numbers do not.

### Cost when the cache is OFF

`--warmup 2 --runs 7`, step-1 binary vs step-2 binary, both without `--cache-dir`:

| | Wall mean ± σ | Wall min | System CPU |
|---|---|---|---|
| step1 (no cache code) | 23.106 s ± 3.085 s | **19.857 s** | 72.329 s |
| step2 (cache code, off) | 24.775 s ± 4.576 s | **19.827 s** | 67.290 s |

The means are useless here (σ > 3 s — a whole-volume scan was running alongside),
but the **minima are identical to 30 ms**, and system CPU is lower for step 2. The
cache code costs nothing when disabled.

⚠️ Methodology note learned the hard way: this run was polluted because a
`tools du volume` scan of the whole disk was running in the background. Never
benchmark while another scan is in flight — check `uptime` first, and compare
minima, not means, when the machine is busy.

### Correctness

Cold vs warm on `node_modules --depth 2`:

- every scalar total byte-identical (`naive_bytes`, `unique_bytes`,
  `unique_allocated_bytes`, `apparent_bytes`, `shared_bytes`,
  `cross_group_shared_bytes`, `private_sum_bytes`, `extents`, `files_scanned`)
- all **3,142 tree nodes identical** once sorted by path (the `nodes[]` array
  order and `parent` indices are thread-interning order and have never been
  stable across runs — that predates this change)
- only `files_opened` / `files_cached` differ, which is the point

Invalidation, on a fixture with three clones of one 4 MB file:

```
cold                        4 opened, 0 cached   unique 10.0 MB
warm                        0 opened, 4 cached   unique 10.0 MB
(rewrite one clone in place)
warm                        0 opened, 3 cached   unique 14.0 MB
--no-cache (ground truth)   3 opened, 0 cached   unique 14.0 MB
```

The rewritten file drops out of the cache and the total tracks the ground truth.

### Bug this caught

Adding `ATTR_CMN_FILEID` shifted every field after it in the `getattrlistbulk`
entry. The parser was updated but the *request* was not, so the scan read `dlen`
where `alloc` should be: `naive_bytes` silently became the old `apparent_bytes`
value and `files_opened` fell from 468,220 to 248,942. Nothing crashed; the output
just quietly lied. It was caught in one command by diffing against the correctness
totals recorded in this file — which is the entire reason the rule to record them
exists.

---

## 2026-07-28 00:45 — Step 3: filesystem and cloud-provider boundaries

Not a performance feature, but it changes what a scan measures, so it belongs in
this log.

### Foreign mounts

The walk now prunes mount points of *other* filesystems (`du -x` semantics),
collected once from `getmntinfo()` before the walk starts. Two spellings are
pruned, because macOS firmlinks mean the mount table records a network mount as
`/Users/<user>/<mount>` while a scan rooted at `/System/Volumes/Data` reaches the
same directory as `/System/Volumes/Data/Users/<user>/<mount>`. (Observed with an
NFS export published by a local container runtime.)
The second spelling is only generated when the scan root is under
`/System/Volumes/Data`, so ordinary scans get an empty list and pay nothing.

Cost: one `getmntinfo()` per scan, plus a string compare per directory push
against a list that is empty for normal roots.

### Cloud-provider roots — the one that actually mattered

`~/Library/CloudStorage/<provider>` and `~/Library/Mobile Documents` are **not
mounts** (same device id as everything else), so mount pruning cannot see them.

Measured failure, on the native binary directly, no bun wrapper involved: a
whole-volume scan reached 32 CPU-minutes and then stopped making progress. All 16
workers were parked in `getattrlistbulk`, and `lsof` on the process showed every
one of them sitting on a directory under
`~/Library/CloudStorage/<provider>/…`. The File Provider extension answers those
enumerations, and it was not answering.

Skipping them is also the correct measurement: the contents are largely dataless
placeholders whose bytes are on someone else's disk, and reading a placeholder can
trigger a download. A disk-usage tool must never quietly pull gigabytes over the
network in order to measure them. `--include-cloud` opts back in.

Detection is a name check (`CloudStorage` / `Mobile Documents`) plus an
8-character suffix compare on the parent (`…/Library`) — no `stat`, because
`stat`ing the provider root is itself a call that can block.

### The whole-volume reconcile this unlocked (handoff task t2)

```
Volume reconcile — /System/Volumes/Data
27,028,294 files  •  16 threads  •  804.2s

  Volume size                    994.7 GB
  Volume used (APFS)             953.2 GB  = diskutil 'Volume Used Space'
  Volume free                     14.9 GB
  Scanned unique (alloc)         897.0 GB
  UNACCOUNTED                     56.2 GB  (5.9% of used)

  ⚠ 2 cloud-provider root(s) were NOT walked
  12 mount point(s) of other filesystems were skipped
  ⚠ 276 unreadable path(s) — the prime suspect for the gap
     /System/Volumes/Data/.Spotlight-V100
     /System/Volumes/Data/.fseventsd
     /System/Volumes/Data/.DocumentRevisions-V100
     …
```

`diskutil info` read 953.7 GB immediately afterwards, against the 953.2 GB the
tool read at scan start — the volume is live and grew during the 13-minute scan.

The hand-rolled audit that produced this handoff had a **132 GB** unexplained
hole. It is now **56.2 GB**, and every remaining contributor is named on screen
instead of being invisible.

### Known limitation, unfixed

Parallelism is per-directory: one directory is one queue item, taken by one
worker. So a single pathological directory serialises the tail of a scan — the
other 15 threads finish and idle while one enumerates.

This run spent its last minutes exactly that way, inside a single application's
log directory under `/Library/Application Support/` that had accumulated **3.1M
files in one flat directory** (a crash-reporting loop writing ~36 files/minute for
60 days, 38 GB).

To be precise about what "big" means: the *directory itself* measured 99,184,928
bytes per `stat` — that is its entry storage, not any file inside it. Nothing read
a 99 MB file; a worker was calling `getattrlistbulk` in a loop over an enormous
entry list. For scale, `ls` on that directory never completed, and the cheapest
possible enumeration (name + type only) needed **357.8s at 8,671 entries/s**.

Splitting one directory's entries across workers would fix the serialisation, and
is not implemented.

**This is a case `tools du` should make easy to spot, and currently does not.**
A directory whose own `stat` size is tens of MB, or whose file count is in the
millions, is worth flagging on sight: it is both a scan bottleneck and almost
always a runaway-writer bug. Two cheap additions would surface it:

- a `--top-dirs-by-entry-count` style report, or simply flagging any single
  directory over ~100k entries in the `--depth` tree
- including the directory's own `stat` size in node output, since that is an O(1)
  proxy for entry count and needs no extra syscall

Until then the manual check is `stat -f '%z' <dir>` on anything that makes a scan
stall, and `tools du clonesize <dir> --changed-within 24h` to see whether it is
actively growing.

### Methodology warning that cost real time here

`tools <name>` runs the tool in a **child** bun process. Sampling or reading
`%CPU` from the process that `pgrep` finds first shows the *parent*, which sits in
`kevent64` at 0% CPU for the entire run and looks exactly like a hang. Two
"hangs" were diagnosed from that before the mistake was caught. Always resolve the
child (`pgrep -P <parent>`) before concluding anything about a running scan, and
prefer running `src/du/native/clonesize` directly when investigating.

---

## 2026-07-28 01:20 — Step 4: outside-scan sharing (handoff t10/t11)

### The bug being fixed

Scanning ONE SIDE of a clone pair reported the clone at full size with `0 B`
shared, because clone-dedup is only computed *within the scanned set* and nothing
in the output said so. `cp -Rcp orig clone` then scanning `clone` alone printed
naive 300 MB / unique 300 MB / shared 0 B — a free clone presented as a 300 MB
cost.

### Why the obvious detection does not work

The handoff suggested summing `allocsize − privatesize` per file. That fires just
as hard when BOTH sides are scanned (every file there is shared too), so it cannot
distinguish "shared with something I also counted" from "shared with something
outside". Working through the block algebra, the aggregate totals are degenerate:
`Σ(alloc − priv) − unique_shared − (naive − unique_alloc) ≡ 0` identically, so no
combination of existing scalars recovers the answer. It needs per-cluster file
identity.

### What was added

- `Ext` carries a `uint32 file` id, minted per worker without atomics (6 bits
  thread index, 26 bits sequence). **This grew the extent record from 24 to 32
  bytes**, which is the only reason this step needed a benchmark.
- The block-aligned merge pass sums the length of clusters touched by exactly ONE
  scanned file (`single_file`). Such a block was collected only because its file
  shares with *something* (fully private files are never opened), yet nothing else
  inside the scan references it.
- Those clusters also contain the file's own private blocks, so
  `outside_shared = single_file − Σ privatesize(opened files)`.

Human output now leads with `Deleting this frees ≥`, labels the unique figure
`(deduped WITHIN this scan only)`, and prints a yellow warning when
`outside_shared_bytes > 0`.

### Verification (the exact repro from the task)

```
scan PARENT (both sides)      naive 612.9 MB  unique 300.0 MB  shared 312.9 MB   no OUTSIDE line
scan ONE SIDE (clone only)    naive 300.0 MB  unique 300.0 MB  Shared OUTSIDE 300.0 MB + warning
```

Both halves of the acceptance hold: the one-sided scan surfaces ~300 MB, the
parent scan stays silent.

Incidentally, this repo reports **550 MB** of outside-scan sharing against the
wider volume — blocks shared with worktrees and the bun cache that a scan rooted
here counts as its own.

### Benchmark: the wider extent record

`--warmup 2 --runs 7`, T1 = repo root, previous commit's binary vs this one:

| | Wall mean ± σ | Wall min | System CPU |
|---|---|---|---|
| prev (`Ext` 24 B) | 12.117 s ± 0.751 s | 11.328 s | 66.506 s |
| now (`Ext` 32 B + file ids) | 13.271 s ± 2.489 s | **11.256 s** | 64.272 s |

The `now` mean carries an 18.6 s outlier (σ 2.489 s vs 0.751 s) from background
load. Judged the documented way — minima under load, and system CPU as the
tiebreak — the two are the same: minima differ by 0.6% in *favour* of the new
binary, and system CPU is 3% lower. No regression.

Correctness unchanged on T1: `extents` 472,443 and `files_opened` 468,220 are
byte-identical to the step-1 reference; byte totals track the live repo's drift.

Memory cost is real though unmeasured here: +8 bytes per extent is +3.8 MB on this
repo, but a whole-volume scan collects far more extents, so expect tens to
hundreds of MB more resident. Worth watching if a volume scan ever OOMs.

---

## 2026-07-29 06:14 — Review fix: file ids strided instead of bit-split

Not a feature. PR #296 review threads t23/t35 both flagged the same real defect in
the id minted by `next_file_id`, and the fix lands in the per-file hot path, so it
gets measured like everything else here.

### The defect

Ids were `(tid << 26) | (seq++ & 0x03FFFFFF)`: 6 bits of thread index, 26 bits of
sequence. `64 << 26` is 2^32, which is zero in a `uint32_t`, so worker 64 mints
exactly the same id sequence as worker 0. `--threads` accepts up to 1024
(`intOpt("--threads", { min: 1, max: 1024 })` in `src/du/index.ts`), so the
invariant the id scheme needed was never enforced anywhere. When two colliding
workers each hold a file whose blocks land in the same merged cluster,
`merge_pass` sees one file id instead of two, counts the cluster as single-file,
and inflates `outside_shared_bytes`. The 26-bit sequence was a second, softer
ceiling: 67M files per worker.

### The fix

Ids are now strided by the walk's worker count: worker `t` of `N` hands out
`t, t+N, t+2N, …`, so uniqueness holds at any thread count and the per-worker
file ceiling disappears. `spawn_walk` publishes `g_walk_threads` before creating
the workers; nothing else reads it, and `merge_pass` only ever compares ids for
equality, so no caller depended on the bit layout. The space still wraps at 2^32
ids, which is unreachable: every id owns at least one 32-byte `Ext`, so 4.3e9
files would be >137 GB of extent array and the scan dies on malloc first.

### Correctness

Old binary rebuilt from the pre-fix source into the scratchpad, so this is a true
A/B rather than a comparison against a stored number.

`node_modules`, `--json`, both thread counts, old vs new:

```
OLD t=16   extents 48483  unique_bytes 3318947018  outside_shared_bytes 361316352
OLD t=100  extents 48483  unique_bytes 3318947018  outside_shared_bytes 361316352
NEW t=16   extents 48483  unique_bytes 3318947018  outside_shared_bytes 361316352
NEW t=100  extents 48483  unique_bytes 3318947018  outside_shared_bytes 361316352
```

Byte-identical, i.e. the swap is output-neutral on the normal path. Note that the
100-thread OLD run did **not** diverge here: a collision additionally needs the
two colliding workers to hold files sharing one cluster AND to be at the same
sequence index, which is rare rather than impossible. The defect is proven by the
arithmetic, not by this run.

On a purpose-built fixture (40 x 2 MB files, `cp -Rc` clone, scanning ONE side)
the new binary returns `outside_shared_bytes = 83,886,080` identically at
`--threads` 1, 4, 16, 64, 100 and 300. Under the old scheme the 300-thread case
had no defined behaviour at all.

### Benchmark

`--warmup 2 --runs 7`, T2 = repo `node_modules`. Load average at run time:
**35.44** (busy machine).

| | Wall mean ± σ | Wall min | System CPU |
|---|---|---|---|
| OLD (bitfield id) | 1.717 s ± 0.261 s | 1.511 s | 9.773 s |
| NEW (strided id) | 1.619 s ± 0.056 s | **1.537 s** | 8.321 s |

**No regression.** Minima differ by 1.7%, far inside the documented 15% noise
band, and system CPU moved 15% in the new binary's favour. The change swaps a
shift+or for a multiply+add once per opened file, which is nothing next to the
~17 µs `open()` + `fcntl(F_LOG2PHYS_EXT)` + `close()` loop that the same file
pays for.

### `bench.sh` was aborting halfway (review thread t34)

Worth recording because it invalidates how the script's own output should be
read: `"$BIN" --json "$T1" | head -c 600` under `set -euo pipefail` killed the
run. The T1 JSON is ~213 KB (the `groups[]` array), far over the 64 KB pipe
buffer, so `head` closes the pipe, `clonesize` dies with SIGPIPE (141), and
`pipefail` propagates 141 into `set -e`. Reproduced directly: the script never
reached the line after the pipe. **Every `bench.sh` run since the extent-cache
section was added therefore skipped that section entirely.** Both pipes now
capture into a variable first and truncate from a herestring, verified to run
through to the end.

---

## 2026-07-29 06:57 — Review round (PR #302): tests only, native core untouched

**No benchmark was run, and none was needed.** This round changed no C: `git diff`
touches `src/du/lib/options.ts` (new), `src/du/lib/options.test.ts` (new),
`src/du/lib/cache.test.ts` (new), `src/du/index.ts` (imports), `src/du/lib/engine.ts`
(comment) and `src/utils/format.ts` (comment). `clonesize.c` is byte-identical, so
the hot loop cannot have moved. The rule in CLAUDE.md exists to catch unmeasured
*features*; recording the absence here keeps the log honest either way.

### What the new cache tests actually pin

eve's review thread t3 was right that the extent cache had ~200 lines of C and a
performance harness but no correctness suite. `src/du/lib/cache.test.ts` closes
that, darwin-gated (the fixture needs `cp -c`/clonefile(2)). Measured on a fixture
of one 4 MB file plus two clones:

| step | files_opened | files_cached | unique_bytes |
|---|---|---|---|
| cold (`--no-cache`, writes) | 3 | 0 | 4,194,304 |
| warm | 0 | 3 | 4,194,304 |
| after rewriting one clone in place | 0 | 2 | 8,388,608 |
| ground truth for that state (cache read off) | 2 | 0 | 8,388,608 |
| after corrupting the cache file | 3 | 0 | 4,194,304 |

Two things worth knowing for anyone extending these tests:

- **The rewritten clone is not re-opened, it is skipped.** Once it stops sharing
  blocks it becomes fully private, and the private-file skip
  (`priv >= alloc && nlink <= 1 && alloc >= dlen`) means it never gets opened at
  all. So the invalidation assertion has to be "totals track the no-cache ground
  truth", not "the file was re-opened".
- **A fully-warm scan skips the cache rewrite entirely** (`opened == 0` early
  return in `cache_write`). A carryover test that scans a subtree whose files are
  all already cached therefore never exercises the merge and passes vacuously. The
  test forces a miss by adding an unseen file first, then asserts
  `files_opened > 0` before checking the parent's records survived.

Carryover verified directly against the file header rather than inferred: `nrecs`
at offset 24 read **4** after a cold parent scan of 4 files, then **5** after a
scan of only the 2-file subdirectory. Truncation to the scanned subtree would have
left 2.

---

## 2026-07-29 07:05 — Review round 2 (PR #302): the eviction gap, answered

Still no C change, so still no benchmark owed (`clonesize.c` byte-identical since
`03a7ded22`).

Round 1 recorded `CACHE_MAX_RECS` eviction as an untested gap because crossing
2,000,000 records means creating two million shared files. The review asked the
obvious follow-up: can the branch be reached by forging the header's record count
instead of writing the files?

**No, and the reason is a guard worth knowing about.** `cache_open` computes the
bytes the header implies and refuses the file when they exceed its actual size:

```c
size_t need = sizeof(CacheHeader) + h->nrecs * sizeof(CacheEnt) + h->nexts * sizeof(CacheExt);
if (h->magic != CACHE_MAGIC || h->version != CACHE_VERSION || h->fsid != g_fsid ||
    need > (size_t)st.st_size) { munmap(...); return; }
```

Measured on the 3-file fixture: the real cache is **376 bytes** with `nrecs = 3`.
Forging `nrecs = 1,999,999` (offset 24) implies ~96 MB of records, so the whole
cache is dropped and the scan falls back to reading the filesystem:

| | files_opened | files_cached | unique_bytes |
|---|---|---|---|
| warm, real header | 0 | 3 | 4,194,304 |
| warm, `nrecs` forged to 1,999,999 | 3 | 0 | 4,194,304 |

So the forged-count route is closed by corruption detection, not by luck, and the
totals stay correct either way. Genuine eviction still needs 2M real records and
remains untested. `cache.test.ts` now pins the rejection.

### Also closed this round

`renderVolume` and `renderPartners` had zero coverage. Both are branch-heavy
(allocated-vs-mapped selection, `UNACCOUNTED` vs `over-counted`, cloud/mount/denial
sections, the 8-mount truncation, left-truncated paths), and one branch turned out
to be genuinely surprising: **`renderPartners` returns early when `partner_dirs` is
empty**, so a fixture with only `partner_files` never renders any file rows. A test
written without checking that passes for the wrong reason.

Worth recording for anyone extending `PartnersResult`: `clonesize_partners_json`
emits `denied_dirs` and `denied_files` but **never `denied_paths`**, so the partner
report's denial warning stands on counts alone and prints
`(N further denial(s) not listed)`.

---

## 2026-07-29 07:14 — Review round 3 (PR #302): eviction is reachable after all

Still no C change. This section exists to correct the one above, which overstated
its own result.

Round 2 claimed a forged record count "cannot reach the eviction branch". That is
wrong as written, and the review caught it. `cache_open`'s
`need > (size_t)st.st_size` is a **consistency** check, not a ceiling on the count:
it only rejects a cache too small for what its header claims. A file that claims
1,999,999 records **and is padded to actually hold them** passes it.

So eviction is testable in fixture time after all:

- header keeps the real magic / version / fsid, sets `nrecs = 1,999,999`, `nexts = 0`
- body is 1,999,999 zeroed `CacheEnt` records (48 bytes each) → 95,999,992 bytes
- the zeroed records have `fileid = 0`, so they match no real file: the scan opens
  all 3 fixture files and the byte totals stay correct
- `cache_write` then merges 1,999,999 carried-over records with this run's 3,
  reaching 2,000,002, which trips `n > CACHE_MAX_RECS` and the recency truncation

Result, measured: the rewritten cache holds **exactly 2,000,000** records, and the
whole scan takes **0.26s**. The eviction branch is now covered by
`cache.test.ts` ("evicts down to CACHE_MAX_RECS when the merged set overflows"),
and the full du + format suite still runs in well under a second.

The distinction worth keeping: the size check protects against an **inconsistent or
truncated** cache (out-of-bounds reads), and nothing more. It is not a bound on
`nrecs`, and it should not be described as one.
