import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "@app/logger";
import { isProcessAlive } from "@app/utils/process-alive";

const DEFAULT_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 50;
const ORPHANED_PID_RECHECK_MS = 100;

export class LockTimeoutError extends Error {
    constructor(lockPath: string, timeout: number) {
        super(`Failed to acquire file lock at ${lockPath} within ${timeout}ms. Another process may be holding it.`);
        this.name = "LockTimeoutError";
    }
}

function isEexist(err: unknown): boolean {
    return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST";
}

function isEnoent(err: unknown): boolean {
    return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Atomically steal a stale/orphaned lock file.
 *
 * Renames the lock to a unique temp path first — `rename` is atomic on POSIX,
 * so under N concurrent stealers exactly one rename succeeds; every loser gets
 * ENOENT (the source is already gone under them) and returns false. Only the
 * rename winner proceeds to claim the path with its own `wx` write.
 */
async function attemptRenameSteal(lockPath: string): Promise<boolean> {
    const tempPath = `${lockPath}.stale-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

    try {
        await rename(lockPath, tempPath);
    } catch (err) {
        if (isEnoent(err)) {
            return false;
        }

        throw err;
    }

    try {
        await writeFile(lockPath, String(process.pid), { flag: "wx" });
    } catch (err) {
        if (isEexist(err)) {
            return false;
        }

        throw err;
    } finally {
        try {
            await unlink(tempPath);
        } catch {
            // best-effort cleanup; ENOENT if somehow already gone
        }
    }

    return true;
}

/**
 * Try to acquire a lock file atomically.
 * Uses O_CREAT|O_EXCL semantics (writeFile flag:'wx') so two processes
 * cannot both "acquire" the lock simultaneously.
 *
 * Exported for direct concurrency testing (see file-lock.test.ts) —
 * exercising `withFileLock`'s polling loop end-to-end would obscure the
 * single-winner guarantee this function itself must provide.
 */
export async function tryAcquireLock(lockPath: string): Promise<boolean> {
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

        if (Number.isNaN(lockPid)) {
            // Lock file has no valid PID content. writeFile with `flag:"wx"` is
            // O_CREAT|O_EXCL followed by a separate write() syscall, so a
            // legitimate owner is empty for microseconds; but a SIGKILL between
            // those two syscalls leaves a permanently empty (0-byte) lock that
            // would otherwise block every future acquirer until timeout.
            // Disambiguate by re-reading after a short grace: if the owner is
            // real, the PID appears; if the file stays empty, the lock is
            // orphaned and safe to steal.
            await sleep(ORPHANED_PID_RECHECK_MS);

            let recheckPid = Number.NaN;

            try {
                const recheckContent = await Bun.file(lockPath).text();
                recheckPid = parseInt(recheckContent.trim(), 10);
            } catch {
                return false;
            }

            if (!Number.isNaN(recheckPid)) {
                // Owner finished its write during the grace — fall through to
                // the normal alive/dead check below.
                lockPid = recheckPid;
            } else {
                // Still empty after grace — orphaned. Steal.
                logger.debug(`Stealing orphaned lock at ${lockPath} (no PID content)`);
                return await attemptRenameSteal(lockPath);
            }
        }

        if (isProcessAlive(lockPid)) {
            return false;
        }

        // Stale lock (process is dead) — steal it
        logger.debug(`Stealing stale lock at ${lockPath} (PID ${lockPid} is dead)`);
        return await attemptRenameSteal(lockPath);
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
