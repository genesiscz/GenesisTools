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

export function readProcessCommand(pid: number): string | null {
    if (process.platform === "win32") {
        return null;
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
        return command.length > 0 ? command : null;
    } catch (err) {
        logger.debug({ err, pid }, "process-identity: ps lookup failed");
        return null;
    }
}

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
