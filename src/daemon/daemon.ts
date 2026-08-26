import { mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { configureLogger, logger } from "@genesiscz/utils/logger";
import {
    attemptStaleTakeover,
    buildPidRecord,
    clearPidFile,
    ownsPidFile,
    readLivePid,
    readSignalablePid,
    serializePidRecord,
} from "@genesiscz/utils/process/pidfile";
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

// The atomic stale-takeover protocol now lives in the shared pidfile util;
// re-exported so daemon.test.ts (and older callers) keep their import path.
export { attemptStaleTakeover };

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
            await writeFile(pidFile, serializePidRecord(buildPidRecord()), { flag: "wx" });
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
        // Guarded: a daemon that lost its claim must not delete the winner's file.
        clearPidFile(pidFile);
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

/**
 * True when a command line is recognisably one of OUR daemon processes.
 *
 * Two launch shapes reach `startDaemon()`, and both must match: launchd runs
 * `bun run <repo>/src/daemon/daemon.ts`, while `tools daemon [start]` runs the
 * loop in-process from `<repo>/src/daemon/index.ts`. A compiled/aliased
 * front-end (`tools daemon …`) is covered by the second pattern.
 */
export function isDaemonCommand(command: string): boolean {
    const normalized = command.replace(/\\/g, "/");

    return (
        /(^|[\s/])daemon\/(daemon|index)\.tsx?(\s|$)/.test(normalized) ||
        /(^|[\s/])tools\s+daemon(\s|$)/.test(normalized)
    );
}

/**
 * The pid of a live daemon, or null when the pidfile is stale.
 *
 * `kill(pid, 0)` alone cannot tell "our daemon is running" from "the kernel
 * recycled that number onto an unrelated program". On 2026-08-19 the pidfile
 * still held pid 891 from a daemon that had died without cleanup; macOS had
 * since handed 891 to WiFiCloudAssetsXPCService, so every launchd respawn read
 * it as a live owner and exited — 4284 restarts in ~12h, and nothing polled
 * Claude usage the whole time. The pidfile module records the owner's command
 * line and reports "foreign" for exactly that case; `isDaemonCommand` covers
 * the legacy bare-number files written before it did.
 */
export function getDaemonPid(): number | null {
    return readLivePid(getPidFile(), { expected: isDaemonCommand });
}

/**
 * The daemon pid ONLY when its identity is confirmed. Use this before any
 * signal; `getDaemonPid` counts `unverified` as ours so a second daemon refuses
 * to start, which is the right call there and the wrong one before a SIGKILL.
 */
export function getSignalableDaemonPid(): number | null {
    return readSignalablePid(getPidFile(), { expected: isDaemonCommand });
}

/**
 * Cheap per-tick ownership check: does the pidfile still identify us?
 *
 * Guards against a daemon whose pidfile was stolen (or removed) out from
 * under it continuing to run as an untracked zombie — the scheduler loop
 * calls this once per tick and self-terminates on the first failed check.
 */
export function verifyPidfileOwnership(pidFile: string): boolean {
    return ownsPidFile(pidFile);
}

if (import.meta.main) {
    configureLogger({ includeTimestamp: true });
    startDaemon().catch(() => {
        process.exitCode = 1;
    });
}
