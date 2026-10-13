# Compression: what zstd costs here, and how to read compressed data cheaply

Measured 2026-10-13 on this Mac (Apple Silicon, load average 10 to 48 during the runs), Bun 1.4.2 and 1.3.13. Code:
`src/utils/compress/` (README there), benchmarks: `scripts/benchmarks/compress/`.

## Facts

- **Bun 1.3.13 `node:zlib` zstd reads only the first frame** of a multi-frame file (`zstdDecompressSync` and
  `createZstdDecompress`): 7,000 of 14,000 bytes, no error. `Bun.zstdDecompressSync` reads all frames on both
  versions. Split frames yourself (seek table, or 3-byte block headers) and decompress one at a time.
- **`node:zlib` is still the only compressor with parameters on 1.3.13** (checksum flag, long mode, window log). One
  frame per call is safe on both versions.
- **Async zstd runs on the thread pool.** Eight 8 MiB frames at level 9: 70 ms one after another, 10 to 15 ms with
  `Bun.zstdCompress` / `zlib.zstdCompress` in parallel. Independent frames are free parallelism.
- **Levels on a 1 GB day log** (one thread, 96 MB sampled): level 1 x18.0 at 778 MB/s, level 3 x20.0 at 646 MB/s,
  level 6 x21.5 at 257 MB/s, level 9 x22.2 at 251 MB/s, level 12 x22.4 at 153 MB/s. Level 3 is the text default:
  10% larger than level 9 at 2.6 times the speed. Decompression speed barely depends on the level.
- **`Uint8Array.from(typedArray)` iterates element by element.** In the frame writer it cost 2.0 s of CPU per
  116 MB; `new Uint8Array(typedArray)` (a memcpy) made it 0.18 s. Never use `.from` to copy a buffer.
- **`FileSink.write` in a loop does not apply backpressure.** Feeding rg's stdin that way held 519 MB RSS for a
  week of logs. Pass a pull `ReadableStream` as `stdin` instead (the next frame decompresses when rg asks): 133 MB.
  Frames decompressing ahead: 1 ahead 83 MB, 3 ahead 171 MB on a 1 GB file, no wall gain once rg is the consumer.
- **APFS clones make `du` lie.** Three `cp -c` backup runs showed 2.76 GB in `du` and 1.08 GB unique
  (`tools du clonesize`); removing one run freed about 1 MB, because a newer run shared its blocks. Pack clone
  families together, and measure with `clonesize`, not `du`.

## Reading compressed data: the 30% budget

`bun scripts/benchmarks/compress/read-paths.ts --runs 7`: the real commands, fresh processes, plain and `.zst` arms
interleaved, medians of 7, load 24 → 12, outputs equal in both arms.

| Scenario | Wall plain → zst | CPU plain → zst | Verdict |
|---|---|---|---|
| `tools daemon stats --since 7d` (5 of 7 days `.zst`, 3.5 GB) | 660 → 1408 ms (+113%) | 1101 → 2522 ms (+129%) | over: day logs keep 7 days plain |
| `tools daemon stats` (24 h, plain in both) | 379 → 375 ms | 497 → 493 ms | control |
| `tools jev sessions --day` (1.08 GB day) | 1742 → 1307 ms (-25%) | 1912 → 1721 ms (-10%) | faster: 4 MiB frames beat 64 KiB stream chunks |
| `tools ai-proxy calls --show` (144 MB transcript) | 536 → 575 ms (+7%) | 587 → 606 ms (+3%) | ok |
| `tools ai-proxy calls --show` (23 MB transcript) | 326 → 335 ms (+3%) | 356 → 364 ms (+2%) | ok |
| `{{tail n=1000}}` on a 292 MB day | 170 → 174 ms (+3%) | 175 → 181 ms (+3%) | ok: one frame from the end |
| `rg -c` on a 292 MB day: `rg` vs `rg -z` | 60 → 105 ms (+76%) | 59 → 164 ms (+179%) | over, by hand only; old days rarely |
| `tools compress cat | rg` vs `rg` | 58 → 226 ms | 57 → 356 ms | fallback when no `zstd` CLI |

Restoring a packed 68 MB app bundle (`restore.ts`, medians of 5): `cp -c -R` 101 ms, `cp -R` 306 ms,
`tools compress unpack` 531 ms (644 ms before the second decode pass went). A restore is a manual rollback, not a
read path.

Rules that follow:

- A scan of many large files (rg over a week of logs) pays the full decompression: about 0.4 to 0.6 s of CPU per GB
  here, against 0.02 to 0.06 s per GB for `rg` on a plain file in the page cache. Keep the window such scans read
  plain.
- A tail, a lookup or a line-by-line parse in JS costs the same or less from seekable frames: parsing dominates, and
  4 MiB frames are bigger chunks than `Bun.file().stream()` hands out.
- Cold page cache flips the result: a compressed week read 180 MB instead of 3.5 GB from disk (one cold sample:
  5.1 s plain, 1.5 s zst wall).
