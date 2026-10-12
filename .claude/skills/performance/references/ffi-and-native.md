# bun:ffi and native code

Contents: 1. when native code pays · 2. `bun:ffi` rules · 3. `defineSystemLibrary` and the shared `libSystem`
binding · 4. `defineNativeLibrary` (clang, TinyCC) · 5. C++ libraries · 6. facts about TinyCC.

The full write-up with every measurement: `src/utils/bun/compiler/README.md`. Research:
`<notes vault>/Dev/Bun/2026-10-12-FastWalkWithoutOwnC/`.

## 1. When native code pays, and when it does not

An FFI call costs tens of ns plus argument conversion. Native code wins when ONE call replaces many JS-side calls
or syscalls, and the result comes back as numbers or bytes:

- `getattrlistbulk` (a whole directory's names, types, mtimes and sizes per call): 3 times less CPU than
  `readdir` + `lstat`.
- A simdjson field pick over 15,900 JSONL lines in one call, numbers out: 23 ms against 144 ms for decode +
  `JSON.parse` (`json.md`).

It does NOT win when:

- the operation is one thin syscall that `node:fs` already calls synchronously (`stat`, `pread`): measured equal;
- the result must become JS objects or strings: building them is the cost, and JSC builds them faster inside
  `JSON.parse` than JS can from a buffer (`json.md`);
- the input is a JS string: encoding it to UTF-8 bytes for C costs about as much as the parse you hoped to save.

Pure FFI into a system library (no C of ours) equals C for the walk: 148 warm against 153 for a clang build.
Write C only when no system call does the job.

## 2. `bun:ffi` rules (each one cost a debugging session)

- **Never keep a `ptr()` of a typed array.** A pointer taken once goes stale when the garbage collector moves the
  array: the first walk found 12,107 of 13,847 files, every later walk found 0. Pass the typed array or Buffer
  itself to every call; Bun takes its address at the call.
- **Read 64-bit fields as two `Uint32Array` words** (`high * 2**32 + low`), not `DataView.getBigInt64`: a BigInt
  per entry cost more than the syscall.
- **Decode a name only for an entry you keep.** Compare lengths and bytes first; `TextDecoder` per entry was the
  single biggest cost of the old binding.
- **Reuse one buffer per call site** (allocate once, grow when needed). A fresh zero-filled 256 KB buffer per
  directory cost 240 MB of allocation over 941 folders.
- **Yield to the event loop** in long loops (every 256 directories) so a server keeps answering.
- **`i64` returns may be BigInt**: wrap in `Number()` when the value is a size or offset.
- **errno**: read `__error()` (a pointer to the thread's errno) right after the failing call; `errnoError` in
  `src/utils/fs/native/libsystem.ts` turns it into a `node:fs`-shaped error (`code`, `errno`, `syscall`, `path`).
- **Paths are C strings**: `cPath(path)` = UTF-8 bytes plus a NUL.
- Constants come from the SDK headers, checked with a small C program, never from memory: `O_DIRECTORY 0x100000`,
  `O_NONBLOCK 0x4`, `O_CLOEXEC 0x1000000`, `SEEK_END 2`, `ATTR_BIT_MAP_COUNT 5`, `ATTR_CMN_RETURNED_ATTRS
  0x80000000`, `ATTR_CMN_NAME 0x1`, `ATTR_CMN_OBJTYPE 0x8`, `ATTR_CMN_MODTIME 0x400`, `ATTR_FILE_DATALENGTH 0x200`,
  `FSOPT_NOFOLLOW 0x1`, `FSOPT_PACK_INVAL_ATTRS 0x8`, `VREG 1`, `VDIR 2`, `VLNK 5`.

## 3. `defineSystemLibrary` and the shared binding

```ts
import { defineSystemLibrary } from "@genesiscz/utils/bun/compiler";

const calls = defineSystemLibrary({
    path: "/usr/lib/libSystem.B.dylib",
    platforms: ["darwin"],
    symbols: { open: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 } },
});
const symbols = calls(); // lazy, memoized; null off the listed platforms or when dlopen fails
```

Do not bind `libSystem` again: `src/utils/fs/native/libsystem.ts` exports one binding (`open`, `close`, `pread`,
`lseek`, `getattrlistbulk`, `__error`) plus `errnoNow`, `errnoError`, `cPath` and the flag constants. Add a symbol
there. Every native fs utility needs a JS fallback for when `calls()` is null.

## 3b. Process data from the kernel instead of `ps`, `lsof` and `top` (2026-10-13)

Measured CPU per call, spawn against kernel read (`scripts/benchmarks/process/process-primitives.ts`, medians of
5 to 7 fresh processes): cwd of 30 processes 226 → 1 ms (`proc_pidinfo` vnode path); the dev-dashboard pulse 1,718 →
16 ms (`host_statistics`, `host_statistics64`, `sysctlbyname`, `statfs`); `tools claude who` 573 → 39 ms and the
`say` caller chain 154 → 9 ms (`proc_listallpids`, `proc_pidinfo`, `KERN_PROCARGS2`;
`src/utils/process/libproc-table.ts`); listening TCP ports 271 → 9 ms (`proc_pidfdinfo` socket info).

- **libproc reads only your own processes** (1,142 of 1,487 here). `ps` sees the rest because it is setuid root;
  `lsof` is not, so it answers for exactly the same pids as libproc and is no fallback for them. Callers that rank the
  whole machine (top memory, other users) stay on `ps`.
- **The kernel CPU tick counters can stand still for up to 990 ms.** A CPU % from two reads 250 ms apart was null in
  18 of 40 tries; 1 s apart with one retry, 0 of 40. CPU % is "average since the last read", not `top`'s sample.
- **`ps -o command=` with another column after it cuts the command to 16 characters.** That is why
  `getPortOwner` never recognised the ai-proxy server; read the command line from `KERN_PROCARGS2` or put
  `command` last.
- Match `ps` byte for byte where callers parse the text (escaped tabs, newlines and control characters in argv):
  checked 1,113 of 1,113 own processes.
- Check the struct layout at start-up against your own row and fall back to the spawn if it looks wrong; a layout
  change in a future macOS then costs speed, not correctness.

## 4. `defineNativeLibrary`: our own C, compiled once

```ts
const lib = defineNativeLibrary({ source, symbols, compiler: "auto" | "clang" | "tcc", flags, dependsOn, cacheDir });
const { symbols, via, path } = lib(); // via: "cache" | "clang" | "tcc"
```

- The library is named by a SHA-256 of platform, arch, flags, the source and `dependsOn`, under
  `~/.genesis-tools/bun-compiler/libraries/`. An unchanged source opens the cached build (0.39 ms); any change
  compiles a new file (temporary file, then rename). Nothing is ever recompiled on a timer.
- `auto` uses clang (or `cc`) when present, else Bun's TinyCC in memory.
- The first `dlopen` of a NEW dylib waits 130 to 380 ms for the macOS Gatekeeper scan; later opens are fast. Put
  that in any cold measurement of a fresh build.
- Flags come before the source file in the compiler command, so `-x c++` works (section 5).

## 5. C++ libraries (simdjson)

`scripts/benchmarks/json/parse-child.ts` builds `simdjson-shim.cpp` with
`flags: ["-x", "c++", "-std=c++17", "-O3", "-I/opt/homebrew/include", "-L/opt/homebrew/lib", "-lsimdjson", "-lc++"]`
and `compiler: "clang"`. The shim exposes `extern "C"` functions that take the whole batch (a byte buffer, start
and end offsets, a count, an output `Float64Array`) so there is one FFI call per batch, not per line. simdjson needs
64 bytes of readable padding after the input; pad the buffer.

A shipped dependency on Homebrew simdjson is not acceptable (it is not on other machines); vendoring its
amalgamation is a decision for the user.

## 6. TinyCC facts (Bun's `cc`)

- `cc({ source, library, include, symbols, define, flags })` compiles in memory only. There is no output path:
  Bun's `tcc.rs` never declares `tcc_output_file` and sets the in-memory output type after the user flags, so
  `-o`, `-shared` and `-c` are overruled (97% confidence, proven from Bun's source and 11 flag variants on Bun
  1.4.2 and 1.3.13).
- A compile costs about 14 ms of CPU (20 ms wall) per process, every process.
- `cc` fails inside a `bun build --compile` executable; a dylib opened with `dlopen` works there.
- `bun:ffi` and `cc` are marked experimental.
