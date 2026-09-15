import { logger } from "@genesiscz/utils/logger";

/**
 * PID-identity verification for pid files and lock records.
 *
 * `isProcessAlive(pid)` alone cannot distinguish "our daemon is running" from
 * "the kernel recycled that number onto an unrelated program". That produced a
 * real incident (2026-08-11): ai-proxy's recorded pid landed on `darwinkit
 * serve`, status reported the dead proxy as running for a week, `up` refused to
 * restart, and `down` would have SIGKILLed the innocent process.
 *
 * The cure is identity: capture the command line when recording a pid
 * ({@link readProcessCommand}), and classify the record before trusting or
 * signalling it ({@link classifyPid}).
 */

/**
 * Our own command line and start time never change for the life of the process, yet
 * `buildPidRecord()` asked `ps` for both on EVERY lock acquire and pidfile write: two
 * synchronous spawns, each blocking the event loop the lock HOLDER needs to finish and
 * release. Counted with a `ps` shim on PATH: 143 spawns per run of
 * src/scripts/lib/journal.test.ts, a 17-test file that only touches a temp directory. On a
 * loaded 4-vCPU runner, where spawn is what degrades first, that pushed its 2 s
 * serialisation test past the 5 s acquire timeout and turned five tests red (CI run
 * 35003930205, same commit clean on another runner). A failed lookup is NOT cached, so a
 * transient `ps` error still retries on the next call exactly as before.
 */
let ownCommand: string | null = null;
let ownStartMs: number | null = null;

export function readProcessCommand(pid: number): string | null {
    if (process.platform === "win32") {
        return null;
    }

    if (pid === process.pid && ownCommand !== null) {
        return ownCommand;
    }

    try {
        const proc = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], {
            stdout: "pipe",
            stderr: "pipe",
        });

        if (proc.exitCode !== 0) {
            return null;
        }

        const command = proc.stdout.toString().trim();
        const result = command.length > 0 ? command : null;

        if (pid === process.pid) {
            ownCommand = result;
        }

        return result;
    } catch (err) {
        logger.debug({ err, pid }, "process-identity: ps lookup failed");
        return null;
    }
}

/**
 * When the process at `pid` started, in epoch ms, or null if it cannot be read.
 *
 * Derived from `ps -o etime=`, so it carries that command's one-second
 * granularity: two readings for the SAME live process differ by up to about a
 * second, never more. Compare with {@link START_MS_TOLERANCE}, never for
 * equality.
 *
 * This is the signal a command-line comparison cannot give you. A pid recycled
 * onto a process with identical argv still has a different start time, so this
 * is what separates "our daemon" from "a second copy launched the same way".
 */
export function processStartMs(pid: number): number | null {
    if (process.platform === "win32") {
        return null;
    }

    if (pid === process.pid && ownStartMs !== null) {
        return ownStartMs;
    }

    try {
        const proc = Bun.spawnSync(["ps", "-p", String(pid), "-o", "etime="], { stdout: "pipe", stderr: "pipe" });
        const etime = proc.stdout.toString().trim();
        const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime);

        if (!match) {
            return null;
        }

        const [, days, hours, minutes, seconds] = match;
        const elapsedMs =
            (((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
        const startMs = Date.now() - elapsedMs;

        if (pid === process.pid) {
            ownStartMs = startMs;
        }

        return startMs;
    } catch (err) {
        logger.debug({ err, pid }, "process-identity: ps etime lookup failed");
        return null;
    }
}

/** `ps -o etime=` resolves to whole seconds, so allow two of them either way. */
export const START_MS_TOLERANCE = 2000;

export type PidIdentityStatus =
    /** Alive and the command line matches the expectation. */
    | "live"
    /** No process with this pid. */
    | "dead"
    /** Alive, but the command line does not match — the pid was recycled. */
    | "foreign"
    /** Alive, but no expectation was recorded or the OS wouldn't tell us. */
    | "unverified";

export interface PidIdentity {
    status: PidIdentityStatus;
    pid: number;
    /** The pid's current command line, when it was alive and readable. */
    command?: string;
}

function isProcessAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as { code?: string }).code !== "ESRCH";
    }
}

/**
 * Classify a recorded pid against the identity captured when it was recorded.
 *
 * `expected` is either the exact command line stored at record time, or a
 * predicate for callers with a static signature (e.g. "is this an ai-proxy
 * serve process?"). Without an expectation the best we can say is
 * "unverified" — callers should treat that like "live" to stay backward
 * compatible with records written before identity capture existed.
 */
export function classifyPid(pid: number, expected?: string | ((command: string) => boolean)): PidIdentity {
    if (!isProcessAlive(pid)) {
        return { status: "dead", pid };
    }

    if (expected === undefined) {
        return { status: "unverified", pid };
    }

    const command = readProcessCommand(pid);
    if (command === null) {
        return { status: "unverified", pid };
    }

    const matches = typeof expected === "string" ? command === expected : expected(command);
    if (!matches) {
        return { status: "foreign", pid, command };
    }

    return { status: "live", pid, command };
}
