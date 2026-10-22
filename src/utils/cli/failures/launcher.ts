import { constants } from "node:os";
import { formatLocalDate } from "@genesiscz/utils/date";
import { logger } from "@genesiscz/utils/logger";
import { currentTraceId } from "@genesiscz/utils/trace";
import {
    appendFailure,
    type FailureCaller,
    type FailureKind,
    failuresDir,
    readFailures,
    type ToolFailure,
} from "./record";
import { agentCaller } from "./watch";

/**
 * A run the default SIGINT or SIGTERM action kills never reaches the tool's exit event, so watch.ts cannot record it.
 * The `tools` wrapper records it instead, when it spawned the tool and waited for it. When the wrapper exec'd into
 * the tool (the default, tool-exec.ts), no parent of ours is left to see the death, and such a run stays unrecorded.
 *
 * - `crash`: a signal a process raises on itself when it faults (a segfault, a Bun panic's abort or trap). The
 *   runtime died, which is a bug.
 * - `interrupt`: a signal sent from outside: Ctrl-C, a harness timeout's SIGTERM, a hangup, and also SIGKILL, which
 *   is most often that timeout's escalation, `kill -9` or the orphan watchdog, not a fault of the tool.
 * - Anything else (SIGPIPE from `tools x | head`, SIGUSR1) is a normal end, not a failure.
 */
const CRASH_SIGNALS: ReadonlySet<string> = new Set(["SIGSEGV", "SIGBUS", "SIGILL", "SIGFPE", "SIGABRT", "SIGTRAP"]);
const INTERRUPT_SIGNALS: ReadonlySet<string> = new Set(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGKILL"]);

/** The launcher has no command definition, so it cannot tell a secret argument from a plain one. */
export const WITHHELD_ARGV = ["[withheld]"];

const SIGNAL_NUMBERS: ReadonlyMap<string, number> = new Map(Object.entries(constants.signals));

export interface SignalEnd {
    kind: FailureKind;
    signal: string;
    /** The status the wrapper exits with: the launcher's own, or 128 + the signal number. */
    exitCode: number;
}

/** The signal an exit status of 128 + n names, on this platform's numbering. */
export function signalOfStatus(status: number): string | null {
    const number = status - 128;
    if (number <= 0) {
        return null;
    }

    return [...SIGNAL_NUMBERS].find(([, value]) => value === number)?.[0] ?? null;
}

/**
 * Whether a child's end is a signal death to record, and as what. `signal` is what Node reports for a child the
 * signal killed. `status` counts only when the child is the GenesisTools.app launcher (`viaLauncher`): it exits
 * 128 + n when its own child died of signal n. From a plain bun child, a status is the tool's own exit, which its
 * watcher already judged.
 */
export function signalEnd({
    signal,
    status,
    viaLauncher,
}: {
    signal: string | null;
    status: number | null;
    viaLauncher: boolean;
}): SignalEnd | null {
    const name = signal ?? (viaLauncher && status !== null ? signalOfStatus(status) : null);
    if (!name) {
        return null;
    }

    const kind: FailureKind | null = CRASH_SIGNALS.has(name)
        ? "crash"
        : INTERRUPT_SIGNALS.has(name)
          ? "interrupt"
          : null;
    if (!kind) {
        return null;
    }

    const exitCode = signal === null && status !== null ? status : 128 + (SIGNAL_NUMBERS.get(name) ?? 0);
    return { kind, signal: name, exitCode };
}

/**
 * Whether the tool itself already wrote a record for this run. It did when it handled the signal and exited 130 or
 * 143, which the launcher then reports exactly like a signal death. The wrapper hands each spawned tool a run id
 * (run-id.ts) and the watcher copies it into its record: a pid would not do, since the launcher sits between the
 * wrapper and the tool, and a plain "last record" check would race other tools writing the same day file.
 */
export function childRecorded({
    runId,
    since,
    now,
    dir,
}: {
    runId: string;
    since: Date;
    now: Date;
    dir: string;
}): boolean {
    for (const failure of readFailures({ fromDay: formatLocalDate(since), toDay: formatLocalDate(now), dir })) {
        if (failure.runId === runId) {
            return true;
        }
    }

    return false;
}

function callerOrNull(caller: () => FailureCaller | null): FailureCaller | null {
    try {
        return caller();
    } catch (error) {
        logger.debug({ error }, "failures: no caller context for a signal death");
        return null;
    }
}

/**
 * Records a spawned tool's signal death once: nothing when the end was no failure or the tool already recorded it.
 * Returns the written record, or null.
 */
export function recordSignalEnd({
    tool,
    runId,
    startedAt,
    signal,
    status,
    viaLauncher,
    childPid,
    toolsRoot,
    caller = agentCaller,
    now = new Date(),
    dir = failuresDir(),
}: {
    tool: string;
    runId: string;
    startedAt: Date;
    signal: string | null;
    status: number | null;
    viaLauncher: boolean;
    childPid: number;
    toolsRoot: string;
    caller?: () => FailureCaller | null;
    now?: Date;
    dir?: string;
}): ToolFailure | null {
    const end = signalEnd({ signal, status, viaLauncher });
    if (!end || childRecorded({ runId, since: startedAt, now, dir })) {
        return null;
    }

    const failure: ToolFailure = {
        v: 1,
        id: `${now.getTime().toString(36)}-${process.pid}`,
        at: now.toISOString(),
        kind: end.kind,
        tool,
        command: null,
        argv: WITHHELD_ARGV,
        exitCode: end.exitCode,
        message:
            signal === null
                ? `ended by ${end.signal} (exit ${end.exitCode} from the GenesisTools.app launcher)`
                : `ended by ${end.signal}`,
        errorName: null,
        stack: null,
        // stderr may echo an argument; without the command definition the launcher cannot mask it reliably.
        stderrTail: null,
        fatal: true,
        durationMs: now.getTime() - startedAt.getTime(),
        pid: childPid,
        ppid: process.pid,
        cwd: process.cwd(),
        traceId: currentTraceId() ?? null,
        toolsRoot,
        caller: callerOrNull(caller),
        runId,
    };
    appendFailure(failure, dir);
    return failure;
}
