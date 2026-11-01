# @genesiscz/utils/compress

zstd for data that is written once and read later: day logs, transcripts, backup runs, retired app bundles. The
command-line front is `tools compress` (`src/compress/README.md`). Rules for changing this folder:
`.claude/rules/compress.md`.

## Format

- **Seekable zstd.** Input is cut into independent frames (`frameBytes`, 4 MiB for text, line-aligned) and a seek table
  goes into a trailing skippable frame (the zstd `contrib/seekable_format` layout). Any zstd decoder reads the file as
  plain zstd: `zstd -d`, `zstdcat`, `rg -z`. Our reader uses the table to decompress only the frames it needs: a tail
  read costs one frame.
- **A folder is `<folder>.zst`**: a tar stream (system `tar`, `--no-xattrs`, `COPYFILE_DISABLE=1`) inside seekable
  zstd. `<folder>.tar.zst` is accepted as well. `isTarArchive` tells a packed folder from a compressed file by the
  `ustar` magic in the first frame.
- **Checksums.** Every frame carries zstd's content checksum (xxh64), so a decoder rejects a damaged frame.

## Why the reader walks frames (Bun 1.3.13)

Bun 1.3.13 is still supported. Its `node:zlib` zstd, both `zstdDecompressSync` and `createZstdDecompress`, stops after
the FIRST frame of a multi-frame file and returns a short result with no error (probe on 2026-10-13: 7,000 of 14,000
bytes; Bun 1.4.2 reads all). `Bun.zstdDecompressSync` reads every frame on both versions. So the readers find the
frames themselves (seek table, else a walk over frame and block headers, 3 bytes per block, nothing decompressed) and
decompress one frame at a time with `Bun.zstdDecompress*`. Memory holds one frame (or `concurrency` frames). Writing
uses `node:zlib`'s one-frame compressor, the only API that takes parameters (checksum, long mode) on 1.3.13. No FFI:
`Bun.zstd*` decompresses at about 1.5-2 GB/s per core on these logs, and the frame walk covers seeking.

## API

| Need | Function | File |
|---|---|---|
| Compress a file to `<file>.zst` (atomic, mode kept) | `compressFile` | `file.ts` |
| Check a `.zst` against the original's digest | `verifyCompressedFile`, `digestZstdContent` | `file.ts` |
| Decompress to a file | `decompressFile` | `file.ts` |
| Frames of a file, sync or ahead on the thread pool | `readZstdFramesSync`, `readZstdFrames` | `zstd.ts` |
| Write seekable frames from a stream | `SeekableZstdWriter` | `zstd.ts` |
| Compress a stream, or several outputs together, verified and atomic | `createVerifiedZstdWriter`, `createVerifiedZstdBatch`, `compressStream` | `verified.ts` |
| Lines, first lines, last lines of plain or `.zst` | `readLines`, `readLinesSync`, `readFirstLines`, `readLastLines`, `readTextChunks` | `fs/read-lines.ts` |
| Lines of any byte stream (stdin, a ranged `createReadStream`), cut at `\n` only | `splitLines`, `splitLinesSync` | `fs/read-lines.ts` |
| rg over plain and `.zst` files (no zstd CLI) | `ripgrepFiles`, `zstdContentStream` | `search.ts` |
| Pack, list, unpack, verify a folder | `packDirectory`, `listArchive`, `unpackArchive`, `verifyArchiveAgainstFolder` | `tar.ts` |
| One safe compress or restore with a ledger entry | `planCompressPath`, `compressPath`, `expandPath`, `verifyPath` | `operations.ts` |
| Keep N folders, pack older, cap archives | `planFolderRetention`, `applyFolderRetention` | `retention.ts` |
| Compress day-stamped files once their day is over | `planOldFileCompression`, `applyOldFileCompression` | `retention.ts` |
| The daily pass (day logs, ai-proxy transcripts) | `runDailyCompression`, `dailyTargets` | `daily.ts` |
| Presets, sniffing, trials | `PRESETS`, `resolvePreset`, `tryPresets`, `trialSaving` | `presets.ts` |
| The ledger | `recordCompression`, `searchLedger` | `ledger.ts` |
| Day log paths (plain or `.zst`) | `dayLogPath`, `listDayLogs` | `logger/day-logs.ts` |

Every `plan*` function only reads: it is the dry run. Every `apply*` function removes an original only after the
output checked out (file: size and sha256 of the decompressed content; folder: every entry, size and file sha256),
and a file only when its size and mtime did not change while it was read.

## Who uses it

| Data | Policy | Reader |
|---|---|---|
| `~/.genesis-tools/logs/<date>.log`, `<date>-profiling.log` | daily pass: older than 7 days become `.zst` | `tools daemon stats`, `tools jev sessions`, `{{tail}}`, `poll-duty.ts`, `rg -z` |
| `~/.genesis-tools/ai-proxy/transcripts/<UTC day>/<session>.jsonl` | daily pass: older than yesterday (UTC) become `.zst` | `tools ai-proxy calls --show` |
| `~/.genesis-tools/codex/migrate-home/<stamp>/` | after each applied run: newest 2 runs of the last 14 days stay folders, the rest `<stamp>.zst` | restore: `tools compress unpack` |
| `~/.genesis-tools/app/retired.noindex/<ms>/` | after each build: newest 2 and every running bundle stay folders, idle ones `<ms>.zst`, at most 5 and 14 days | restore: `tools compress unpack` |

The daily pass starts at most once per day per log folder: the logger calls `startDailyCompressionOnce` when it opens
a day's file, which costs one `existsSync` of `.daily-compress-<day>` and, for the first process of the day, one
exclusive create and a detached low-priority `bun src/utils/compress/daily-pass.ts`. Off in tests and with
`GENESIS_TOOLS_NO_DAILY_COMPRESS=1`. `tools compress daily --dry-run` shows what it would do.

## Compressing a stream, verified

For bytes that are not a file yet (a log rotation's day lines, a generated export), use `verified.ts` instead of a
hand-rolled `.partial` file, hasher and rename:

```ts
import { createVerifiedZstdBatch } from "@genesiscz/utils/compress";

const batch = createVerifiedZstdBatch({ caller: "my-rotation", preset: "text", source: livePath });
try {
    const day = batch.add(`${base}-2026-10-31.jsonl.zst`);
    await day.push(lineBytes); // await each push
    await day.finish(); // the day is complete: written, closed and read back now, renamed with the batch
    await batch.commit(); // every output verified, then every one renamed; one failure renames none
} finally {
    batch.abort(); // no-op after a commit
}
```

- A writer writes `<target>.<pid>.<n>.partial` next to the target through `SeekableZstdWriter` (the preset's frames,
  default `text`), hashing what it is given. `commit()` finishes the frames, fsyncs, reads the file back with
  `verifyCompressedFile` (decompressed size and sha256 must equal the input) and only then renames it over the target.
  A failed push, write or read-back removes the partial and leaves an existing target byte for byte as it was
  (`ZstdVerificationError` names the targets).
- A batch verifies every output before it renames the first. Call `finish()` on a member once its input is complete:
  until then it keeps its file open and up to `threads` frames in memory (16 MiB for `text`). The renames are not one
  atomic step: a rename that fails after all verified (the folder removed meanwhile) leaves the earlier outputs
  renamed and removes the rest.
- Each commit lands in the ledger as `op: "compress"` with the options' `caller` and `source` (default `stream`).
  `compressStream(chunks, { target, caller })` is the one-output form for an iterable.
- Read the result with `readLines` / `readLinesSync` (`@genesiscz/utils/fs/read-lines`): they open plain and `.zst`
  files and give both the same lines. Lines are cut at `\n` only, never at a lone `\r`, U+2028 or U+2029 (a CRLF line
  keeps its `\r`, as `text.split("\n")` does; content that ends with `\n` yields a final empty line). Never read JSONL
  with `node:readline`: it ends lines at U+2028 and U+2029, which `JSON.stringify` leaves raw inside strings, and it
  cut 144 records of a hook log in two (2026-11-01). `splitLines(stream)` does the same for stdin or a byte range.

## Presets

| Preset | Level | Frames | Written by | Read |
|---|---|---|---|---|
| `text` | 22 | 4 MiB, line-aligned, 4 threads | the daily pass (day logs, profiling logs, ai-proxy transcripts, hang captures); `tools compress pack` of a text file | rarely: a day older than a week, a transcript older than yesterday (`jev sessions`, a tail, `ai-proxy calls --show`, `rg -z` by hand) |
| `tree` | 19, long mode | 32 MiB, 4 threads | migrate-home backups at the end of an applied `tools codex migrate-home`; `tools compress pack <folder>` | on a restore only |
| `binary` | 9, long mode | 32 MiB, 4 threads | retired app bundles, in every `bun run app` | on a rollback only |
| `database` | 19 | 16 MiB, 4 threads | `tools compress pack` of a database copy | on a restore only |
| `media` | stored | 32 MiB | nothing without `--force` | |
| `fast` | 1 | 4 MiB, 4 threads | `--preset fast` | |
| `max` | 22, long mode | 32 MiB, 8 threads | `--preset max`, `tools compress try` | |

`compressFile` takes the `text` settings and `packDirectory` the `tree` settings for anything the caller leaves out;
`--level` overrides a preset. Long mode has a 128 MiB window, so repeats across the files of a folder are found.
`tools compress pack` refuses below 30% trial saving (`DEFAULT_MIN_SAVING`, `--min-saving`), with the measured media
numbers in the message.

**How the levels were chosen** (`bun scripts/benchmarks/compress/levels.ts --samples <dir> --work <dir>`,
2026-11-01, Bun 1.4.2). Real data copied into a scratch folder: day logs, a profiling log, a failures log, ai-proxy
transcripts, hang captures, a Codex rollout, a migrate-home run and a retired app bundle as tar streams, the
`src/utils` tar, a generated SQLite file. Each sample went through `compressFile` with its preset's frames, line
alignment and threads, and only the level changed. Every step ran in a fresh process; medians of 3 compressions and
of 7 reads, the read arms rotated each run, and every output decoded to the sample's sha256. The load average was 20
to 88 on 16 cores, so the numbers are CPU time, not wall time.

1. **The level hardly changes the read.** Each frame header carries the frame's size, so at every level the decoder
   needs a window of at most one frame (4 MiB for `text`, 32 MiB for `tree`). Day logs, profiling logs and
   transcripts read within -9 to +4 ms of process CPU of level 3 at levels 19 and 22 (full reads, tails, rg runs),
   and the peak memory of a read did not move with the level (text 39 to 88 MB, trees 56 to 127 MB). The 17 MB app
   bundle tar read 7 to 9 ms slower at every level above 3; the read alone cost the same at 9 as at 3 (21 ms) and 3
   to 6 ms more at 19 and 22. Only the Codex rollout, which compresses to x1.9 and which Codex writes itself, decoded
   13% slower at 19 and 22. So the 30% read budget holds at the new levels wherever it held at level 3 (Numbers).
   The real-command run (`read-paths.ts`) was not repeated at the new levels: it needs several GB of free disk, and
   the disk had under 1 GB free that day. `ripgrepFiles` on a `.zst` costs +20% to +40% against plain rg at every
   level, level 3 included: that is the pipe into rg, and it is why day logs keep 7 days plain.
2. **`text` 22: the daily pass, where nothing waits.** It runs in a detached process at priority 15
   (`startDailyCompressionOnce`), and the plain file stays until its `.zst` is verified. Level 19 is 23% to 39%
   smaller than level 3 on every text sample the pass writes (hang captures 7%). Level 22 is 0% to 2.5% smaller again
   on the samples and 5% on a whole day log, for 1.1 to 2.2 times the CPU of 19. A real 696 MB day log through the
   pass's own steps (`compressFile` with `text`, then `verifyCompressedFile`, priority 15, medians of 3, load 26 to
   101):

   | Level | Output | CPU | Wall | Peak RSS | Verify CPU |
   |---|---|---|---|---|---|
   | 3 | 8.3 MB (x84) | 0.8 s | 1.3 s | 228 MB | 0.34-0.40 s |
   | 19 | 6.1 MB (x114) | 41 s | 24 s | 407 MB | 0.35-0.36 s |
   | 22 | 5.8 MB (x120) | 69 s | 43 s | 475 MB | 0.35-0.39 s |

   The largest file the pass has met, a 4 GB ai-proxy session transcript, costs about 10 minutes of CPU at level 22
   (6.7 MB per CPU second; 9 minutes at 19). A `tools compress pack` of a large text file by hand is slow at this
   level: pass `--level` or `--preset fast` when the time to write matters.
3. **`tree` 19 long: written rarely, kept for months, read only on a restore.** Level 19 long is 6% smaller than
   level 6 long on a migrate-home run and 17% smaller on `src/utils`. Level 22 saves 0.2% to 0.4% more at 1.3 to 1.7
   times the CPU and twice the memory (565 MB). Cost: about 3.5 CPU minutes per 1 GB run, roughly a minute of wall
   time on 4 free cores at the end of `tools codex migrate-home` (4 such packs in the ledger since 2026-10-13).
   Without long mode the migrate-home run compressed x3.0 to x3.7 below level 19, against x5.1 to x5.5 with it.
4. **`binary` 9 long: every app build waits for it.** One retired bundle of about 145 MB is packed per `bun run app`.
   Level 9 long is 11% smaller than level 3 long for about 1.3 s more CPU; level 12 saves 3% more for twice the CPU,
   level 19 saves 6% more for 40 s per build. At most 5 packed bundles are kept for 14 days, so the whole difference
   between 9 and 19 is about 20 MB.
5. **`database` 19: by hand only.** Level 19 is 27% smaller than level 9 on the SQLite sample at 2 MB per CPU second
   (about 8 CPU minutes per GB); level 22 is larger than 19 there.
6. **`max` 22 long: the most zstd does**, for an archive packed by hand to keep for long. `fast` stays at level 1,
   `media` stores.

Compression per level (cells: ratio, then MB compressed per CPU second, all threads counted):

| Sample | MB | level 3 | level 6 | level 9 | level 12 | level 15 | level 19 | level 22 |
|---|---|---|---|---|---|---|---|---|
| day log, a 39 MB day | 39 | x18.4 508 | x21.7 244 | x23.2 186 | x23.7 123 | x24.0 29 | x28.2 2.6 | x28.6 1.7 |
| day log, 34 MB of a 1.7 GB day | 34 | x128 774 | x143 641 | x156 555 | x157 434 | x162 187 | x179 25 | x183 11 |
| profiling log | 34 | x9.3 331 | x10.9 176 | x11.8 129 | x12.3 73 | x12.9 21 | x15.2 4.2 | x15.3 3.5 |
| failures log | 1.7 | x12.3 195 | x13.8 140 | x14.5 121 | x14.9 92 | x15.2 29 | x16.0 9.8 | x16.1 5.2 |
| ai-proxy transcript, 33 MB of a 4 GB session | 33 | x5.2 247 | x5.8 135 | x6.5 105 | x6.5 65 | x6.6 8.1 | x6.8 7.2 | x6.8 6.7 |
| ai-proxy transcript, `_untagged` | 33 | x19.4 386 | x23.3 269 | x27.1 221 | x27.3 155 | x27.7 14 | x29.3 18 | x29.3 14 |
| hang and stack captures, 40 files | 0.3 | x3.7 6.9 | x3.9 7.0 | x3.9 6.9 | x3.9 5.8 | x3.9 4.9 | x4.0 3.8 | x4.0 3.4 |
| Codex rollout (Codex writes its own `.zst`) | 34 | x1.8 137 | x1.8 87 | x1.8 64 | x1.9 39 | x1.9 16 | x1.9 6.5 | x1.9 6.3 |
| migrate-home run (tar), long | 34 | x5.1 194 | x5.3 123 | x5.4 92 | x5.4 67 | x5.5 22 | x5.6 4.7 | x5.6 2.8 |
| migrate-home run (tar), no long | 34 | x3.0 177 | x3.1 101 | x3.7 79 | x3.7 48 | x3.7 12 | x5.6 4.9 | x5.6 3.1 |
| `src/utils` (tar), long | 16 | x4.3 166 | x4.7 101 | x4.9 72 | x5.1 40 | x5.2 7.9 | x5.7 3.4 | x5.7 2.7 |
| retired app bundle (tar), long | 17 | x2.1 138 | x2.2 80 | x2.3 63 | x2.4 30 | x2.4 7.2 | x2.5 3.7 | x2.5 3.2 |
| SQLite (generated) | 22 | x6.0 281 | x7.3 148 | x7.5 101 | x7.5 47 | x7.5 7.3 | x10.3 2.0 | x10.1 1.0 |

Peak RSS while compressing with 4 threads: 86-160 MB at level 3, 97-215 MB at 9, 169-491 MB at 19, 361-609 MB at 22.

Reads per level (CPU ms of the whole process, the read alone in parentheses; Bun's start is about 45 ms):

| Read | plain | level 3 | level 9 | level 19 | level 22 |
|---|---|---|---|---|---|
| day log (39 MB day), every line (`readLinesSync`) | 104 (39) | 107 (46) | 101 (45) | 105 (49) | 104 (49) |
| day log, last 64 KiB (`readLastLines`) | 51 (0) | 51 (1) | 49 (1) | 52 (1) | 50 (1) |
| day log, `ripgrepFiles -c` (rg's CPU included) | 87 | 111 | 118 | 112 | 115 |
| profiling log, every line | 100 (51) | 111 (65) | 101 (58) | 104 (58) | 103 (57) |
| transcript (4 GB session), every line | 69 (22) | 78 (31) | 76 (30) | 80 (31) | 78 (31) |
| transcript (`_untagged`), every line | 98 (28) | 98 (31) | 91 (29) | 95 (32) | 94 (30) |
| migrate-home tar, every frame (`readZstdFramesSync`) | 62 (14) | 78 (29) | 79 (30) | 79 (30) | 76 (30) |
| app bundle tar, every frame | 69 (8) | 75 (21) | 84 (21) | 84 (27) | 82 (24) |

## Numbers

Measured 2026-10-13 (Apple Silicon, Bun 1.4.2; the format checks also pass on 1.3.13).

**Settings per kind of data** (`bun scripts/benchmarks/compress/presets.ts`, one thread, samples up to 64 MiB; cells:
saving, compress MB/s / decompress MB/s of CPU):

| Data | MB | level 1 | level 3 | level 6 | level 6 long 32M | level 9 | level 19 long 32M |
|---|---|---|---|---|---|---|---|
| text (repo .ts) | 45 | 73.6% 387/1353 | 76.1% 280/1368 | 79.0% 107/1170 | 79.1% 101/1328 | 79.7% 81/1470 | 83.1% 3/1362 |
| jsonl (day log) | 67 | 96.5% 1818/3571 | 96.9% 1646/3618 | 97.4% 544/3936 | 97.5% 322/3575 | 97.6% 440/4316 | 98.4% 5/3633 |
| tree (src/utils tar) | 14 | 74.0% 426/1425 | 76.3% 302/1453 | 78.8% 120/1480 | 78.9% 111/1432 | 79.5% 85/1506 | 82.5% 4/1474 |
| tree (typescript tar) | 24 | 79.3% 420/1449 | 82.0% 353/1571 | 84.4% 129/1493 | 88.9% 111/1401 | 85.2% 93/1582 | 91.4% 5/1949 |
| binary (biome) | 60 | 62.2% 510/1172 | 66.5% 347/1176 | 68.3% 129/1228 | 68.9% 117/1170 | 69.3% 99/1156 | 74.3% 4/916 |
| database (sqlite) | 22 | 83.5% 610/1418 | 83.5% 468/1374 | 86.2% 178/1568 | 86.1% 153/1430 | 86.5% 129/1598 | 90.3% 2/1165 |
| media (random) | 17 | 0% | 0% | 0% | 0% | 0% | 0% |

Until 2026-11-01 these numbers set `text`, `binary` and `database` to level 3, `tree` to level 6 with long mode
(+4.5 points on `node_modules/typescript`, where files repeat) and `max` to level 19 long; Presets has the run behind
today's levels. On a 1 GB day log level 3 compressed x20.0 at 646 MB/s and level 9 x22.2 at 251 MB/s.

**Media, measured on the owner's own photos, video and documents** (zstd -19 --long=27 and --ultra -22 --long=31 nearly identical):
.mov 1.05%, .mp4 0.2-0.9% for camera and phone video (13.9% for CleanShot screen recordings, 35.5% for three
screen-recording-like files), .png 0.0-5.4%, .heic 0.2-1.9%, .jpg 0.2-4.4%, .webp/.tgs/.pkpasses about 0%, .wav 7.2%,
.m4a 4.9%, .mp3 1.0%, .pdf 19-29%, .docx 4-8%, .xlsx 13.8%; text .html 93.7%, .css 79%, .js 72%, .py 74%, .md 57%,
.ics 43%, .aae 34%. 400 JPGs in one tar: 6.7%. A lossless JPEG XL transcode (`cjxl --lossless_jpeg=1`, bit-exact
reversible) saved 18.7% on 60 JPGs, still under the 30% rule, so there is no JPEG XL preset.

**The read budget** (`bun scripts/benchmarks/compress/read-paths.ts --runs 7`, real commands, fresh processes,
arms interleaved, medians of 7, load 24 → 12, outputs equal):

| Command | Wall plain → zst | CPU plain → zst |
|---|---|---|
| `tools daemon stats --since 7d`, 5 of 7 days compressed | 660 → 1408 ms (+113%) | 1101 → 2522 ms (+129%) |
| `tools daemon stats` (24 h, plain in both) | 379 → 375 ms | 497 → 493 ms |
| `tools jev sessions --day` (1.08 GB day) | 1742 → 1307 ms (-25%) | 1912 → 1721 ms (-10%) |
| `tools ai-proxy calls --show` (144 MB transcript) | 536 → 575 ms (+7%) | 587 → 606 ms (+3%) |
| `tools ai-proxy calls --show` (23 MB transcript) | 326 → 335 ms (+3%) | 356 → 364 ms (+2%) |
| `{{tail n=1000}}` (292 MB day) | 170 → 174 ms (+3%) | 175 → 181 ms (+3%) |
| `rg -c` (292 MB day), `rg` vs `rg -z` | 60 → 105 ms (+76%) | 59 → 164 ms (+179%) |
| `tools compress cat | rg` vs `rg` | 58 → 226 ms | 57 → 356 ms |

The first row is why day logs keep 7 days plain: a week-long rg scan decompresses everything. With that window no
GenesisTools command reads a compressed day log in its default or widest window; `jev sessions`, tails and
transcripts read the compressed form within budget (or faster). An `rg -z` by hand on a day older than a week is the
one path over 30% (+45 ms per 292 MB day).

**Restore** (`bun scripts/benchmarks/compress/restore.ts --runs 5`, a 68 MB app bundle): `cp -c -R` 101 ms, `cp -R`
306 ms, `tools compress unpack` 531 ms.

**First application, 2026-10-13** (before → after): migrate-home 2.70 GB → 0.68 GB in `du` (1.08 GB unique by
`tools du clonesize` → 0.68 GB, the runs were clones of each other); retired app bundles 768 MB → 542 MB (four idle
bundles 68 → 13.4 MB each; five more are pinned by running processes); day logs and profiling logs older than a week
2.91 GB → 118 MB (117 files; the `logs/` folder 7.0 GB → 3.98 GB, the rest is the last 7 days, three of them 1 GB
days from the test leak before #490, which age out by 2026-10-17); ai-proxy transcripts 402 MB → 34 MB; hang
captures 502 MB → 28 MB; two stale diagnostic captures 176 MB → 11 MB.
