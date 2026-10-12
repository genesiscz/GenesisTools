# Files: walking, reading, stat'ing

Contents: 1. the cost model · 2. walking · 3. reading the start or end of a file · 4. stat · 5. APFS and FSEvents ·
6. rejected ideas.

All numbers: this Mac, 2026-10-12, CPU ms, medians of 5 or more fresh processes, load 20 to 40.
Benchmarks: `scripts/benchmarks/fs/walk-primitives.ts`, `scripts/benchmarks/fs/read-primitives.ts`.

## 1. The cost model

- A syscall is a few µs. What adds up is (a) the number of syscalls, and (b) what JS does around each one.
- **Synchronous `node:fs` calls are thin**: `openSync` + `readSync` costs the same CPU as calling `open` + `pread`
  through `bun:ffi`. So FFI does not speed up a single read or stat.
- **Async `node:fs` and `Bun.file()` calls go through Bun's thread pool** and cost 2 to 5 times the CPU of the
  sync call for small operations. They pay off only when real I/O latency can overlap (network disks, cold
  caches); on a warm APFS volume they are pure overhead.
- **Streams are the most expensive way to read a little**: a stream's first chunk of 623 files cost 90 to 96 ms
  against 23 ms for `readSync`.
- **A sync loop blocks the event loop.** Tens of µs per file is fine for hundreds of files; past a few thousand,
  batch and yield (`fastWalk` yields every 256 directories) so a resident server keeps answering.

## 2. Walking: `fastWalk` (`src/utils/fs/native/fast-walk.ts`)

```ts
import { fastWalk } from "@genesiscz/utils/fs/native/fast-walk";

const { entries, errors, engine } = await fastWalk({
    roots: ["/Users/me/.claude/projects"],
    endsWith: [".jsonl"],          // file names that end with one of these
    names: ["chat_history.jsonl"], // or exactly these names (a file matching either is returned)
    maxDepth: 1,                   // the root is depth 0
    includeDirectories: false,
});
// entries: { kind: "file" | "directory" | "link", path, mtimeMs, size }[]
```

- On macOS it reads each directory with `getattrlistbulk` through `bun:ffi`: names, types, mtimes and sizes for a
  whole directory per call, so no file is stat'ed on its own. Elsewhere a JS walker (`readdir` with types, then
  `lstat`) returns the same entries. `engine: "js"` forces the fallback (tests run both).
- Measured, all 13,870 Claude transcripts: pure FFI 169 cold / 148 warm; C via clang 147 / 153; C via TinyCC
  190 / 151; `readdir` + `lstat` 485 / 468; the old `walkSourceRoots` + `stat` 424 / 207. Grok tree: FFI 46 / 35,
  JS 57 / 57. The older binding in `src/utils/macos/getattrlistbulk.ts` (disk usage, clones) took 798 against
  238 ms on the same files, because it decoded every name and read 64-bit fields with `BigInt`.
- Links below a root are returned as `kind: "link"` and not followed. Unreadable directories go to `errors` with
  their errno; the walk goes on.

## 3. The start or the end of a file: `readFirstLines` / `readLastLines` (`src/utils/fs/read-lines.ts`)

```ts
import { readFirstLines, readLastLines } from "@genesiscz/utils/fs/read-lines";

const head = readFirstLines(path);                       // { lines, wholeFile }, first 64 KB
const tail = readLastLines(path, { maxBytes: 256 * 1024 }); // last 256 KB
readLastLines(path, { method: "ffi" });                  // libSystem open/lseek/pread; same CPU
```

- One synchronous read into a shared buffer. A line cut by the edge of the read is left out; `readLastLines`
  keeps an unfinished last line (a writer may be in the middle of it). Empty lines and a trailing `\r` are removed.
- Both throw when the file cannot be opened (`ENOENT` and so on, the same shape as `node:fs`).
  `readTailBytes` (`src/utils/claude/session.utils.ts`) wraps `readLastLines` and returns `[]` for a missing file.
- Measured, first 64 KB of 623 Codex rollouts: `readFirstLines` 28.7 / 18.7, its FFI method 32.5 / 18.1,
  `Bun.file().slice().text()` 46 / 39, `fs/promises` 69 / 62, a stream's first chunk 96 / 90, whole files 403 / 385.
  Last 64 KB of 627 transcripts: `readLastLines` 30.7 / 19.3, FFI 31.3 / 20.2, one `slice()` 47 / 43, the two
  `slice()` calls the old `readTailBytes` made 71 / 61.
- Why bytes at all: Bun has no "first N lines" call. `slice(0, n).text()` also reads bytes, and is slower.

## 4. stat

- `statSync` 9.7 / 8.2 ms for 3,840 session files (about 2.5 µs each); `lstatSync` 9.5 / 7.7; FFI `stat` into a
  reused buffer 10.7 / 10.9; `fs/promises` `stat` all at once 38 / 42; `Bun.file().stat()` 43 / 39.
- A `stat` per file per call is cheap enough to keep caches exact (see `caching-and-freshness.md`). Do not trade it
  for a cached mtime.
- `struct stat` offsets on macOS arm64 (from a 10-line C program with `offsetof`): size 144, `st_mode` 4, `st_ino` 8,
  `st_mtimespec` 48, `st_ctimespec` 64, `st_size` 96. Print offsets with clang rather than guessing them.

## 5. APFS and FSEvents

- Appending to a file does NOT change its folder's mtime. A folder mtime check finds new files, not grown ones.
- `@parcel/watcher` `getEventsSince(dir, snapshot)` replays FSEvents history in about 1 ms of CPU. It is the cheap
  way to learn which files to re-stat; it is not a substitute for one full walk when the history is gone.
- Bun 1.3.13: every `fs.watch` created after the first `FSWatcher.close()` in a process goes deaf. Use the
  repository's `watchFileFeed` / `waitForPath` / `FileTailer` with a slow safety poll.
- On this Mac a full home-wide walk is never the answer; scope to the known roots.
- **A replay is not proof that nothing changed.** In 25 of 30 rounds, `getEventsSince` missed a write made just
  before the replay (0 of 30 after a 20 ms pause). The agent hooks therefore keep a real `git status` after every
  call; use a replay only to choose what to re-check, with a full check as the fallback.

## 5b. Threads that stat cost more CPU than one thread

- `git status` stats the index on up to 20 threads (`core.preloadIndex`, on above 1,000 entries). On this Mac at a
  load average of about 30 the threads contend in the kernel: 151 to 163 ms of CPU per status on a 9,278-file
  checkout, against 49 ms with `git -c core.preloadIndex=false status` (same output, wall 45 → 50 ms). The agent hooks
  run their status that way (`src/agents/lib/hooks/git.ts`, `statusOf`): a Bash tool call went from about 420 to
  220 ms of CPU. A `-c` flag applies to that one process and writes no config.
- The general lesson: more threads can lower the wall time and raise the CPU. When CPU is the metric, measure the
  single-threaded form too. The same held for parsing in Workers (`json.md`) and for `Promise.all` over async reads
  (372 ms of CPU against 220 ms for synchronous reads of the same 2,441 tails, though 180 against 206 ms of wall).
- Not enabled (a decision for Martin, measured in throwaway clones): `core.untrackedCache=true` brings a status to 24
  to 26 ms of CPU; `core.fsmonitor=true` with it to 8.6 to 9.3 ms, plus a monitor daemon per worktree.

## 6. Rejected after measuring

- **`statFiles`** (group known paths by folder, one `getattrlistbulk` per folder): 15 to 18 ms against 8 to 10 ms
  for a `statSync` loop. A bulk read pays for every entry of the folder plus its parse loop, and most Grok folders
  hold one asked file. Retested after fixing a real defect (a fresh 256 KB buffer per folder) in a balanced order:
  still slower.
- **An FFI `stat` or `pread` util**: equal CPU to the sync calls, more code.
- **`Bun.file().size` for a size check**: correct, but async helpers around it (`.exists()`, `.stat()`) cost more
  than `statSync` in a loop.
