# Native code from Bun: system libraries and C, loaded once

Two loaders for code that runs outside JavaScript, through `bun:ffi`:

- `defineSystemLibrary` calls a library the OS already ships (`libSystem`, `libproc`) with no C of ours.
- `defineNativeLibrary` loads a C file of ours, compiled once.

Both return a getter. The first call loads; every later call returns the same symbols.

## Which one to use

1. **The OS has the call you need: use `defineSystemLibrary`.** Example: `src/utils/fs/fast-walk.ts` reads each
   directory with `getattrlistbulk` from `libSystem`. No compiler, no build step, no file to ship.
2. **You need a tight loop in C** (a struct walk the OS does not expose, a hot loop over millions of items, a C
   library without a callable ABI): **use `defineNativeLibrary`.** Measure first: the TypeScript loop over a system
   call was as fast as C for the directory walk below.
3. **Neither:** stay in TypeScript. A Node or Bun API that does the job is simpler than either loader.

## What we measured (2026-10-12, Apple Silicon, macOS 26, Bun 1.4.2)

The same walk (every `*.jsonl` under the Claude projects folder, 13,870 files, with mtime and size), 5 fresh
processes per arm, interleaved, load average 37 to 42. CPU milliseconds, cold (a new process) and warm (the same
process again):

- TypeScript over `getattrlistbulk` through `defineSystemLibrary` (`fastWalk`): 169 cold, 148 warm.
- The same walk in C, built by clang and opened from the cache (`defineNativeLibrary`): 147 cold, 153 warm.
- The same C compiled by Bun's TinyCC in the process (`defineNativeLibrary`, `compiler: "tcc"`): 190 cold, 151 warm.
  The cold pass includes the compile: about 14 ms of CPU and 20 ms of wall time for 200 lines, in every process.
- `readdir` with file types plus an `lstat` per file: 485 cold, 468 warm.

So the system call, not the language, sets the cost. The C version of the walk is kept as a benchmark fixture
(`scripts/benchmarks/fs/fastwalk.c`), not as a dependency.

An older binding of the same call (`src/utils/macos/getattrlistbulk.ts`) costs 798 ms against 238 ms for
`fastWalk` on the same 31,656 files. It reads 7 fields per entry as `BigInt`, decodes every name, builds an object
and yields through a generator. The work done per entry in JavaScript decides whether FFI pays off.

## Rules for the TypeScript side of a system call

- **Pass the typed array to every call. Never cache `ptr()` of it.** The engine may move a small typed array during
  garbage collection; a pointer taken once then reads freed memory. Measured: a walk that cached `ptr()` of its
  24-byte attribute list found 12,107 of 13,847 files, then 0 on every later walk.
- **Read 64-bit fields as two `Uint32Array` words** (`high * 2 ** 32 + low`), not with `DataView.getBigInt64`, which
  creates a `BigInt` per read.
- **Decode a string only for an entry you keep.** Compare names as bytes first.
- **Reuse one buffer per call site**, and yield to the event loop now and then in a long loop, so a resident server
  keeps answering (`fastWalk` yields every 256 directories).
- **Check constants against the SDK headers** (`xcrun --show-sdk-path`, then `usr/include/sys/attr.h` and friends) and
  write the date you checked next to them.
- **Keep a portable fallback.** `defineSystemLibrary` answers null off the listed platforms or when the library does
  not load; the caller then takes a JS path that returns the same result, and a test runs both.

## How `defineNativeLibrary` decides to compile

- The build's file name carries a SHA-256 of the source, every `dependsOn` file, the flags, the platform and the CPU.
  An edit to any of them names a new file, so exactly one rebuild follows an edit, and an unchanged source opens the
  build an earlier process made (0.4 ms of CPU). The first `dlopen` of a new build waits 130 to 380 ms for the
  macOS Gatekeeper scan, once per build.
- Builds live in `~/.genesis-tools/bun-compiler/libraries/` unless `cacheDir` says otherwise. A build goes to a
  temporary name and is renamed into place, so two processes that build at once never load a half-written file.
- Without `clang` or `cc` on `PATH`, it compiles with Bun's TinyCC (`cc` from `bun:ffi`) in memory. **TinyCC cannot
  be cached between processes:** `cc` has no output option (`source`, `library`, `include`, `symbols`, `define`,
  `flags`), and `-o` passed in `flags` writes no file. Bun's binding never declares `tcc_output_file` and sets the
  in-memory output type after the user flags, so `-shared`, `-c` and `-o` are read and then overruled (checked in
  Bun's source at v1.4.2 and on Bun 1.3.13, with 11 flag variants). Machine code copied out of one process crashes in
  another at its first relocated address. Every process pays the compile once. `cc` also fails inside a
  `bun build --compile` executable, where an embedded library opened with `dlopen` works. `compiler: "tcc"` forces
  this path, `compiler: "clang"` forbids it.
- A source edited while a process runs is loaded by the next process, not this one.

## Examples

A system library:

```ts
import { FFIType } from "bun:ffi";
import { defineSystemLibrary } from "@genesiscz/utils/bun/compiler";

const libSystem = defineSystemLibrary({
    path: "/usr/lib/libSystem.B.dylib",
    platforms: ["darwin"],
    symbols: { getpid: { args: [], returns: FFIType.i32 } },
});

const calls = libSystem();
const pid = calls ? calls.getpid() : process.pid;
```

A C file of ours:

```ts
import { join } from "node:path";
import { defineNativeLibrary } from "@genesiscz/utils/bun/compiler";

const adder = defineNativeLibrary({
    source: join(import.meta.dir, "add.c"),
    symbols: { add: { args: ["i32", "i32"], returns: "i32" } },
});

adder().symbols.add(2, 3); // 5; `adder().via` says "cache", "clang" or "tcc"
```

## How to measure

- **The walk arms above:** `bun scripts/benchmarks/fs/walk-primitives.ts --baseline`, change the code, then
  `--compare`. Arms: `native` (`fastWalk`), `clang`, `tcc`, `js`, `walkSourceRoots`. Write `uptime` next to any number;
  CPU time is the metric, wall time on a loaded Mac is noise.
- **Session discovery and the session list:** `bun scripts/benchmarks/agent-sessions/session-listing.ts --compare`.
- **Where the time goes in any entry point:** `bun --cpu-prof --cpu-prof-md --cpu-prof-dir=<scratch> run <entry>`
  writes a sampled profile with hot functions and a call tree. Its milliseconds are sampled wall time on the JS
  thread, so time blocked in a native call (a `stat`, a file read) counts. Confirm a finding with CPU time
  (`process.cpuUsage()`) before acting on it.
- The results and their causes go into the local performance ledger, `.claude/docs/performance.md`.
