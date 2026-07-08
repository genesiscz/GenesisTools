import { getDaemonStatus } from "@app/daemon/lib/launchd";

export const RESTART_TIMEOUT_MS = 10_000;

/** Kill a process, ignoring ESRCH (already dead). Re-throws other errors. */
export function safeSigterm(pid: number): void {
    try {
        process.kill(pid, "SIGTERM");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
            throw err;
        }
    }
}

/** Grace after the first SIGTERM (the daemon's graceful unwind window). */
export const ESCALATION_FIRST_GRACE_MS = 8_000;
/** Grace after the second SIGTERM (the scheduler's repeat-signal handler exits immediately). */
export const ESCALATION_SECOND_GRACE_MS = 4_000;
/** Grace after SIGKILL — the kernel needs no cooperation, this only bounds the poll. */
export const ESCALATION_KILL_GRACE_MS = 2_000;

export type EscalationStep = "sigterm" | "sigterm-again" | "sigkill";

export type EscalationResult = {
    /** Whether the process is gone. */
    exited: boolean;
    /** The step that finished it (null if it survived even SIGKILL within the poll window). */
    step: EscalationStep | null;
};

type EscalationSeams = {
    firstGraceMs?: number;
    secondGraceMs?: number;
    killGraceMs?: number;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    isAlive?: (pid: number) => boolean;
    sleep?: (ms: number) => Promise<void>;
};

function defaultIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM = alive but another user's; only ESRCH means gone.
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

function defaultKill(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(pid, signal);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
            throw err;
        }
    }
}

async function pollUntilDead(
    pid: number,
    graceMs: number,
    isAlive: (pid: number) => boolean,
    sleep: (ms: number) => Promise<void>
): Promise<boolean> {
    const deadline = Date.now() + graceMs;

    while (Date.now() < deadline) {
        if (!isAlive(pid)) {
            return true;
        }

        await sleep(200);
    }

    return !isAlive(pid);
}

/**
 * Stop a daemon with escalation: SIGTERM → grace → SIGTERM again (the
 * scheduler's repeat-signal handler force-exits) → grace → SIGKILL.
 *
 * Born from the Jul 6/8 incident: a wedged daemon ignored the single SIGTERM
 * `stop`/`restart` used to send, so both commands just timed out and left the
 * zombie running until a human reached for `kill -9`. The ladder makes the
 * commands terminal: they report which step worked instead of giving up.
 */
export async function stopWithEscalation(pid: number, seams: EscalationSeams = {}): Promise<EscalationResult> {
    const firstGraceMs = seams.firstGraceMs ?? ESCALATION_FIRST_GRACE_MS;
    const secondGraceMs = seams.secondGraceMs ?? ESCALATION_SECOND_GRACE_MS;
    const killGraceMs = seams.killGraceMs ?? ESCALATION_KILL_GRACE_MS;
    const kill = seams.kill ?? defaultKill;
    const isAlive = seams.isAlive ?? defaultIsAlive;
    const sleep = seams.sleep ?? ((ms: number) => Bun.sleep(ms));

    if (!isAlive(pid)) {
        return { exited: true, step: null };
    }

    kill(pid, "SIGTERM");

    if (await pollUntilDead(pid, firstGraceMs, isAlive, sleep)) {
        return { exited: true, step: "sigterm" };
    }

    kill(pid, "SIGTERM");

    if (await pollUntilDead(pid, secondGraceMs, isAlive, sleep)) {
        return { exited: true, step: "sigterm-again" };
    }

    kill(pid, "SIGKILL");

    if (await pollUntilDead(pid, killGraceMs, isAlive, sleep)) {
        return { exited: true, step: "sigkill" };
    }

    return { exited: false, step: null };
}

/**
 * Poll launchd until a new PID appears (different from oldPid).
 * Returns `{ pid }` on success, `null` on timeout.
 */
export async function waitForDaemonRestart(
    oldPid: number | null,
    timeoutMs = RESTART_TIMEOUT_MS
): Promise<{ pid: number } | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const status = await getDaemonStatus();

        if (status.running && status.pid && status.pid !== oldPid) {
            return { pid: status.pid };
        }

        await Bun.sleep(500);
    }

    return null;
}
