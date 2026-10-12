---
name: performance
description: Measuring and improving CPU, I/O and latency in the GenesisTools Bun/TypeScript code — CLI tools, the usage daemon, the hub server, session discovery and listing, file walking and reading, JSON parsing, bun:ffi and native code. Use it whenever a tool, command, daemon tick or server door is slow or burns CPU, before and after any change meant to make something faster, when you profile, benchmark, A/B or compare two ways of doing something, when you consider bun:ffi, TinyCC, a C helper or a cache, and when you write a performance number into a commit, note or ledger — even when the user only says "this is slow", "why does it take 1 s", "can we make it faster", "is FFI faster", "measure it", or asks whether a cache would show stale data. For SwiftUI/AppKit app performance use the swift skill; this one covers the Bun side it calls.
---

# Performance work in GenesisTools (Bun / TypeScript)

Most slowness here is not a slow algorithm. It is work repeated because nothing remembered the last answer
(re-reading and re-parsing files that did not change), work done on the wrong layer (a process per call, a stream
per file, comment-json for plain JSON), or async overhead around tiny system calls. The fixes that paid off on
2026-10-12 were all found by measuring first, and two plausible ideas (`statFiles`, an FFI `stat`) were slower when
measured. So the rule of this skill is simple: no change, and no claim, without a number from the real thing.

## The workflow

1. **Find where the time goes before choosing a fix.** Run `tools ts profile <entry or tool> -- <args>` (a
   pprof-style CPU profile of any entry point, no timers added) and read the repository call tree. Add `--threads`
   when CPU (all threads) is much larger than the sampled JS time: then the cost is on Bun's pool threads (file
   opens, async fs). Details and caveats: `references/profiling.md`.
2. **Record a baseline before editing.** Put a benchmark under `scripts/benchmarks/<area>/`, run it with
   `--baseline`, and commit the baseline file. A number taken after the change has nothing to be compared with.
   Harness and method: `references/measuring.md`.
3. **Change one thing, then A/B it.** Fresh processes, interleaved arms, medians of at least 5 to 9 samples, CPU
   time as the metric, the load average written down, and a check value that must agree between the arms (same
   rows, same line count). If the arms share an on-disk cache, use blocks (BBBB AAAA ...) and drop the first run
   of each block. A single run is an observation, never a result.
4. **Prove the test catches the problem.** A new test must fail on the old code (negative control) and pass on
   the new code. Run the full suite (`bun run test`) when a change reaches shared code such as `SafeJSON`.
5. **Ledger it.** Append the before value, after value, cause, commit and command to
   `.claude/docs/performance.md` in the main checkout. Put the numbers in the commit subject. Format:
   `references/ledger.md`.

## Rules that are not negotiable

- **Never show staler data.** A cache may skip work only for input that provably did not change. Re-read each
  file's identity (inode, size, mtime, ctime) on every use and cache only the expensive result derived from it.
  Do not cache an mtime in place of checking it, and do not "skip the rebuild when nothing changed" unless every
  input is covered. Time-derived fields (a cache countdown) are computed at serve time. More live is the goal.
  `references/caching-and-freshness.md`.
- **The hub server and GenesisTools.app are optional.** Every caller must still answer with its own work when no
  server answers. A speed-up must not create a dependency on either.
- **CPU time is the metric, wall time is context.** This Mac often runs at a load average of 20 to 40, which moves
  wall time a lot and CPU time little. Note `uptime` before and after a run.
- **Measure the real input.** Use the real session trees and transcripts (read-only), not a synthetic folder of
  ten files. Write the sizes into the result (files, lines, MB).
- **Bun 1.3.13 is still supported.** A Bun 1.4-only API (for example `Bun.JSONL`) may appear in a benchmark arm,
  never in shipped code.
- **Diagnostics never mutate** (repository rule). A benchmark reads live data; it never rewrites it.

## Which tool answers which question

- "Which function is slow?" → `tools ts profile` (`references/profiling.md`).
- "Which thread, or which system call?" → `tools ts profile --threads`, or `/usr/bin/sample <pid> <secs> 1 -mayDie`.
- "How long does each phase take in production?" → the repository profiler: `PROFILE=<scope>` per run, lines in
  `~/.genesis-tools/logs/<date>-profiling.log` (the usage daemon logs `tick.*` CPU there on every tick).
- "Is A faster than B?" → a benchmark pair under `scripts/benchmarks/`, A/B in fresh processes.
- "What is burning CPU right now?" → `tools doctor cpu`.
- "Would FFI or C help?" → `references/ffi-and-native.md` first. FFI wins when one call replaces many JS calls or
  syscalls (a bulk directory read, a field pick over many lines). It does not win for one thin syscall, or for
  anything that must hand full JS objects back.
- "Is JSON parsing the cost?" → `references/json.md`.
- "How do I walk or read files cheaply?" → `references/filesystem.md`.

## Measured facts to start from (2026-10-12, this Mac)

- Bun process start plus imports dominate a small CLI call: about 86 ms of wall time for any tool, and 149 ms of
  CPU of imports for `ai usage sessions`.
- One `stat` costs about 2.5 µs of CPU. `statSync` of 3,840 files: 10 ms. `fs/promises` `stat` of the same: 38 ms.
- Synchronous small reads equal pure FFI: first 64 KB of 623 files, `readSync` 23 ms, FFI `pread` 23 ms. Async
  reads cost 2 to 5 times more (Bun's thread pool), a stream's first chunk 4 times more.
- `fastWalk` (bun:ffi `getattrlistbulk`): all 13,870 Claude transcripts with mtime and size in 148 to 169 ms,
  against 468 to 485 ms for `readdir` plus `lstat`.
- `JSON.parse` of 137 MB of transcript lines: 112 ms. comment-json (the old `SafeJSON.parse` default): 1,026 to
  1,261 ms. `SafeJSON.parse` now tries `JSON.parse` first.
- The usage daemon's own row build: 1,180 ms before the identity cache, 423 ms after.

Every number above has its method and commit in `references/` and in the ledger.

## References

- `references/profiling.md`: `tools ts profile`, `bun --cpu-prof`, `sample`, the repository profiler, and the
  traps in each (wall-sampled JS thread, await gaps, `bun test` ignoring `--cpu-prof`).
- `references/measuring.md`: the benchmark harness, fresh-process cold/warm samples, interleaving, blocks, the
  old-commit scratch worktree, controls, and how to report a result.
- `references/filesystem.md`: `fastWalk`, `readFirstLines` / `readLastLines`, sync vs async fs, stat costs, APFS
  and FSEvents facts, and what was rejected.
- `references/ffi-and-native.md`: `bun:ffi` rules (the `ptr()` trap), `defineSystemLibrary`, the shared
  `libSystem` binding, `defineNativeLibrary` (clang cache, TinyCC limits), and when native code pays.
- `references/json.md`: what `JSON.parse` costs, the `SafeJSON` change, `Bun.JSONL`, simdjson through FFI (full
  parse, field pick, tape plus key cache) and why `SafeJSON.parse(..., { ffi: true })` would lose.
- `references/caching-and-freshness.md`: the never-staler rule in practice, `FileIdentityCache`, persisted
  caches, serve-time clocks, the rows cache, the hub server, and the rejected skip-rebuild.
- `references/ledger.md`: where results go and the entry format.
