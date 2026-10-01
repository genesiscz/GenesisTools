import { TaskSessionStore } from "@app/task/lib/session-store";
import { logger } from "@genesiscz/utils/logger";
import { batchPsInfo, collectProcessTree, listPsTable } from "@genesiscz/utils/process/ps";

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
    | { status: "stopped"; termedPids: number[]; killedPids: number[] };

const DEFAULT_GRACE_MS = 5000;
const POLL_INTERVAL_MS = 100;

function isMissingProcessError(err: unknown): boolean {
    return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ESRCH";
}

/** Send `signal` to every pid still alive. Returns the ones actually signalled (skips pids already gone). */
function signalPids(pids: number[], signal: NodeJS.Signals): number[] {
    const signalled: number[] = [];

    for (const pid of pids) {
        try {
            // pid-verified: root pid classified live by reconcileSessionState just before this call; descendants came from the same listPsTable() snapshot, filtered to pids that snapshot showed alive
            process.kill(pid, signal);
            signalled.push(pid);
        } catch (err) {
            if (!isMissingProcessError(err)) {
                log.debug({ err, pid, signal }, "signal failed for a reason other than a missing process");
            }
        }
    }

    return signalled;
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
export async function stopSession(opts: StopSessionOptions): Promise<StopSessionOutcome> {
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
    const aliveRowPids = new Set(rows.map((row) => row.pid));
    const tree = collectProcessTree(meta.pid, rows);
    const alivePids = tree.filter((pid) => aliveRowPids.has(pid));

    const termedPids = alivePids.length > 0 ? signalPids(alivePids, "SIGTERM") : [];
    const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    const stillAlive = termedPids.length > 0 ? await waitForPidsToExit(termedPids, Date.now() + graceMs) : [];

    const killedPids = stillAlive.length > 0 ? signalPids(stillAlive, "SIGKILL") : [];
    if (killedPids.length > 0) {
        await waitForPidsToExit(killedPids, Date.now() + graceMs);
    }

    await store.markStopped({ name: opts.name, durationMs: Date.now() - meta.createdAt });

    return { status: "stopped", termedPids, killedPids };
}
