import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { configureLogger, logger } from "@app/logger";
import { getLogsBaseDir, getPidFile } from "./lib/config";
import { runSchedulerLoop } from "./lib/scheduler";

const { log } = logger.scoped("daemon");

/** Exit code when a live daemon already owns the pidfile at startup. */
export const EXIT_ALREADY_RUNNING = 1;
/** Exit code when we lose the atomic stale-pidfile takeover race to another racer. */
export const EXIT_LOST_TAKEOVER_RACE = 2;

const STALE_TAKEOVER_MAX_ATTEMPTS = 3;
const STALE_TAKEOVER_RETRY_MS = 50;

function isEexist(err: unknown): boolean {
    return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST";
}

function isEnoent(err: unknown): boolean {
    return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Atomically steal a stale pidfile whose content was pre-validated as dead.
 *
 * Renames it to a unique temp path first — rename is atomic on POSIX, so
 * under N concurrent racers (e.g. a launchd respawn storm) exactly one
 * rename succeeds; every loser gets ENOENT (the source is already gone
 * under them) and returns false rather than also "winning".
 *
 * The rename alone is NOT sufficient: rename steals whatever currently sits
 * at the path, so a late racer can grab the pidfile the previous winner just
 * wrote (validated-stale at check time, fresh at rename time — TOCTOU; a
 * 12-racer test reproduced two "winners" without this guard). So after the
 * rename, the stolen content must still equal `expectedContent` — the exact
 * stale artifact the caller validated. A mismatch means a fresh file was
 * grabbed: restore it (best-effort `wx`; if someone claimed the slot
 * meanwhile, the robbed owner's per-tick `verifyPidfileOwnership` self-exit
 * is the backstop) and lose.
 *
 * Uses the async `rename()` (not `renameSync`): Bun's synchronous fs calls
 * are reentrant under concurrent async-driven load (verified empirically —
 * many concurrent `renameSync` callers in one process can each observe a
 * "successful" rename of the same source), which breaks the single-winner
 * guarantee this function exists to provide. The async version dispatches
 * through the normal I/O completion queue with no such reentrancy.
 *
 * Exported for direct concurrency testing (see daemon.test.ts).
 */
export async function attemptStaleTakeover(pidFile: string, expectedContent: string): Promise<boolean> {
    const tempPath = `${pidFile}.stale-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

    try {
        await rename(pidFile, tempPath);
    } catch (err) {
        if (isEnoent(err)) {
            return false;
        }

        throw err;
    }

    let stolen: string | null = null;

    try {
        stolen = await readFile(tempPath, "utf-8");
    } catch {
        stolen = null;
    }

    if (stolen === null || stolen.trim() !== expectedContent.trim()) {
        // We grabbed something other than the validated-stale file — a fresh
        // owner wrote between our check and our rename. Put it back and lose.
        if (stolen !== null) {
            try {
                await writeFile(pidFile, stolen, { flag: "wx" });
            } catch {
                // Slot already re-claimed — the robbed owner self-heals via
                // its per-tick ownership check.
            }
        }

        try {
            unlinkSync(tempPath);
        } catch {
            // best-effort cleanup
        }

        return false;
    }

    try {
        await writeFile(pidFile, String(process.pid), { flag: "wx" });
    } catch (err) {
        if (isEexist(err)) {
            return false;
        }

        throw err;
    } finally {
        try {
            unlinkSync(tempPath);
        } catch {
            // best-effort cleanup; ENOENT if somehow already gone
        }
    }

    return true;
}

/**
 * Claim the daemon pidfile as our own.
 *
 * Fresh case: plain `wx` create. If it already exists, either a live daemon
 * owns it (fail fast) or it's stale, in which case we atomically race to
 * take it over. Losing the race means another racer already won and is (or
 * will shortly be) the live owner, so we re-check and exit cleanly with a
 * distinct code instead of retrying forever.
 */
async function claimPidfile(pidFile: string): Promise<void> {
    for (let attempt = 1; attempt <= STALE_TAKEOVER_MAX_ATTEMPTS; attempt++) {
        // Fresh create first — also the recovery path when a previous racer's
        // takeover left the slot momentarily empty.
        try {
            await writeFile(pidFile, String(process.pid), { flag: "wx" });
            return;
        } catch (err) {
            if (!isEexist(err)) {
                throw err;
            }
        }

        const owner = getDaemonPid();

        if (owner !== null && owner !== process.pid) {
            log.error({ existingPid: owner }, "[daemon] another daemon is already running");
            process.exit(EXIT_ALREADY_RUNNING);
        }

        // Read the raw stale content (getDaemonPid returned null, so whatever
        // pid is in there is dead) — the takeover only steals THIS artifact.
        let staleContent: string | null = null;

        try {
            staleContent = readFileSync(pidFile, "utf-8");
        } catch {
            staleContent = null; // vanished — loop retries the fresh create
        }

        if (staleContent !== null && (await attemptStaleTakeover(pidFile, staleContent))) {
            const confirmedOwner = getDaemonPid();

            if (confirmedOwner !== process.pid) {
                log.error(
                    { confirmedOwner },
                    "[daemon] pidfile takeover succeeded but ownership verification failed; exiting"
                );
                process.exit(EXIT_LOST_TAKEOVER_RACE);
            }

            return;
        }

        log.debug({ attempt }, "[daemon] lost pidfile takeover race; retrying");
        await Bun.sleep(STALE_TAKEOVER_RETRY_MS);
    }

    log.error("[daemon] lost pidfile takeover race after retries; another instance now owns the scope");
    process.exit(EXIT_LOST_TAKEOVER_RACE);
}

export async function startDaemon(): Promise<void> {
    const pidFile = getPidFile();
    mkdirSync(dirname(pidFile), { recursive: true });

    await claimPidfile(pidFile);

    log.info({ pid: process.pid }, "[daemon] starting");

    const cleanup = () => {
        if (existsSync(pidFile)) {
            unlinkSync(pidFile);
        }

        log.info("[daemon] stopped");
    };

    try {
        await runSchedulerLoop(getLogsBaseDir(), {
            verifyOwnership: () => verifyPidfileOwnership(pidFile),
        });
    } catch (err) {
        log.error({ err }, "[daemon] crashed");
        throw err;
    } finally {
        cleanup();
    }
}

export function getDaemonPid(): number | null {
    const pidFile = getPidFile();

    if (!existsSync(pidFile)) {
        return null;
    }

    try {
        const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);

        try {
            process.kill(pid, 0);
            return pid;
        } catch (err) {
            // EPERM means the process exists but belongs to another user —
            // that's "alive" on every platform, not just win32; treating it
            // as dead would green-light a pidfile takeover against a live owner.
            if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EPERM") {
                return pid;
            }

            return null;
        }
    } catch (err) {
        logger.debug({ err, pidFile }, "[daemon] failed to read/parse PID file");
        return null;
    }
}

/**
 * Cheap per-tick ownership check: does the pidfile still identify us?
 *
 * Guards against a daemon whose pidfile was stolen (or removed) out from
 * under it continuing to run as an untracked zombie — the scheduler loop
 * calls this once per tick and self-terminates on the first failed check.
 */
export function verifyPidfileOwnership(pidFile: string): boolean {
    if (!existsSync(pidFile)) {
        return false;
    }

    try {
        const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        return pid === process.pid;
    } catch {
        return false;
    }
}

if (import.meta.main) {
    configureLogger({ includeTimestamp: true });
    startDaemon().catch(() => {
        process.exitCode = 1;
    });
}
