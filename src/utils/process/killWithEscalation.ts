import { logger } from "@genesiscz/utils/logger";

export interface KillableProcess {
    kill(signal?: NodeJS.Signals | number): void;
    readonly killed?: boolean;
    exited?: Promise<number | null | undefined>;
    on?(event: "exit", listener: () => void): void;
    exitCode?: number | null;
}

async function waitForExit(child: KillableProcess): Promise<void> {
    if (child.exitCode !== null && child.exitCode !== undefined) {
        return;
    }

    if (child.exited) {
        await child.exited;
        return;
    }

    await new Promise<void>((resolve) => {
        child.on?.("exit", () => resolve());
    });
}

/** A child spawned as the leader of its own detached process group. */
export interface GroupLeaderProcess {
    readonly pid?: number;
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
}

/**
 * Signal a whole detached process group, once, and only while it is still running.
 *
 * Killing the LEADER alone orphans everything it started, which is why these callers spawn
 * detached and signal the negated pid. The liveness guard is the point: `process.kill` on a
 * reaped pid either throws ESRCH or, far worse, reaches whatever the OS has since given that
 * number. Returns false when there was nothing live to signal.
 */
export function killProcessGroup(child: GroupLeaderProcess, signal: NodeJS.Signals, what: string): boolean {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
        return false;
    }

    try {
        // pid-verified: retained live child handle, spawned here as leader of this detached process group.
        process.kill(-child.pid, signal);
        return true;
    } catch (error) {
        logger.debug({ error, pid: child.pid, signal }, `${what} group already ended`);
        return false;
    }
}

function isMissingProcessError(err: unknown): boolean {
    return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ESRCH";
}

/** SIGTERM, then SIGKILL after grace if the child is still alive. Returns true once exit is confirmed. */
export async function killWithEscalation(child: KillableProcess, opts: { graceMs?: number } = {}): Promise<boolean> {
    const graceMs = opts.graceMs ?? 5000;

    try {
        child.kill("SIGTERM");
    } catch (err) {
        if (isMissingProcessError(err)) {
            return true;
        }

        logger.debug({ err }, "[killWithEscalation] SIGTERM failed for a reason other than a missing process");
        return false;
    }

    const exited = await Promise.race([
        waitForExit(child).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
    ]);

    if (!exited) {
        try {
            child.kill("SIGKILL");
        } catch (err) {
            if (isMissingProcessError(err)) {
                return true;
            }

            logger.debug({ err }, "[killWithEscalation] SIGKILL failed for a reason other than a missing process");
            return false;
        }

        await waitForExit(child);
    }

    return true;
}
