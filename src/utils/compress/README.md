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
| Lines, first lines, last lines of plain or `.zst` | `readLinesSync`, `readFirstLines`, `readLastLines`, `readTextChunks` | `fs/read-lines.ts` |
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

## Presets

See the measured table below. `text` keeps 4 MiB line-aligned frames so tails stay cheap; `tree` and `binary` use
32 MiB frames with long mode (128 MiB window) so repeats across files are found; `media` stores. `tools compress pack`
refuses below 30% trial saving (`DEFAULT_MIN_SAVING`, `--min-saving`), with the measured media numbers in the message.

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

So `text`, `binary` and `database` use level 3 (the next levels add 1 to 3 points at a third of the speed), `tree`
uses level 6 with long mode (+4.5 points on `node_modules/typescript`, where files repeat), `max` is level 19 long
for archives kept for long. On a 1 GB day log level 3 compressed x20.0 at 646 MB/s and level 9 x22.2 at 251 MB/s.

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
