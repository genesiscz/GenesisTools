import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type ArbitrationResult, tryWithPathArbitration } from "@genesiscz/utils/process/path-arbitration";
import {
    buildPidRecord,
    classifyPidRecord,
    type PidRecord,
    parsePidRecord,
    serializePidRecord,
    takeOverStaleClaimAsync,
} from "@genesiscz/utils/process/pidfile";
import { isProcessAliveSince } from "@genesiscz/utils/process-identity";

const DEFAULT_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 50;

/**
 * Wait budget for a lock whose HOLDER runs a network call inside it, rather than
 * a plain config edit.
 *
 * `DEFAULT_TIMEOUT_MS` was sized for the edit case, so a token refresh holding the
 * config lock across its HTTP round trip timed every other caller out (observed
 * 2026-09-06: nine accounts, one DNS outage, `LockTimeoutError` on every account
 * but the first). Every refresh path that takes the config lock passes this, and
 * bounds its own request with a deadline that fits inside it — an unbounded
 * request would make any wait budget meaningless.
 */
export const NETWORKED_LOCK_WAIT_MS = 60_000;

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

/** The `wx` create of this process's record; false when the lock file exists. */
async function createLock(lockPath: string): Promise<boolean> {
    const dir = dirname(lockPath);

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    try {
        await writeFile(lockPath, serializePidRecord(buildPidRecord()), { flag: "wx" });
        return true;
    } catch (err) {
        if (!isEexist(err)) {
            // Real I/O error (EACCES, ENOSPC, etc.) — fail fast rather than timing out
            throw err;
        }

        return false;
    }
}

/**
 * Identity, not just liveness: a holder that died and had its number reissued would otherwise look alive forever,
 * and every acquirer would time out against a lock nobody holds. Same verdict as inspectPidFile (command + startedAt),
 * including when the recycled pid is ours.
 */
function holderIsGone(lockPath: string, holder: PidRecord): boolean {
    const identity = classifyPidRecord(holder);

    if (identity.status === "live" || identity.status === "unverified") {
        return false;
    }

    logger.debug({ lockPath, pid: holder.pid, status: identity.status }, "taking over a stale lock");
    return true;
}

/**
 * Try to acquire a lock file atomically: an O_CREAT|O_EXCL create (writeFile flag:'wx'), and when the file exists,
 * the shared fenced takeover (`takeOverStaleClaimAsync` in pidfile.ts, which also owns the rule for an empty lock)
 * followed by the create again, so exactly one racer wins.
 *
 * Exported for direct concurrency testing (see claim-takeover.test.ts).
 */
export async function tryAcquireLock(lockPath: string): Promise<boolean> {
    if (await createLock(lockPath)) {
        return true;
    }

    const outcome = await takeOverStaleClaimAsync(lockPath, {
        arbiter: lockPath,
        holderIsStale: (holder) => holderIsGone(lockPath, holder),
    });

    // After a lost race the holder may be gone (a sweeper reaped it), so the create is tried again; it stays atomic.
    return outcome === "held" ? false : await createLock(lockPath);
}

/**
 * Delete the lock when it still names this process. Best-effort: it runs in
 * `withFileLock`'s `finally`, so a throw here would replace fn's own outcome.
 */
function unlinkIfOwned(lockPath: string): void {
    try {
        if (!existsSync(lockPath)) {
            return;
        }

        if (parsePidRecord(readFileSync(lockPath, "utf-8"))?.pid === process.pid) {
            unlinkSync(lockPath);
        }
    } catch (error) {
        if (!isEnoent(error)) {
            logger.error({ err: error, lockPath }, "Failed to release lock");
        }
    }
}

/**
 * Release a lock file by deleting it.
 *
 * Arbitration keeps the unlink from racing a stale takeover. When the arbiter
 * stays busy past the deadline, the ownership-checked unlink still runs: no
 * stealer takes a lock whose holder is this live process, and leaving it would
 * block every other acquirer until this process exits.
 */
export async function releaseLock(lockPath: string): Promise<void> {
    const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
    while (Date.now() <= deadline) {
        let arbitration: ArbitrationResult<void>;
        try {
            arbitration = await tryWithPathArbitration(lockPath, async () => unlinkIfOwned(lockPath));
        } catch (error) {
            logger.warn({ err: error, lockPath }, "Lock release arbitration failed; unlinking without it");
            break;
        }

        if (arbitration.acquired) {
            return;
        }

        await sleep(POLL_INTERVAL_MS);
    }

    logger.warn(`Lock release at ${lockPath}: claim arbitration unavailable, using the ownership-checked unlink`);
    unlinkIfOwned(lockPath);
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
        await releaseLock(lockPath);
    }
}

/** How often a queued caller looks whether its turn came; the work it waits behind takes far longer. */
const QUEUE_POLL_MS = 100;
/** A ticket this long past its own deadline belongs to a caller that gave up without removing it. */
const QUEUE_TICKET_GRACE_MS = 60_000;
let queueTickets = 0;

/** A queue ticket: the waiting process, when it wrote the ticket, and the moment it stops waiting (its timeout). */
function parseTicket(raw: string): { pid: number; at: number; until: number } | null {
    try {
        const parsed: unknown = SafeJSON.parse(raw, { strict: true });

        if (
            typeof parsed === "object" &&
            parsed !== null &&
            "pid" in parsed &&
            "at" in parsed &&
            "until" in parsed &&
            typeof parsed.pid === "number" &&
            typeof parsed.at === "number" &&
            typeof parsed.until === "number"
        ) {
            return { pid: parsed.pid, at: parsed.at, until: parsed.until };
        }
    } catch (error) {
        logger.debug({ error }, "file-lock queue: a ticket does not parse");
    }

    return null;
}

/**
 * Whether `own` is the oldest ticket of `queue` that still waits. A ticket of a dead process, one past its own
 * deadline and one that does not parse are removed on sight, so an abandoned waiter never holds up the queue.
 */
function firstInQueue(queue: string, own: string): boolean {
    for (const name of readdirSync(queue).sort()) {
        if (name >= own) {
            return true;
        }

        if (name.startsWith(".")) {
            continue;
        }

        const path = join(queue, name);
        let raw: string;

        try {
            raw = readFileSync(path, "utf-8");
        } catch (error) {
            // Gone meanwhile: its owner finished.
            if (isEnoent(error)) {
                continue;
            }

            throw error;
        }

        const ticket = parseTicket(raw);

        // A process that started after its ticket was written is another program on a recycled pid.
        if (
            ticket &&
            isProcessAliveSince(ticket.pid, ticket.at) &&
            Date.now() <= ticket.until + QUEUE_TICKET_GRACE_MS
        ) {
            return false;
        }

        logger.debug({ queue, ticket: name }, "file-lock queue: an abandoned ticket is removed");

        try {
            unlinkSync(path);
        } catch (error) {
            if (!isEnoent(error)) {
                throw error;
            }
        }
    }

    return true;
}

/**
 * {@link withFileLock}, served in arrival order across processes. Each caller puts a ticket into `<lockPath>.queue/`
 * (named by its arrival time) and takes the lock only when no older ticket still waits, so a process that releases
 * the lock and takes it again in a loop (a scan of hundreds of frames) cannot keep a waiting caller from its turn.
 * `timeout` covers the queue and the lock together; on expiry it throws {@link LockTimeoutError}.
 */
export async function withQueuedFileLock<T>(
    lockPath: string,
    fn: () => Promise<T>,
    timeout: number = DEFAULT_TIMEOUT_MS
): Promise<T> {
    const started = Date.now();
    const deadline = started + timeout;
    const queue = `${lockPath}.queue`;
    mkdirSync(queue, { recursive: true });
    queueTickets += 1;
    const name = `${String(started).padStart(15, "0")}-${String(queueTickets).padStart(9, "0")}-${process.pid}`;
    const ticket = join(queue, name);
    // Written whole under a hidden name first, so a reader never meets half a ticket.
    const draft = join(queue, `.${name}`);
    writeFileSync(draft, SafeJSON.stringify({ pid: process.pid, at: started, until: deadline }));
    renameSync(draft, ticket);

    try {
        while (!firstInQueue(queue, name)) {
            const left = deadline - Date.now();

            if (left <= 0) {
                throw new LockTimeoutError(lockPath, timeout);
            }

            await sleep(Math.min(QUEUE_POLL_MS, left));
        }

        return await withFileLock(lockPath, fn, Math.max(0, deadline - Date.now()));
    } finally {
        try {
            unlinkSync(ticket);
        } catch (error) {
            if (!isEnoent(error)) {
                logger.warn({ err: error, ticket }, "file-lock queue: the ticket could not be removed");
            }
        }
    }
}
