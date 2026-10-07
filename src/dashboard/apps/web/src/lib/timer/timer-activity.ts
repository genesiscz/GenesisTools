import type { Timer } from "@/drizzle";

export interface TimerActivityEvent {
    type: string;
    payload?: unknown;
}

export interface TimerQueryDirtiness {
    activityDirty: boolean;
    focusStatsDirty: boolean;
    focusSessionsDirty: boolean;
}

export function timerQueryDirtiness(activityTypes: string[]): TimerQueryDirtiness {
    return {
        activityDirty: activityTypes.length > 0,
        // A work phase that completes while running adds tracked time through its phase-change row.
        focusStatsDirty: activityTypes.includes("pause") || activityTypes.includes("pomodoro_phase_change"),
        focusSessionsDirty: activityTypes.includes("pomodoro_phase_change"),
    };
}

export function activityLogValues(options: { current: Timer; updated: Timer; event: TimerActivityEvent }): {
    elapsedAtEvent: number;
    previousValue: number;
    newValue: number;
    metadata: Record<string, unknown>;
} {
    return {
        elapsedAtEvent: options.updated.elapsedTime ?? 0,
        previousValue: options.current.elapsedTime ?? 0,
        newValue: options.updated.elapsedTime ?? 0,
        metadata: (options.event.payload as Record<string, unknown> | undefined) ?? {},
    };
}

export interface FocusSessionBlock {
    timerId: string;
    startIso: string;
    endIso: string;
}

export interface PomodoroActivityRow {
    timerId: string;
    timestamp: string;
    /** Rows without an event type are phase-change rows (the pre-pause-aware shape). */
    eventType?: string;
    elapsedAtEvent: number;
    previousValue: number | null;
    newValue?: number | null;
    metadata: unknown;
}

function blockEndingAt(timerId: string, endIso: string, durationMs: number): FocusSessionBlock {
    return {
        timerId,
        startIso: new Date(new Date(endIso).getTime() - durationMs).toISOString(),
        endIso,
    };
}

/**
 * One block per continuous run of a completed work phase. A paused and resumed phase is several runs:
 * each pause row closes one run, and the phase-change row closes the last one. `durationMs` is the
 * whole phase, so the last run is `durationMs` minus what the pause rows already covered
 * (`previousValue`). Rows must be in timestamp order.
 */
export function focusSessionsFromPomodoroRows(rows: PomodoroActivityRow[]): FocusSessionBlock[] {
    const sessions: FocusSessionBlock[] = [];
    const runsInPhase = new Map<string, FocusSessionBlock[]>();

    for (const row of rows) {
        const eventType = row.eventType ?? "pomodoro_phase_change";

        if (eventType === "pause") {
            const runMs = (row.newValue ?? 0) - (row.previousValue ?? 0);

            if (row.newValue !== null && row.newValue !== undefined && row.previousValue !== null && runMs > 0) {
                const runs = runsInPhase.get(row.timerId) ?? [];
                runs.push(blockEndingAt(row.timerId, row.timestamp, runMs));
                runsInPhase.set(row.timerId, runs);
            }

            continue;
        }

        if (eventType !== "pomodoro_phase_change") {
            // A reset discards the phase's elapsed time, so its earlier runs no longer belong to it.
            runsInPhase.delete(row.timerId);
            continue;
        }

        const earlierRuns = runsInPhase.get(row.timerId) ?? [];
        runsInPhase.delete(row.timerId);
        const metadata = row.metadata as { fromPhase?: string; durationMs?: number } | null;

        if (metadata?.fromPhase !== "work") {
            continue;
        }

        sessions.push(...earlierRuns);
        const lastRunMs =
            typeof metadata.durationMs === "number" && Number.isFinite(metadata.durationMs)
                ? metadata.durationMs - (row.previousValue ?? 0)
                : row.elapsedAtEvent - (row.previousValue ?? 0);

        if (lastRunMs > 0) {
            sessions.push(blockEndingAt(row.timerId, row.timestamp, lastRunMs));
        }
    }

    return sessions;
}
