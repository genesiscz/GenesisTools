import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
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
} from "@genesiscz/utils/process/pidfile";

const DEFAULT_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 50;
const ORPHANED_PID_RECHECK_MS = 100;

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

/**
 * Atomically steal a stale/orphaned lock file whose content was pre-validated.
 *
 * Renames the lock to a unique temp path first — `rename` is atomic on POSIX,
 * so under N concurrent stealers exactly one rename succeeds; every loser gets
 * ENOENT (the source is already gone under them) and returns false. Only the
 * rename winner proceeds to claim the path with its own `wx` write.
 *
 * The rename alone is NOT sufficient: it steals whatever currently sits at
 * the path, so a late stealer can grab the lock a legitimate holder just
 * (re-)acquired (TOCTOU — the daemon pidfile twin of this code reproduced
 * two "winners" in a 12-racer test without the guard). After the rename the
 * stolen content must still equal `expectedContent` — the exact stale
 * artifact the caller validated (a dead pid, or "" for the orphaned-empty
 * case). On mismatch the fresh file is restored best-effort and the steal
 * reports defeat.
 *
 * Exported for direct race testing (see file-lock.test.ts).
 */
async function attemptRenameStealUnlocked(lockPath: string, expectedContent: string): Promise<boolean> {
    const tempPath = `${lockPath}.stale-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

    try {
        await rename(lockPath, tempPath);
    } catch (err) {
        if (isEnoent(err)) {
            return false;
        }

        throw err;
    }

    let stolen: string | null = null;

    try {
        stolen = await Bun.file(tempPath).text();
    } catch {
        stolen = null;
    }

    if (stolen === null || stolen.trim() !== expectedContent.trim()) {
        if (stolen !== null) {
            try {
                await writeFile(lockPath, stolen, { flag: "wx" });
            } catch (err) {
                // Slot already re-claimed; the robbed holder's release is
                // ownership-checked, so worst case is one early-released lock.
                logger.debug(`Steal-restore skipped at ${lockPath} (slot re-claimed): ${err}`);
            }
        }

        try {
            await unlink(tempPath);
        } catch (err) {
            // Best effort, but never silent: this temp path ends in a random
            // suffix, so `sweepStaleLocks` (which matches .lock/.login) never
            // reaps it, and a leaked one sits in ~/.genesis-tools forever with
            // nothing on record to explain it.
            logger.debug({ err, tempPath }, "steal temp file left behind after a failed steal");
        }

        return false;
    }

    try {
        await writeFile(lockPath, serializePidRecord(buildPidRecord()), { flag: "wx" });
    } catch (err) {
        if (isEexist(err)) {
            return false;
        }

        throw err;
    } finally {
        try {
            await unlink(tempPath);
        } catch (err) {
            // ENOENT if somehow already gone. Logged for the same reason as
            // above: nothing sweeps this path by name.
            logger.debug({ err, tempPath }, "steal temp file left behind after claiming the lock");
        }
    }

    return true;
}

export async function attemptRenameSteal(lockPath: string, expectedContent: string): Promise<boolean> {
    const arbitration = await tryWithPathArbitration(lockPath, () =>
        attemptRenameStealUnlocked(lockPath, expectedContent)
    );
    return arbitration.acquired ? arbitration.value : false;
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
async function tryAcquireLockUnlocked(lockPath: string): Promise<boolean> {
    const dir = dirname(lockPath);

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    // Atomic exclusive create — fails with EEXIST if another process holds it
    try {
        await writeFile(lockPath, serializePidRecord(buildPidRecord()), { flag: "wx" });
        return true;
    } catch (err) {
        if (!isEexist(err)) {
            // Real I/O error (EACCES, ENOSPC, etc.) — fail fast rather than timing out
            throw err;
        }

        // Lock file exists — check if the owning process is still alive.
        // The raw bytes are kept so the steal below compares exactly what was
        // validated here, whatever record format the holder wrote.
        let content: string;
        let record: PidRecord | null;

        try {
            content = await Bun.file(lockPath).text();
            record = parsePidRecord(content);
        } catch {
            // Can't read the lock file — assume it's held
            return false;
        }

        if (record === null) {
            // Lock file has no valid PID content. writeFile with `flag:"wx"` is
            // O_CREAT|O_EXCL followed by a separate write() syscall, so a
            // legitimate owner is empty for microseconds; but a SIGKILL between
            // those two syscalls leaves a permanently empty (0-byte) lock that
            // would otherwise block every future acquirer until timeout.
            // Disambiguate by re-reading after a short grace: if the owner is
            // real, the PID appears; if the file stays empty, the lock is
            // orphaned and safe to steal.
            await sleep(ORPHANED_PID_RECHECK_MS);

            try {
                content = await Bun.file(lockPath).text();
                record = parsePidRecord(content);
            } catch {
                return false;
            }

            if (record === null) {
                // Still empty after grace — orphaned. Steal (expecting the
                // empty artifact we validated).
                logger.debug(`Stealing orphaned lock at ${lockPath} (no PID content)`);
                return await attemptRenameStealUnlocked(lockPath, content);
            }
            // Owner finished its write during the grace — fall through to the
            // normal alive/dead check below.
        }

        // Identity, not just liveness: a holder that died and had its number
        // reissued would otherwise look alive forever, and every acquirer would
        // time out against a lock nobody holds. Same verdict as inspectPidFile
        // (command + startedAt), including when the recycled pid is ours.
        const identity = classifyPidRecord(record);
        if (identity.status === "live" || identity.status === "unverified") {
            return false;
        }

        if (identity.status === "foreign") {
            logger.debug(`Stealing stale lock at ${lockPath} (PID ${record.pid} was reused by ${identity.command})`);
        } else {
            logger.debug(`Stealing stale lock at ${lockPath} (PID ${record.pid} is dead)`);
        }

        return await attemptRenameStealUnlocked(lockPath, content);
    }
}

export async function tryAcquireLock(lockPath: string): Promise<boolean> {
    const arbitration = await tryWithPathArbitration(lockPath, () => tryAcquireLockUnlocked(lockPath));
    return arbitration.acquired ? arbitration.value : false;
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

/** A queue ticket: the waiting process, and the moment it stops waiting (its timeout). */
function parseTicket(raw: string): { pid: number; until: number } | null {
    try {
        const parsed: unknown = SafeJSON.parse(raw, { strict: true });

        if (
            typeof parsed === "object" &&
            parsed !== null &&
            "pid" in parsed &&
            "until" in parsed &&
            typeof parsed.pid === "number" &&
            typeof parsed.until === "number"
        ) {
            return { pid: parsed.pid, until: parsed.until };
        }
    } catch (error) {
        logger.debug({ error }, "file-lock queue: a ticket does not parse");
    }

    return null;
}

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM: the process exists but belongs to another user.
        return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM";
    }
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

        if (ticket && processAlive(ticket.pid) && Date.now() <= ticket.until + QUEUE_TICKET_GRACE_MS) {
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
    writeFileSync(draft, SafeJSON.stringify({ pid: process.pid, until: deadline }));
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
