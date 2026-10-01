import { TaskSessionStore } from "@app/task/lib/session-store";
import { logger } from "@genesiscz/utils/logger";
import { batchPsInfo, collectProcessTree, listPsTable, type PsRow } from "@genesiscz/utils/process/ps";
import { processStartMs, START_MS_TOLERANCE } from "@genesiscz/utils/process-identity";

const log = logger.child({ component: "task:stop-session" });

export interface StopSessionOptions {
    name: string;
    /** Grace period between SIGTERM and SIGKILL, ms. Default 5000. */
    graceMs?: number;
}

export type StopSessionOutcome =
    | { status: "not-found" }
    | { status: "already-finished"; previousState: "exited" | "stopped" }
    /** Session had no recorded pid (never started, or crashed before `updatePid`) — marked stopped, nothing to signal. */
    | { status: "no-pid" }
    | { status: "stopped"; termedPids: number[]; killedPids: number[] }
    /** A signal could not be delivered, or a verified target outlived SIGKILL: the session stays running. */
    | { status: "failed"; reason: string; alivePids: number[]; termedPids: number[]; killedPids: number[] };

const DEFAULT_GRACE_MS = 5000;
const POLL_INTERVAL_MS = 100;

function isMissingProcessError(err: unknown): boolean {
    return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ESRCH";
}

interface Identity {
    startTime: string;
    command: string;
}

/** A pid's start time and command line; null when the start time is unreadable, which proves nothing. */
function identityOf(row: PsRow | undefined): Identity | null {
    const startTime = row?.startTime?.toISOString();
    return row && startTime ? { startTime, command: row.command } : null;
}

/**
 * The pids among `pids` that still run the process the snapshot saw: same start time and command line,
 * read in one batched `ps` right before a signal loop. A pid reused by another process is dropped.
 */
function stillTheSame(pids: number[], snapshot: Map<number, Identity>): number[] {
    const live = batchPsInfo(pids);
    return pids.filter((pid) => {
        const was = snapshot.get(pid);
        const now = identityOf(live.get(pid));
        return was !== undefined && now !== null && was.startTime === now.startTime && was.command === now.command;
    });
}

/** Sends `signal` to each pid: the ones signalled, and the ones that refused for a reason other than being gone. */
export function signalPids(
    pids: number[],
    signal: NodeJS.Signals,
    kill: (pid: number, signal: NodeJS.Signals) => void = (pid, sig) => {
        // pid-verified: every caller passes pids stillTheSame just matched to the snapshot's start time and command line
        process.kill(pid, sig);
    }
): { signalled: number[]; refused: number[] } {
    const signalled: number[] = [];
    const refused: number[] = [];

    for (const pid of pids) {
        try {
            kill(pid, signal);
            signalled.push(pid);
        } catch (err) {
            if (!isMissingProcessError(err)) {
                log.warn({ err, pid, signal }, "signal refused for a reason other than a missing process");
                refused.push(pid);
            }
        }
    }

    return { signalled, refused };
}

/**
 * Poll until every pid in `pids` is gone or `deadline` passes, one batched `ps`
 * call per poll tick (never one `ps` per pid). Bounded `await Bun.sleep`, never
 * `sleepSync` — a stop command blocking the event loop would freeze its own
 * Ctrl+C handling right while it is trying to kill something.
 */
async function waitForPidsToExit(pids: number[], deadline: number): Promise<number[]> {
    let remaining = pids;

    while (remaining.length > 0 && Date.now() < deadline) {
        const alive = batchPsInfo(remaining);
        remaining = remaining.filter((pid) => alive.has(pid));

        if (remaining.length === 0) {
            break;
        }

        await Bun.sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }

    return remaining;
}

/**
 * SIGTERM the session's whole process tree, wait a grace period, SIGKILL
 * whatever is left, then record the session as `stopped` — never a signal's
 * exit code (130/143), which reads as if the child chose to exit that way.
 */
export async function stopSession(
    opts: StopSessionOptions & { kill?: (pid: number, signal: NodeJS.Signals) => void }
): Promise<StopSessionOutcome> {
    const store = new TaskSessionStore();
    const meta = await store.reconcileSessionState(opts.name);

    if (!meta) {
        return { status: "not-found" };
    }

    if (meta.stopped) {
        return { status: "already-finished", previousState: "stopped" };
    }

    if (meta.exitCode !== undefined) {
        return { status: "already-finished", previousState: "exited" };
    }

    if (meta.pid === undefined) {
        await store.markStopped({ name: opts.name, durationMs: Date.now() - meta.createdAt });
        return { status: "no-pid" };
    }

    const rows = await listPsTable();
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const snapshot = new Map<number, Identity>();

    for (const pid of collectProcessTree(meta.pid, rows)) {
        const identity = identityOf(byPid.get(pid));

        if (identity) {
            snapshot.set(pid, identity);
        }
    }

    // The root must still be the recorded task after the await above: the same start-time reader and
    // tolerance updatePid and reconcileSessionState use, not the ps table's one-second, local-time column.
    const rootStart = processStartMs(meta.pid);
    const rootMoved =
        meta.pidStartedAt !== undefined &&
        (rootStart === null || Math.abs(rootStart - meta.pidStartedAt) > START_MS_TOLERANCE);

    if (rootMoved) {
        snapshot.delete(meta.pid);
    }

    const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    const term = signalPids(stillTheSame([...snapshot.keys()], snapshot), "SIGTERM", opts.kill);
    const termedPids = term.signalled;
    const stillAlive = termedPids.length > 0 ? await waitForPidsToExit(termedPids, Date.now() + graceMs) : [];

    const kill =
        stillAlive.length > 0
            ? signalPids(stillTheSame(stillAlive, snapshot), "SIGKILL", opts.kill)
            : { signalled: [], refused: [] };
    const killedPids = kill.signalled;
    const survivors = killedPids.length > 0 ? await waitForPidsToExit(killedPids, Date.now() + graceMs) : [];
    const alivePids = [...new Set([...term.refused, ...kill.refused, ...survivors])];

    if (alivePids.length > 0) {
        log.warn(
            { name: opts.name, alivePids },
            "stop: processes survived or refused a signal; the session stays running"
        );
        return {
            status: "failed",
            reason: survivors.length > 0 ? "a process outlived SIGKILL" : "a signal was refused (permission?)",
            alivePids,
            termedPids,
            killedPids,
        };
    }

    await store.markStopped({ name: opts.name, durationMs: Date.now() - meta.createdAt });

    return { status: "stopped", termedPids, killedPids };
}
