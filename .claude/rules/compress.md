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
- **Every file written here is seekable zstd**: independent frames plus a seek table in a skippable frame. `zstd -d`,
  `rg -z` and any decoder read it as plain zstd. A tail read costs one frame (4 MiB for `text`).
- **Nothing is removed before it is verified.** Output goes through `atomicWriteFileStreamed` (temp file, fsync,
  rename). A file is decompressed and compared by size and sha256; a folder archive is listed and every file's sha256
  compared with the folder. The original goes only after that, and a file only when its size and mtime did not change
  while it was read.
- **A reader of compressed data opens either form.** Day logs: `dayLogPath` / `listDayLogs`
  (`@genesiscz/utils/logger/day-logs`) and `readLinesSync` / `readTextChunks` / `readLastLines`
  (`@genesiscz/utils/fs/read-lines`), which route a `.zst` path to the frame reader. rg over day logs:
  `ripgrepFiles` (`@genesiscz/utils/compress/search`), which feeds a `.zst` into rg's stdin through a pull stream.
  A new reader of a compressed store must do the same, in the same commit as the compression.
- **The 30% read budget.** A place may be stored compressed only when its real reading command stays within +30%
  of the plain time: `bun scripts/benchmarks/compress/read-paths.ts` (fresh processes, interleaved arms, medians, the
  load average in the notes, a check that the outputs agree). Day logs keep the last 7 days plain for that reason
  (`DAY_LOGS_PLAIN_DAYS`): `tools daemon stats --since 7d` cost +87% CPU with five compressed days.
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
