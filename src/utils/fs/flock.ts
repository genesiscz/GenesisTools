import { FFIType } from "bun:ffi";
import { closeSync, existsSync, openSync } from "node:fs";
import { defineSystemLibrary } from "@genesiscz/utils/bun/compiler";
import { logger } from "@genesiscz/utils/logger";

const LOCK_SH = 1;
const LOCK_NB = 4;
const LOCK_UN = 8;

const libc = defineSystemLibrary({
    path: "/usr/lib/libSystem.B.dylib",
    platforms: ["darwin"],
    symbols: { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } },
});

/** `held`: a process holds an exclusive lock; `unknown`: this platform or this file cannot be asked. */
export type FlockState = "held" | "free" | "unknown";

/**
 * Whether a process holds an exclusive `flock` on `path`, as a GenesisKit `SingleInstance` face does for its whole
 * life (the kernel drops the lock when that process ends, crash included, so it is never stale). It takes a shared
 * lock without waiting and gives it back at once; that fails only while an exclusive lock is held. A missing file is
 * `free`: the holder creates it when it takes the lock. Any refusal of the call counts as `held`, since the reason
 * (errno) is not readable here, and a wrong `free` is the answer that does harm.
 */
export function flockState(path: string): FlockState {
    if (!existsSync(path)) {
        return "free";
    }

    const calls = libc();

    if (!calls) {
        return "unknown";
    }

    let fd: number;

    try {
        fd = openSync(path, "r");
    } catch (error) {
        logger.debug({ error, path }, "flock: the lock file did not open");
        return "unknown";
    }

    try {
        if (calls.flock(fd, LOCK_SH | LOCK_NB) !== 0) {
            return "held";
        }

        calls.flock(fd, LOCK_UN);
        return "free";
    } finally {
        closeSync(fd);
    }
}
