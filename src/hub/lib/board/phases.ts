import type { AgentBoardPhaseRow } from "@app/dev-dashboard/contract/agents";
import type { FleetEntry } from "@genesiscz/utils/ai/live-sessions/fleet";

// The pure half of the board: keys, the channel row and the diff between two reads. No reader import, so the live
// producer loads it without the fleet view.

/** A session's board key: its id when the locator knows one, else its agent process. */
export function boardKey(entry: Pick<FleetEntry, "provider" | "sessionId" | "process" | "surface">): string {
    if (entry.sessionId) {
        return `${entry.provider}:${entry.sessionId}`;
    }

    if (entry.process) {
        return `${entry.provider}:pid:${entry.process.pid}`;
    }

    return `${entry.provider}:surface:${entry.surface?.surface.id ?? entry.surface?.surface.ref ?? "unknown"}`;
}

/** What the `agents` live channel carries for one session. */
export function phaseRowOf(entry: FleetEntry): AgentBoardPhaseRow {
    return {
        key: boardKey(entry),
        provider: entry.provider,
        sessionId: entry.sessionId,
        phase: entry.phase,
        label: entry.label,
        stalled: entry.stalled,
        stuck: entry.stuck,
        pid: entry.process?.pid ?? null,
        lastActivityAt: entry.lastActivityAt,
    };
}

/** What moved between two phase reads: the rows that changed, and whether a session started or ended. */
export function diffPhases(
    before: readonly AgentBoardPhaseRow[],
    after: readonly AgentBoardPhaseRow[]
): { membershipChanged: boolean; changed: AgentBoardPhaseRow[] } {
    const old = new Map(before.map((row) => [row.key, row]));
    const membershipChanged = before.length !== after.length || after.some((row) => !old.has(row.key));
    const changed = after.filter((row) => {
        const was = old.get(row.key);
        return (
            was !== undefined &&
            (was.label !== row.label ||
                was.phase !== row.phase ||
                was.stalled !== row.stalled ||
                was.pid !== row.pid ||
                was.stuck?.kind !== row.stuck?.kind)
        );
    });
    return { membershipChanged, changed };
}
