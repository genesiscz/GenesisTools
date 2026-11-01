---
paths:
  - "src/utils/compress/**"
  - "src/compress/**"
  - "scripts/benchmarks/compress/**"
---

# Compression (src/utils/compress/, tools compress)

Loaded by Claude Code when you read, write or edit a file under `src/utils/compress/`, `src/compress/` or
`scripts/benchmarks/compress/`. The API, the presets, the ledger and the measured numbers are in
`src/utils/compress/README.md`; read it before you change a default.

- **Bun 1.3.13 is supported, and its `node:zlib` zstd stops after the FIRST frame** of a multi-frame file (sync and
  stream; 7,000 of 14,000 bytes in the probe), with no error. Never decompress a whole file with `node:zlib`. Read
  through `readZstdFramesSync` / `readZstdFrames` (frames found from the seek table or the block headers, one
  `Bun.zstdDecompress*` per frame). Compressing one frame with `node:zlib` is fine and is the only way to pass
  parameters (checksum, long mode).
- **On Bun 1.4.2 `node:zlib`'s zstd stream decodes every frame, and the frame walker still wins**, so it is used on
  both versions: full read 2.1 to 3.0 times faster in wall time and 2.6 times less CPU, a tail read 7 to 27 times
  faster (it decodes only the last frame), with byte-identical output on a 165 MB day log, a 144 MB transcript and a
  1.08 GB migrate-home archive (medians of 7, load 17 to 20). The stream needs less memory (55 to 95 MB against 87 to
  947 MB: the walker keeps 4 frames in flight, which is 4 × 32 MiB for a tree archive). Rerun:
  `bun scripts/benchmarks/compress/native-stream.ts`.
- **Every file written here is seekable zstd**: independent frames plus a seek table in a skippable frame. `zstd -d`,
  `rg -z` and any decoder read it as plain zstd. A tail read costs one frame (4 MiB for `text`).
- **Nothing is removed before it is verified.** Output goes through `atomicWriteFileStreamed` (temp file, fsync,
  rename). A file is decompressed and compared by size and sha256; a folder archive is listed and every file's sha256
  compared with the folder. The original goes only after that, and a file only when its size and mtime did not change
  while it was read: `compressFile` throws and writes nothing when the source is cut or extended during the read.
- **One daily pass per logs folder.** `runDailyCompression` holds `<logs>/.daily-compress.lock` for the whole pass,
  and a second caller returns `null` at once. `tools compress daily` opens the logger, which can start the detached
  pass beside it, and two passes over one file once deleted its only copy. A plain file that is already gone when it
  is to be retired keeps its verified `.zst`.
- **A removed file can still hold its blocks.** A process that has the file open keeps every block after the unlink:
  on 2026-11-01 31 handles of launchers and idle loggers kept 1.2 GB of removed day logs. So the logger opens its
  day file close-on-exec and closes it at midnight (an unref'd timer), and the daily pass cuts a removed plain file
  to zero through its own handle 10 s after its own removal (`releaseGraceMs`), when no folder names it any more. Each
  file has its own timer, so a pass over a backlog frees each file while it compresses the next one.
- **A reader of compressed data opens either form.** Day files (`<date>.log`, `<date>-profiling.log`,
  `<date>-failures.jsonl`): `dayLogPath` / `listDayLogs` (`@genesiscz/utils/logger/day-logs`, kind `log`,
  `profiling` or `failures`) and `readLinesSync` / `readTextChunks` / `readLastLines` (`@genesiscz/utils/fs/read-lines`),
  which route a `.zst` path to the frame reader. rg over day files: `ripgrepFiles` (`@genesiscz/utils/compress/search`),
  which feeds a `.zst` into rg's stdin through a pull stream and reports exit 2 with the error when a `.zst` does not
  open or decode (rg alone would see the end of its input and answer "no match"). Both also open a plain name whose
  file the daily pass replaced by its `.zst` (a path listed before the pass, or built by hand), and so do the
  `{{lines}}`, `{{file}}`, `{{json}}`, `{{symbol}}` and `{{tail}}` tokens and `tools compress cat`. The app launcher
  reads only today's and yesterday's failures (`LauncherFailures.swift` `recorded`), which stay plain. A new reader of
  a compressed store must do the same, in the same commit as the compression.
- **The 30% read budget.** A place may be stored compressed only when its real reading command stays within +30%
  of the plain time: `bun scripts/benchmarks/compress/read-paths.ts` (fresh processes, interleaved arms, medians, the
  load average in the notes, a check that the outputs agree). Day files keep only today and yesterday plain
  (`DAY_LOGS_PLAIN_DAYS = 2`). The one reader over many days, `tools daemon stats --since 7d`, cost +113% wall and
  +129% CPU with five compressed days while it searched every day on every run; it now keeps the health lines of
  finished days (`ripgrepFilesCached`, a digest per search in `logs/.digests/`, keyed by file identity, which the daily
  pass carries to the `.zst`), so a warm run searches only today. A new reader that scans many finished days must keep
  its per-day results the same way, or the window it scans stays plain.
- **A level is chosen by who waits for the write, not by the read.** The frame header carries the frame's size, so the
  decoder's window is one frame at most at every level, and reads cost the same at levels 3 to 22 (2026-11-01,
  `bun scripts/benchmarks/compress/levels.ts`). The rule: the lowest level after which the next measured level
  costs more than 10 times the CPU per extra MB saved. That is level 9 for the daily pass, folder archives (long),
  the bundle pack that every `bun run app` waits on (long) and databases; only the hand-picked `max` is 22 long.
  Level 19 and 22 cost 20 to 100 times the CPU for a few percent (the owner rejected them on 2026-11-01). Change a
  level only with a new run of that bench.
- **Media is left alone.** `tools compress pack` runs a level-3 trial on a sample and skips under 30% saving
  (`DEFAULT_MIN_SAVING`); photos, video and audio measured 0.2-7%.
- **APFS clones.** `cp -c` backups share blocks, so `du` over-counts and removing one clone frees almost nothing.
  Measure with `tools du clonesize <dir>` before and after, and pack clone families together (`keepMaxAgeDays`).
- **Copy typed arrays with `new Uint8Array(view)`, never `Uint8Array.from(view)`**: `from` iterates byte by byte and
  cost 2.0 s of CPU per 116 MB in the frame writer (0.18 s after the change).
- **Every operation lands in the ledger** (`~/.genesis-tools/compress/ledger.jsonl`, `recordCompression`), with the
  caller name. Pass a new caller name for a new automatic pass.
- Tests: `src/utils/compress/compress.test.ts` (one file on purpose, see `.claude/rules/tests.md`). Prove a new test
  with a planted regression.
