// C-engine runner: compiles native/clonesize.c on demand (cached, rebuilt only
// when the source is newer). Two ways to invoke the same native core:
//   • scanWithCFfi — DEFAULT. dlopen the compiled dylib and call it via bun:ffi
//     (no subprocess). The parallel pthread/getattrlistbulk core runs in native
//     code; bun just passes args and reads back the JSON string.
//   • scanWithC   — reference/fallback. runs the compiled binary as a subprocess.
//
// This is the fast path used by `tools du clonesize` — the whole point of the
// tool is speed on huge clonefile trees, and the parallel C core is what delivers
// it (~4.7s on GenesisTools' 388k files, ~56% faster than the pre-skip engine).

import { CString, dlopen, FFIType, ptr, suffix } from "bun:ffi";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { ClonesizeResult, PartnersResult, ScanOptions, VolumeInfo } from "./types";

const prof = profiler.scope("du.engine");

const NATIVE_DIR = join(import.meta.dir, "..", "native");
const SRC = join(NATIVE_DIR, "clonesize.c");
const BIN = join(NATIVE_DIR, "clonesize");
const DYLIB = join(NATIVE_DIR, `libclonesize.${suffix}`);
const SHIM_SRC = join(NATIVE_DIR, "l2p_shim.c");
const SHIM = join(NATIVE_DIR, "libl2pshim.dylib");

/**
 * Ensure the non-variadic fcntl shim dylib exists (needed by the Bun engine's
 * FFI path — see scan-worker.ts). Compiled on demand and cached.
 */
export function ensureShim(): string {
    const needBuild =
        !existsSync(SHIM) || (existsSync(SHIM_SRC) && statSync(SHIM_SRC).mtimeMs > statSync(SHIM).mtimeMs);
    if (needBuild) {
        logger.debug({ src: SHIM_SRC, out: SHIM }, "du: compiling l2p_shim.c");
        execFileSync("clang", ["-O2", "-dynamiclib", "-o", SHIM, SHIM_SRC], { stdio: "pipe" });
    }
    return SHIM;
}

/**
 * Ensure the C binary exists and is newer than its source. Compiles with clang
 * (cc is aliased to `claude` on this machine — never use cc). Returns the binary
 * path. Throws with an actionable message if clang is unavailable.
 */
export function ensureBinary(): string {
    const needBuild = !existsSync(BIN) || (existsSync(SRC) && statSync(SRC).mtimeMs > statSync(BIN).mtimeMs);

    if (needBuild) {
        logger.debug({ src: SRC, bin: BIN }, "du: compiling clonesize.c");
        try {
            execFileSync("clang", ["-O2", "-pthread", "-o", BIN, SRC], { stdio: "pipe" });
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(
                `Failed to compile the clonesize C engine with clang.\n` +
                    `  source: ${SRC}\n` +
                    `  Ensure the Xcode command-line tools are installed (xcode-select --install).\n` +
                    `  Underlying error: ${detail}`
            );
        }
    }

    return BIN;
}

/**
 * Ensure the C engine compiled as a shared library (for the bun:ffi path).
 * Compiled on demand and cached, rebuilt when the source is newer.
 */
export function ensureDylib(): string {
    const needBuild = !existsSync(DYLIB) || (existsSync(SRC) && statSync(SRC).mtimeMs > statSync(DYLIB).mtimeMs);

    if (needBuild) {
        logger.debug({ src: SRC, dylib: DYLIB }, "du: compiling clonesize.c as dylib");
        try {
            execFileSync("clang", ["-O2", "-pthread", "-dynamiclib", "-o", DYLIB, SRC], { stdio: "pipe" });
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(
                `Failed to compile the clonesize C engine as a dylib with clang.\n` +
                    `  source: ${SRC}\n` +
                    `  Ensure the Xcode command-line tools are installed (xcode-select --install).\n` +
                    `  Underlying error: ${detail}`
            );
        }
    }

    return DYLIB;
}

type ClonesizeLib = ReturnType<typeof openLib>;
let libCache: ClonesizeLib | null = null;

function openLib() {
    const path = ensureDylib();
    return dlopen(path, {
        // char* clonesize_run_json(const char* path, int threads, int freeable,
        //                          unsigned long long min_bytes,
        //                          const char* const* excludes, int nexcludes,
        //                          int depth, int freeable_tree,
        //                          unsigned long long changed_since,
        //                          const char* cache_dir, int cache_read, int include_cloud)
        //
        // Sentinels the C side expects, none of which are valid values:
        //   threads       0  => auto (ncpu)
        //   min_bytes     0  => keep every file
        //   depth        -1  => no per-directory tree
        //   changed_since 0  => mtime filter OFF (g_mtime_min in clonesize.c). NOT
        //                       "epoch zero": a real cutoff is always > 0, and the
        //                       CLI rejects a zero-length window before reaching here.
        //   cache_dir  NULL  => extent cache disabled entirely
        clonesize_run_json: {
            args: [
                FFIType.ptr,
                FFIType.i32,
                FFIType.i32,
                FFIType.u64,
                FFIType.ptr,
                FFIType.i32,
                FFIType.i32,
                FFIType.i32,
                FFIType.u64,
                FFIType.ptr,
                FFIType.i32,
                FFIType.i32,
            ],
            returns: FFIType.ptr,
        },
        // char* clonesize_volume_json(const char* mount)
        clonesize_volume_json: { args: [FFIType.ptr], returns: FFIType.ptr },
        // char* clonesize_partners_json(const char* target, const char* root, int threads, int topn)
        clonesize_partners_json: {
            args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.i32],
            returns: FFIType.ptr,
        },
        clonesize_free: { args: [FFIType.ptr], returns: FFIType.void },
    });
}

function getLib(): ClonesizeLib {
    if (!libCache) {
        libCache = openLib();
    }
    return libCache;
}

/**
 * Run the C engine via bun:ffi (dlopen'd dylib) — no subprocess. This is the
 * preferred native path: the parallel pthread/getattrlistbulk core runs in
 * optimized native code, invoked directly through FFI instead of a fork+exec+JSON
 * pipe. Falls back cleanly to the subprocess path (scanWithC) on any FFI error.
 */
export function scanWithCFfi(opts: ScanOptions): ClonesizeResult {
    const { symbols } = getLib();

    // Build a char*[] for --exclude (kept referenced until after the call so the
    // GC can't move/free the underlying buffers mid-FFI).
    const exStrings = opts.exclude ?? [];
    const exBufs = exStrings.map((e) => Buffer.from(`${e}\0`, "utf8"));
    const exPtrs = new BigUint64Array(exBufs.length);
    for (let i = 0; i < exBufs.length; i++) {
        exPtrs[i] = BigInt(ptr(exBufs[i]!));
    }

    const pathBuf = Buffer.from(`${opts.path}\0`, "utf8");
    const cacheBuf = opts.cacheDir ? Buffer.from(`${opts.cacheDir}\0`, "utf8") : null;

    const end = prof.start("c-ffi.run");
    const resPtr = symbols.clonesize_run_json(
        ptr(pathBuf),
        opts.threads && opts.threads > 0 ? opts.threads : 0,
        opts.freeable ? 1 : 0,
        BigInt(opts.minBytes && opts.minBytes > 0 ? opts.minBytes : 0),
        exBufs.length > 0 ? ptr(exPtrs) : null,
        exBufs.length,
        opts.depth !== undefined && opts.depth >= 0 ? opts.depth : -1,
        opts.freeableTree ? 1 : 0,
        BigInt(opts.changedSince && opts.changedSince > 0 ? opts.changedSince : 0),
        cacheBuf ? ptr(cacheBuf) : null,
        opts.noCache ? 0 : 1,
        opts.includeCloud ? 1 : 0
    );
    end();

    if (!resPtr) {
        throw new Error("clonesize dylib returned NULL (scan failed)");
    }

    const json = new CString(resPtr).toString();
    symbols.clonesize_free(resPtr);
    // keep the arg buffers alive until here
    void exBufs;
    void cacheBuf;
    return SafeJSON.parse(json) as ClonesizeResult;
}

/** Read the volume's authoritative used/free bytes (ATTR_VOL_*) for a mount point. */
export function readVolumeInfo(mount: string): VolumeInfo {
    const { symbols } = getLib();
    const buf = Buffer.from(`${mount}\0`, "utf8");
    const resPtr = symbols.clonesize_volume_json(ptr(buf));
    if (!resPtr) {
        throw new Error(`Could not read volume attributes for ${mount} (is it a mount point?)`);
    }

    const json = new CString(resPtr).toString();
    symbols.clonesize_free(resPtr);
    return SafeJSON.parse(json) as VolumeInfo;
}

/**
 * Two-phase clone-partner query: scan `target` for the blocks it shares, then
 * scan `root` for every other file holding those same blocks.
 */
export function scanPartners(opts: { target: string; root: string; threads?: number; top?: number }): PartnersResult {
    const { symbols } = getLib();
    const targetBuf = Buffer.from(`${opts.target}\0`, "utf8");
    const rootBuf = Buffer.from(`${opts.root}\0`, "utf8");

    const end = prof.start("c-ffi.partners");
    const resPtr = symbols.clonesize_partners_json(
        ptr(targetBuf),
        ptr(rootBuf),
        opts.threads && opts.threads > 0 ? opts.threads : 0,
        opts.top && opts.top > 0 ? opts.top : 30
    );
    end();

    if (!resPtr) {
        throw new Error("clonesize dylib returned NULL (partner scan failed)");
    }

    const json = new CString(resPtr).toString();
    symbols.clonesize_free(resPtr);
    return SafeJSON.parse(json) as PartnersResult;
}

/** Run the C engine as a subprocess and return the parsed result. */
export function scanWithC(opts: ScanOptions): ClonesizeResult {
    const bin = ensureBinary();
    const args = ["--format", "json"];
    if (opts.threads && opts.threads > 0) {
        args.push("--threads", String(opts.threads));
    }
    if (opts.freeable) {
        args.push("--freeable");
    }
    if (opts.minBytes && opts.minBytes > 0) {
        args.push("--min-bytes", String(opts.minBytes));
    }
    if (opts.depth !== undefined && opts.depth >= 0) {
        args.push("--depth", String(opts.depth));
    }
    if (opts.freeableTree) {
        args.push("--freeable-tree");
    }
    if (opts.changedSince && opts.changedSince > 0) {
        args.push("--changed-since", String(opts.changedSince));
    }
    if (opts.cacheDir) {
        args.push("--cache-dir", opts.cacheDir);
    }
    if (opts.noCache) {
        args.push("--no-cache");
    }
    if (opts.includeCloud) {
        args.push("--include-cloud");
    }
    for (const ex of opts.exclude ?? []) {
        args.push("--exclude", ex);
    }
    args.push(opts.path);

    logger.debug({ bin, args }, "du: running C engine");
    // node_modules trees can emit a lot of JSON; give a generous buffer.
    const end = prof.start("c-subprocess.run");
    const stdout = execFileSync(bin, args, { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
    end();
    return SafeJSON.parse(stdout) as ClonesizeResult;
}
