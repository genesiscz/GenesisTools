import { logger } from "@genesiscz/utils/logger";
import { batchPsInfo } from "@genesiscz/utils/process/ps";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { type ProcsSources, readProcsReport, realProcsSources } from "./sources";
import type { ProcGroup, ProcsReport } from "./tree";

const log = logger.child({ component: "hub/procs/stop" });

export const DEFAULT_GRACE_MS = 5_000;
/** After SIGKILL the kernel reaps at once; this only waits for the table to catch up. */
const KILL_WAIT_MS = 2_000;
const POLL_MS = 200;

export interface StopOutcome {
    pid: number;
    label: string;
    /** Every pid of the tree the stop covered, root first. */
    pids: number[];
    stopped: boolean;
    /** The strongest signal that was needed: TERM, KILL, or null when nothing was sent. */
    signal: "TERM" | "KILL" | null;
    /** Pids still alive at the end. */
    survivors: number[];
    /** Why nothing was sent, or what went wrong. */
    reason: string | null;
}

/** Signals and liveness; tests pass fakes, so no real process is ever signalled from a test. */
export interface SignalOps {
    signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
    alive(pid: number): boolean;
    /** Start time and command of each pid still running (one batched `ps -p`). */
    identity(pids: number[]): Map<number, { startedAt: string | null; command: string }>;
    sleep(ms: number): Promise<void>;
    now(): number;
}

export const realSignalOps: SignalOps = {
    signal: (pid, signal) => {
        // pid-verified: stopTree compares each pid's start time and command (ops.identity) right before every signal
        process.kill(pid, signal);
    },
    // EPERM counts as alive: the process exists but belongs to someone else.
    alive: (pid) => isProcessAlive(pid),
    identity: (pids) => {
        const found = new Map<number, { startedAt: string | null; command: string }>();

        for (const [pid, row] of batchPsInfo(pids)) {
            found.set(pid, { startedAt: row.startTime?.toISOString() ?? null, command: row.command });
        }

        return found;
    },
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
};

/** Where `pid` sits in the report: a group root, or a member of one (then the stop covers its subtree). */
export function locate(report: ProcsReport, pid: number): { group: ProcGroup; pids: number[] } | null {
    for (const group of report.groups) {
        const at = group.processes.findIndex((entry) => entry.pid === pid);

        if (at < 0) {
            continue;
        }

        if (at === 0) {
            return { group, pids: group.processes.map((entry) => entry.pid) };
        }

        // A member: itself and the members listed after it at a deeper level (depth-first order).
        const depth = group.processes[at].depth;
        const pids = [pid];

        for (const entry of group.processes.slice(at + 1)) {
            if (entry.depth <= depth) {
                break;
            }

            pids.push(entry.pid);
        }

        return { group, pids };
    }

    return null;
}

/** Why `pid` must not be stopped, or null. Checked against a report taken right before the signals. */
export function refusal(report: ProcsReport, pid: number, own: Set<number>): string | null {
    if (!Number.isInteger(pid) || pid <= 1) {
        return `${pid} is not a pid that can be stopped`;
    }

    if (own.has(pid)) {
        return `${pid} runs the command that asked (its own session or the hub's tools call); stop it from elsewhere`;
    }

    const found = locate(report, pid);

    if (!found) {
        return `${pid} is not an agent process, MCP server, tool shell or agent wrapper (tools hub procs lists them)`;
    }

    const mine = found.pids.find((member) => own.has(member));

    if (mine !== undefined) {
        return `${pid}'s tree holds ${mine}, which runs the command that asked; stop it from elsewhere`;
    }

    if (found.group.launchdLabel && found.pids[0] === found.group.rootPid) {
        return `${pid} is the launchd job ${found.group.launchdLabel}; stop it with launchctl`;
    }

    return null;
}

/**
 * Stop one process tree by pid: SIGTERM to every pid (root first, so the agent can close its own MCP
 * servers), wait up to `graceMs`, then SIGKILL whatever is left, but only a pid whose start time and
 * command still match what the report saw (a pid the kernel handed to a new process is left alone).
 * Never by name, never a process group.
 */
export async function stopTree({
    pid,
    graceMs = DEFAULT_GRACE_MS,
    sources = realProcsSources,
    ops = realSignalOps,
    report,
}: {
    pid: number;
    graceMs?: number;
    sources?: ProcsSources;
    ops?: SignalOps;
    /** A report taken moments ago (stop-all-orphans shares one); read fresh when absent. */
    report?: ProcsReport;
}): Promise<StopOutcome> {
    const current = report ?? (await readProcsReport({ sources }));
    const why = refusal(current, pid, sources.own());
    const found = locate(current, pid);
    const label = found?.group.processes.find((entry) => entry.pid === pid)?.label ?? "";

    if (why || !found) {
        log.info({ pid, reason: why }, "procs stop refused");
        return {
            pid,
            label,
            pids: found?.pids ?? [],
            stopped: false,
            signal: null,
            survivors: [],
            reason: why ?? "not found",
        };
    }

    const seen = new Map(
        found.group.processes
            .filter((entry) => found.pids.includes(entry.pid))
            .map((entry) => [entry.pid, { startedAt: entry.startedAt, command: entry.command }])
    );
    const same = (live: Map<number, { startedAt: string | null; command: string }>, member: number): boolean => {
        const was = seen.get(member);
        const now = live.get(member);
        return was !== undefined && now !== undefined && was.startedAt === now.startedAt && was.command === now.command;
    };

    // Re-check identity right before the first signal: the report may be seconds old.
    const before = ops.identity(found.pids);
    const targets = found.pids.filter((member) => same(before, member));
    log.info(
        { pid, label, pids: targets, skipped: found.pids.filter((m) => !targets.includes(m)) },
        "procs stop: SIGTERM"
    );

    for (const member of targets) {
        send(ops, member, "SIGTERM");
    }

    let alive = await waitGone(ops, targets, graceMs);
    let signal: StopOutcome["signal"] = targets.length > 0 ? "TERM" : null;

    if (alive.length > 0) {
        const live = ops.identity(alive);
        const killable = alive.filter((member) => same(live, member));
        log.info(
            { pid, killable, changed: alive.filter((m) => !killable.includes(m)) },
            "procs stop: SIGKILL after grace"
        );

        for (const member of killable) {
            send(ops, member, "SIGKILL");
        }

        signal = killable.length > 0 ? "KILL" : signal;
        alive = await waitGone(ops, killable, KILL_WAIT_MS);
    }

    const outcome: StopOutcome = {
        pid,
        label,
        pids: found.pids,
        stopped: alive.length === 0 && targets.length > 0,
        signal,
        survivors: alive,
        reason:
            targets.length === 0
                ? "every pid had already exited or now belongs to another process"
                : alive.length > 0
                  ? `still running after SIGKILL: ${alive.join(", ")}`
                  : null,
    };
    log.info(outcome, "procs stop done");
    return outcome;
}

function send(ops: SignalOps, pid: number, signal: "SIGTERM" | "SIGKILL"): void {
    try {
        ops.signal(pid, signal);
    } catch (err) {
        log.debug({ err, pid, signal }, "signal failed (the process may have exited)");
    }
}

/** Poll with `kill(pid, 0)` (a syscall, no child process) until every pid is gone or the deadline passes. */
async function waitGone(ops: SignalOps, pids: number[], deadlineMs: number): Promise<number[]> {
    const until = ops.now() + deadlineMs;
    let alive = pids.filter((pid) => ops.alive(pid));

    while (alive.length > 0 && ops.now() < until) {
        await ops.sleep(Math.min(POLL_MS, Math.max(1, until - ops.now())));
        alive = alive.filter((pid) => ops.alive(pid));
    }

    return alive;
}

/**
 * Stop every orphan group of one fresh report, one after another. `only` limits it to the roots a
 * person confirmed: an orphan that appeared since is left for the next look.
 */
export async function stopOrphans({
    graceMs = DEFAULT_GRACE_MS,
    only,
    sources = realProcsSources,
    ops = realSignalOps,
}: {
    graceMs?: number;
    only?: number[];
    sources?: ProcsSources;
    ops?: SignalOps;
} = {}): Promise<StopOutcome[]> {
    const report = await readProcsReport({ sources });
    const outcomes: StopOutcome[] = [];
    const wanted = only ? new Set(only) : null;

    for (const group of report.groups.filter((entry) => entry.orphan && (!wanted || wanted.has(entry.rootPid)))) {
        outcomes.push(await stopTree({ pid: group.rootPid, graceMs, sources, ops, report }));
    }

    return outcomes;
}
