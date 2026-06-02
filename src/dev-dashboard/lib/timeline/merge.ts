import type { RunSummary } from "@app/daemon/lib/types";
import type {
    QaTimelineEvent,
    RunTimelineEvent,
    TerminalTimelineEvent,
    TimelineEvent,
} from "@app/dev-dashboard/lib/timeline/types";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";
import type { QaEntry } from "@app/question/lib/types";

/**
 * The merge reads only the base Q&A fields (`id`/`ts`/`tag`/`question`/`project`), so it accepts the
 * shared `QaEntry` base. Both `queryEntries`' raw `QaRow` and the enriched `qa-types` `QaRow` extend
 * it, which keeps this pure lib decoupled from either route-specific row flavor.
 */
export type TimelineQaEntry = Pick<QaEntry, "id" | "ts" | "tag" | "question" | "project">;

export interface MergeTimelineInput {
    runs: RunSummary[];
    qaEntries: TimelineQaEntry[];
    ttydSessions: TtydSession[];
    /** Epoch ms lower bound (inclusive). Events with ts < since are dropped. */
    since: number;
}

/** ISO string → epoch ms, or NaN when unparseable. */
function isoToMs(iso: string): number {
    return Date.parse(iso);
}

function runToEvent(run: RunSummary): RunTimelineEvent | null {
    const ts = isoToMs(run.startedAt);
    if (!Number.isFinite(ts)) {
        return null;
    }

    const outcome = run.exitCode === null ? "running" : run.exitCode === 0 ? "exit 0" : `exit ${run.exitCode}`;
    return {
        id: `run-${run.runId}`,
        type: "run",
        ts,
        title: run.taskName,
        subtitle: outcome,
        runId: run.runId,
        exitCode: run.exitCode,
        durationMs: run.duration_ms,
    };
}

function qaToEvent(row: TimelineQaEntry): QaTimelineEvent | null {
    if (!Number.isFinite(row.ts)) {
        return null;
    }

    return {
        id: `qa-${row.id}`,
        type: "qa",
        ts: row.ts,
        title: row.question,
        subtitle: row.project,
        tag: row.tag,
        project: row.project,
    };
}

function ttydToEvent(session: TtydSession): TerminalTimelineEvent | null {
    const ts = isoToMs(session.startedAt);
    if (!Number.isFinite(ts)) {
        return null;
    }

    return {
        id: `terminal-${session.id}`,
        type: "terminal",
        ts,
        title: session.name ?? session.lastCommand ?? session.command,
        subtitle: session.cwd,
        command: session.command,
        cwd: session.cwd,
    };
}

/**
 * Pure cross-source merge: maps daemon runs, agent Q&A, and ttyd terminal launches into one typed
 * stream, drops anything before `since` (and anything with an unparseable timestamp), and sorts
 * DESCENDING by `ts`. No I/O — the route fetches the three sources and hands them in, which keeps
 * this fully unit-testable with fixtures.
 */
export function mergeTimeline(input: MergeTimelineInput): TimelineEvent[] {
    const { runs, qaEntries, ttydSessions, since } = input;

    const events: TimelineEvent[] = [
        ...runs.map(runToEvent),
        ...qaEntries.map(qaToEvent),
        ...ttydSessions.map(ttydToEvent),
    ].filter((event): event is TimelineEvent => event !== null && event.ts >= since);

    events.sort((a, b) => b.ts - a.ts);
    return events;
}
