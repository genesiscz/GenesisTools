import type { PidExpectation } from "@genesiscz/utils/process/pidfile";
import { classifyPid, type PidIdentity } from "@genesiscz/utils/process-identity";

/**
 * Signals for pids a benchmark resolved from `ps`, sent only after re-proving identity.
 *
 * A measurement script holds pids it did not spawn (the TUI behind a pty wrapper, the
 * descendants of a server) across a whole window, and the spawn-storm arm exists BECAUSE the
 * program under test churns hundreds of pids a minute. A liveness probe after that window
 * answers for whoever holds the number now. Two markers in the CPU campaign said "re-checked"
 * over exactly such a probe: spawn-storm's `stopChild` waited on `ps` listing the pid at all,
 * and idle-cost's SIGKILL pass reused a descendant list that was ten seconds old.
 *
 * `expected` is the command line read when the pid was listed, or a predicate on it. The pid
 * is signalled only while `classifyPid` says "live" against it, so a number the kernel reissued
 * in between is skipped and reported, never signalled.
 */

export interface SignalOutcome {
    /** Whether the signal was sent. */
    sent: boolean;
    /** The verdict the decision was made on; `foreign` is the recycled shape. */
    identity: PidIdentity;
    /** Set when `process.kill` itself threw: the pid exited between the read and the signal. */
    error?: unknown;
}

export function signalVerified(pid: number, expected: PidExpectation, signal: NodeJS.Signals): SignalOutcome {
    const identity = classifyPid(pid, expected);

    if (identity.status !== "live") {
        return { sent: false, identity };
    }

    try {
        // pid-verified: classifyPid matched the live command line against `expected` just above
        process.kill(pid, signal);

        return { sent: true, identity };
    } catch (error) {
        return { sent: false, identity, error };
    }
}

/**
 * True while the pid still runs the expected program. A wait that polls this instead of
 * liveness ends when the process is gone OR when the number was reissued, and both mean the
 * process the caller wanted gone is gone.
 */
export function stillRuns(pid: number, expected: PidExpectation): boolean {
    return classifyPid(pid, expected).status === "live";
}
