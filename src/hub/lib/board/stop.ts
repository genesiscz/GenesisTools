import { titleMatchKeys } from "@app/cmux/lib/title-match";
import type { AgentStopReceiptDto } from "@app/dev-dashboard/contract/agents";
import { type FleetEntry, readFleetView } from "@genesiscz/utils/ai/live-sessions/fleet";
import { logger } from "@genesiscz/utils/logger";
import { type ProcsSources, realProcsSources } from "../procs/sources";
import { DEFAULT_GRACE_MS, realSignalOps, type SignalOps, stopTree } from "../procs/stop";
import { boardKey } from "./phases";

const log = logger.child({ component: "hub/board/stop" });

export interface BoardStopDeps {
    /** The live sessions now (no stuck verdict: the stop only needs who holds which pid). */
    fleet(): Promise<FleetEntry[]>;
    sources: ProcsSources;
    ops: SignalOps;
    graceMs: number;
}

export const realBoardStopDeps: BoardStopDeps = {
    fleet: () => readFleetView({ titleKeys: titleMatchKeys }),
    sources: realProcsSources,
    ops: realSignalOps,
    graceMs: DEFAULT_GRACE_MS,
};

function refused(key: string, pid: number, reason: string): AgentStopReceiptDto {
    log.info({ key, pid, reason }, "board stop refused");
    return { key, pid, stopped: false, signal: null, survivors: [], reason };
}

/**
 * Ends one live session's process tree (F19 stop). The caller names the session by its board key and the pid the
 * board showed. The session is located again first, so a session that ended, or whose agent process is now another
 * pid, is refused rather than stopped; then `stopTree` sends SIGTERM to the tree, SIGKILL after the grace period, and
 * re-checks every pid's start time and command before each signal (and refuses the caller's own process tree).
 */
export async function stopAgentSession(
    input: { key: string; pid: number },
    deps: BoardStopDeps = realBoardStopDeps
): Promise<AgentStopReceiptDto> {
    const { key, pid } = input;

    if (!Number.isInteger(pid) || pid <= 1) {
        return refused(key, pid, `${pid} is not a pid that can be stopped`);
    }

    const entry = (await deps.fleet()).find((candidate) => boardKey(candidate) === key);

    if (!entry) {
        return refused(key, pid, "the session is no longer live");
    }

    const now = entry.process?.pid ?? null;

    if (now !== pid) {
        return refused(
            key,
            pid,
            now === null
                ? "the session has no agent process to stop"
                : `the session's agent process is now ${now}, not ${pid}; refresh and try again`
        );
    }

    const outcome = await stopTree({ pid, graceMs: deps.graceMs, sources: deps.sources, ops: deps.ops });
    log.info({ key, pid, stopped: outcome.stopped, signal: outcome.signal }, "board stop done");
    return {
        key,
        pid,
        stopped: outcome.stopped,
        signal: outcome.signal,
        survivors: outcome.survivors,
        reason: outcome.reason,
    };
}
