import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import logger from "@app/logger";

const DEFAULT_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 50;

export class LockTimeoutError extends Error {
    constructor(lockPath: string, timeout: number) {
        super(`Failed to acquire file lock at ${lockPath} within ${timeout}ms. Another process may be holding it.`);
        this.name = "LockTimeoutError";
    }
}

/**
 * Check if a process with the given PID is still alive.
 */
function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // On Windows, EPERM means the process exists but we can't signal it
        if (process.platform === "win32" && err instanceof Error && "code" in err) {
            return (err as NodeJS.ErrnoException).code === "EPERM";
        }

        return false;
    }
}

function isEexist(err: unknown): boolean {
    return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST";
}

/**
 * Try to acquire a lock file atomically.
 * Uses O_CREAT|O_EXCL semantics (writeFile flag:'wx') so two processes
 * cannot both "acquire" the lock simultaneously.
 */
async function tryAcquireLock(lockPath: string): Promise<boolean> {
    const dir = dirname(lockPath);

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    // Atomic exclusive create — fails with EEXIST if another process holds it
    try {
        await writeFile(lockPath, String(process.pid), { flag: "wx" });
        return true;
    } catch (err) {
        if (!isEexist(err)) {
            // Real I/O error (EACCES, ENOSPC, etc.) — fail fast rather than timing out
            throw err;
        }

        // Lock file exists — check if the owning process is still alive
        let lockPid: number;

        try {
            const content = await Bun.file(lockPath).text();
            lockPid = parseInt(content.trim(), 10);
        } catch {
            // Can't read the lock file — assume it's held
            return false;
        }

        if (Number.isNaN(lockPid) || isProcessAlive(lockPid)) {
            return false;
        }

        // Stale lock (process is dead) — steal it
        logger.debug(`Stealing stale lock at ${lockPath} (PID ${lockPid} is dead)`);

        try {
            // Re-read before unlinking to confirm ownership hasn't changed
            const confirmContent = await Bun.file(lockPath).text();

            if (confirmContent.trim() !== String(lockPid)) {
                // Another process already rewrote the lock — don't steal it
                return false;
            }

            await unlink(lockPath);
            await writeFile(lockPath, String(process.pid), { flag: "wx" });
            return true;
        } catch {
            // Another process stole it between our read and write
            return false;
        }
    }
}

/**
 * Release a lock file by deleting it.
 */
function releaseLock(lockPath: string): void {
    try {
        if (!existsSync(lockPath)) {
            return;
        }

        // Only delete if we still own it (our PID is in the file)
        const content = readFileSync(lockPath, "utf-8").trim();

        if (content === String(process.pid)) {
            unlinkSync(lockPath);
        }
    } catch (error) {
        logger.error(`Failed to release lock at ${lockPath}: ${error}`);
    }
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function while holding a file lock.
 *
 * Uses atomic O_CREAT|O_EXCL to guarantee mutual exclusion between processes.
 * If another live process holds the lock, waits up to `timeout` ms.
 * If the lock is stale (owning process is dead), steals it.
 *
 * @param lockPath - Absolute path for the lock file
 * @param fn - Async function to execute while holding the lock
 * @param timeout - Maximum time in ms to wait for lock acquisition (default: 5000)
 * @returns The result of fn()
 */
export async function withFileLock<T>(
    lockPath: string,
    fn: () => Promise<T>,
    timeout: number = DEFAULT_TIMEOUT_MS
): Promise<T> {
    const startTime = Date.now();

    while (!(await tryAcquireLock(lockPath))) {
        const elapsed = Date.now() - startTime;

        if (elapsed >= timeout) {
            throw new LockTimeoutError(lockPath, timeout);
        }

        await sleep(POLL_INTERVAL_MS);
    }

    try {
        return await fn();
    } finally {
        releaseLock(lockPath);
    }
}
