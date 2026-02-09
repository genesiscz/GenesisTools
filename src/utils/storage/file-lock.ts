import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import logger from "@app/logger";

const DEFAULT_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 50;

/**
 * Check if a process with the given PID is still alive.
 */
function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Try to acquire a lock file. Returns true if acquired, false if already held by a live process.
 */
async function tryAcquireLock(lockPath: string): Promise<boolean> {
    try {
        if (existsSync(lockPath)) {
            const content = await Bun.file(lockPath).text();
            const lockPid = parseInt(content.trim(), 10);

            if (!isNaN(lockPid) && isProcessAlive(lockPid)) {
                return false;
            }

            // Stale lock (process is dead) - steal it
            logger.debug(`Stealing stale lock at ${lockPath} (PID ${lockPid} is dead)`);
        }

        // Ensure parent directory exists
        const dir = dirname(lockPath);

        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        await Bun.write(lockPath, String(process.pid));
        return true;
    } catch (error) {
        logger.error(`Failed to acquire lock at ${lockPath}: ${error}`);
        return false;
    }
}

/**
 * Release a lock file by deleting it.
 */
function releaseLock(lockPath: string): void {
    try {
        if (existsSync(lockPath)) {
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
 * Creates a `.lock` file at lockPath with the current PID.
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
            throw new Error(
                `Failed to acquire file lock at ${lockPath} within ${timeout}ms. Another process may be holding it.`
            );
        }

        await sleep(POLL_INTERVAL_MS);
    }

    try {
        return await fn();
    } finally {
        releaseLock(lockPath);
    }
}
