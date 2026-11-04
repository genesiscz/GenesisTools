import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ensureWidgetRunning } from "@app/hub/lib/widget/autostart";
import { ensureWatcher } from "@app/meetings/commands/watch";
import { configureLogger, logger } from "@genesiscz/utils/logger";
import {
    attemptStaleTakeover,
    claimPidFile,
    clearPidFile,
    ownsPidFile,
    readLivePid,
    readSignalablePid,
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

// The atomic stale-takeover protocol now lives in the shared pidfile util;
// re-exported so daemon.test.ts (and older callers) keep their import path.
export { attemptStaleTakeover };

/**
 * Claim the daemon pidfile as our own through the shared claim: a live daemon's claim exits as already running, a
 * stale one is taken over (and the takeover is confirmed), and losing every takeover round exits with its own code
 * instead of retrying forever.
 */
export async function claimPidfile(pidFile: string): Promise<void> {
    const claim = await claimPidFile(pidFile, {
        expected: isDaemonCommand,
        attempts: STALE_TAKEOVER_MAX_ATTEMPTS,
        retryMs: STALE_TAKEOVER_RETRY_MS,
    });

    if (claim.status === "held") {
        log.error(
            { existingPid: "pid" in claim.state ? claim.state.pid : undefined },
            "[daemon] another daemon is already running"
        );
        process.exit(EXIT_ALREADY_RUNNING);
    }

    if (claim.status === "lost") {
        log.error("[daemon] lost pidfile takeover race after retries; another instance now owns the scope");
        process.exit(EXIT_LOST_TAKEOVER_RACE);
    }

    if (claim.tookOver) {
        const confirmedOwner = getDaemonPid();

        if (confirmedOwner !== process.pid) {
            log.error(
                { confirmedOwner },
                "[daemon] pidfile takeover succeeded but ownership verification failed; exiting"
            );
            process.exit(EXIT_LOST_TAKEOVER_RACE);
        }
    }
}

export async function startDaemon(): Promise<void> {
    const pidFile = getPidFile();
    mkdirSync(dirname(pidFile), { recursive: true });

    await claimPidfile(pidFile);

    log.info({ pid: process.pid }, "[daemon] starting");

    // launchd starts the daemon at login, and nothing else brings the widget back after a reboot.
    ensureWidgetRunning()
        .then((result) => log.info({ result }, "[daemon] widget at start"))
        .catch((err) => log.warn({ err }, "[daemon] widget start check failed"));

    // The meetings watcher records the screen with Wispr Flow's recordings, when the user turned it on.
    ensureWatcher()
        .then((result) => log.info({ result }, "[daemon] meetings watcher at start"))
        .catch((err) => log.warn({ err }, "[daemon] meetings watcher start failed"));

    const cleanup = () => {
        // Guarded: a daemon that lost its claim must not delete the winner's file.
        clearPidFile(pidFile);
        log.info("[daemon] stopped");
    };

    // Test seam, in the same shape the daemon dir already uses: the scheduler idles inside
    // wakefulSleep, which only re-reads its abort flag between 2 s ticks, so a spawned
    // daemon took ~2.0 s to unwind after SIGTERM. The env var shortens the poll, never the
    // shutdown path, so the graceful pidfile removal the tests assert still runs in full.
    const tickOverride = Number(process.env.GENESIS_TOOLS_DAEMON_WAKEFUL_TICK_MS ?? "");

    try {
        await runSchedulerLoop(getLogsBaseDir(), {
            verifyOwnership: () => verifyPidfileOwnership(pidFile),
            wakefulTickMs: Number.isFinite(tickOverride) && tickOverride > 0 ? tickOverride : undefined,
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
