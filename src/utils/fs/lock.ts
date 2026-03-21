import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import lockfile from "proper-lockfile";

export interface LockOptions {
    /** Lock considered stale after this many ms. Default: 120_000 (2 min) */
    staleMs?: number;
    /** How often to refresh the lock. Default: 30_000 (30s). Must be < staleMs/2. */
    updateMs?: number;
    /** Number of retry attempts if lock is held. Default: 0 (fail immediately) */
    retries?: number;
    /** Delay between retries in ms. Default: 1000 */
    retryDelay?: number;
    /** Called if lock is compromised (another process reclaimed it) */
    onCompromised?: (err: Error) => void;
}

export interface LockHandle {
    /** Release the lock */
    release(): Promise<void>;
}

/**
 * Acquire a cross-process file lock.
 *
 * @param lockPath - Path to the file to lock. File is created if it doesn't exist.
 * @param opts - Lock configuration
 * @returns LockHandle with release() method
 * @throws Error with code "ELOCKED" if lock is held and retries exhausted
 */
export async function acquireLock(lockPath: string, opts?: LockOptions): Promise<LockHandle> {
    const staleMs = opts?.staleMs ?? 120_000;
    const updateMs = opts?.updateMs ?? 30_000;
    const retries = opts?.retries ?? 0;
    const retryDelay = opts?.retryDelay ?? 1000;

    // Ensure parent directory exists
    const dir = dirname(lockPath);

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    // Ensure the lock file exists (proper-lockfile requires it)
    if (!existsSync(lockPath)) {
        writeFileSync(lockPath, String(process.pid), "utf-8");
    }

    const release = await lockfile.lock(lockPath, {
        stale: staleMs,
        update: updateMs,
        retries: retries > 0 ? { retries, minTimeout: retryDelay, maxTimeout: retryDelay } : 0,
        realpath: false,
        onCompromised: opts?.onCompromised ?? (() => {}),
    });

    // Write PID for cross-process identification
    writeFileSync(lockPath, String(process.pid), "utf-8");

    let released = false;

    return {
        async release() {
            if (released) {
                return;
            }

            released = true;

            try {
                await release();
            } catch {
                // Lock may already be released (e.g., compromised)
            }
        },
    };
}

/**
 * Check if a file is currently locked (by any process).
 */
export async function isLocked(lockPath: string, opts?: Pick<LockOptions, "staleMs">): Promise<boolean> {
    if (!existsSync(lockPath)) {
        return false;
    }

    try {
        return await lockfile.check(lockPath, {
            stale: opts?.staleMs ?? 120_000,
            realpath: false,
        });
    } catch {
        return false;
    }
}

/**
 * Read the PID of the process holding the lock, if still alive.
 * Returns null if lock is not held or holder process is dead.
 */
export async function getLockHolderPid(lockPath: string): Promise<number | null> {
    if (!existsSync(lockPath)) {
        return null;
    }

    try {
        const locked = await lockfile.check(lockPath, {
            stale: 120_000,
            realpath: false,
        });

        if (!locked) {
            return null;
        }
    } catch {
        return null;
    }

    try {
        const content = readFileSync(lockPath, "utf-8").trim();
        const pid = parseInt(content, 10);

        if (Number.isNaN(pid) || pid <= 0) {
            return null;
        }

        // Check if process is alive (signal 0 = existence check)
        process.kill(pid, 0);
        return pid;
    } catch {
        return null;
    }
}
