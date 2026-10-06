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
        focusStatsDirty: activityTypes.includes("pause"),
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
    elapsedAtEvent: number;
    previousValue: number | null;
    metadata: unknown;
}

export function focusSessionsFromPomodoroRows(rows: PomodoroActivityRow[]): FocusSessionBlock[] {
    const sessions: FocusSessionBlock[] = [];

    for (const row of rows) {
        const metadata = row.metadata as { fromPhase?: string; durationMs?: number } | null;

        if (metadata?.fromPhase !== "work") {
            continue;
        }

        const legacyDurationMs = row.elapsedAtEvent - (row.previousValue ?? 0);
        const workDurationMs =
            typeof metadata.durationMs === "number" && Number.isFinite(metadata.durationMs)
                ? metadata.durationMs
                : legacyDurationMs;

        if (workDurationMs <= 0) {
            continue;
        }

        const endMs = new Date(row.timestamp).getTime();
        sessions.push({
            timerId: row.timerId,
            startIso: new Date(endMs - workDurationMs).toISOString(),
            endIso: row.timestamp,
        });
    }

    return sessions;
}
