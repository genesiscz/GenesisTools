import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const requireModule = createRequire(import.meta.url);
let loadedLockfile: typeof import("proper-lockfile") | null = null;

/**
 * proper-lockfile hooks signal-exit's SIGINT/SIGTERM handlers the moment it loads. Storage imports
 * this file, so a top-level import put those handlers into every process (and every test); it is
 * loaded on the first arbitration instead.
 */
function lockfile(): typeof import("proper-lockfile") {
    loadedLockfile ??= requireModule("proper-lockfile") as typeof import("proper-lockfile");

    return loadedLockfile;
}

const STALE_MS = 30_000;
const UPDATE_MS = 10_000;

export type ArbitrationResult<T> = { acquired: true; value: T } | { acquired: false };

function arbitrationPath(targetPath: string): string {
    return `${targetPath}.claim-arbitration`;
}

function isLocked(error: unknown): boolean {
    return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ELOCKED";
}

/**
 * Serialize the short claim/stale-takeover decision for a path.
 *
 * The arbiter is separate from the long-lived PID ownership record. It uses the
 * repository's existing proper-lockfile dependency, gets a heartbeat while held,
 * and never renames the protected path. Callers retry on a busy result.
 */
export async function tryWithPathArbitration<T>(
    targetPath: string,
    fn: () => Promise<T>
): Promise<ArbitrationResult<T>> {
    mkdirSync(dirname(targetPath), { recursive: true });
    let release: (() => Promise<void>) | undefined;
    try {
        release = await lockfile().lock(arbitrationPath(targetPath), {
            realpath: false,
            stale: STALE_MS,
            update: UPDATE_MS,
            retries: 0,
        });
    } catch (error) {
        if (isLocked(error)) {
            return { acquired: false };
        }

        throw error;
    }

    try {
        return { acquired: true, value: await fn() };
    } finally {
        await release();
    }
}

/** Synchronous twin for legacy pidfile writers; a busy arbiter fails fast. */
export function withPathArbitrationSync<T>(targetPath: string, fn: () => T): T {
    mkdirSync(dirname(targetPath), { recursive: true });
    const release = lockfile().lockSync(arbitrationPath(targetPath), {
        realpath: false,
        stale: STALE_MS,
        update: UPDATE_MS,
        retries: 0,
    });

    try {
        return fn();
    } finally {
        release();
    }
}
