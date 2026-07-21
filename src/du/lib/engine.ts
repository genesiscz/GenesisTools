// C-engine runner: compiles native/clonesize.c on demand (cached, rebuilt only
// when the source is newer than the binary) and runs it, parsing its JSON.
//
// This is the fast path used by `tools du clonesize`. The whole point of the
// tool is speed on huge clonefile trees (~9s on GenesisTools' 388k files vs
// ~25s single-threaded), and the parallel C binary is what delivers it.

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { ClonesizeResult, ScanOptions } from "./types";

const NATIVE_DIR = join(import.meta.dir, "..", "native");
const SRC = join(NATIVE_DIR, "clonesize.c");
const BIN = join(NATIVE_DIR, "clonesize");
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

/** Run the C engine and return the parsed result. */
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
    for (const ex of opts.exclude ?? []) {
        args.push("--exclude", ex);
    }
    args.push(opts.path);

    logger.debug({ bin, args }, "du: running C engine");
    // node_modules trees can emit a lot of JSON; give a generous buffer.
    const stdout = execFileSync(bin, args, { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
    return SafeJSON.parse(stdout) as ClonesizeResult;
}
