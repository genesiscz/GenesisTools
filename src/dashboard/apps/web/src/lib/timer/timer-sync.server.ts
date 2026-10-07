/**
 * Timer Sync Server - Drizzle + better-sqlite3 (sync)
 *
 * All mutations are action-based (start/pause/reset/lap/...).
 * Client never sends elapsedTime — server computes from startTime + previousElapsed.
 * Optimistic concurrency via `version` column: UPDATE ... WHERE id=? AND version=?
 */

import type { PomodoroSettings, ProductivityStats } from "@dashboard/shared";
import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { type ActivityLog, activityLogs, db, type NewTimer, type Timer, timers } from "@/drizzle";
import { requireUserId } from "@/lib/auth/requireUser";
import {
    activityLogValues,
    type FocusSessionBlock,
    focusSessionsFromPomodoroRows,
    timerQueryDirtiness,
} from "./timer-activity";
import { emitTimerEvent } from "./timer-events.server";
import { applyAction } from "./timer-state-machine";

export type { FocusSessionBlock } from "./timer-activity";

// ============================================
// Conflict Error
// ============================================

class TimerConflict extends Error {
    constructor() {
        super("Timer changed in another tab; please retry");
    }
}

// ============================================
// Activity-log event mapping
// ============================================

type ActivityEventType = ActivityLog["eventType"];

// Internal state-machine event names → persisted activity_logs.event_type.
// Events not in this map (e.g. the internal "timer_changed" sync ping) are
// SSE-only and intentionally not written to the activity log.
const EVENT_TO_ACTIVITY: Record<string, ActivityEventType> = {
    started: "start",
    paused: "pause",
    reset: "reset",
    lapped: "lap",
    countdown_complete: "complete",
    phase_changed: "pomodoro_phase_change",
};

// ============================================
// Internal: atomic read-transform-write
// ============================================

interface MutateOptions {
    id: string;
    userId: string;
    expectedVersion?: number;
    transform: (current: Timer) => {
        next: Timer;
        events?: Array<{ type: string; payload?: unknown }>;
    };
}

function mutate({ id, userId, expectedVersion, transform }: MutateOptions): Timer {
    // Atomic: the version-checked update and its activity-log row commit
    // together or not at all. A crash between them used to leave the timer
    // advanced with no log row → permanent drift in focus/productivity stats.
    const { final, events, activityDirty, focusStatsDirty, focusSessionsDirty } = db.transaction((tx) => {
        const current = tx
            .select()
            .from(timers)
            .where(and(eq(timers.id, id), eq(timers.userId, userId)))
            .get();

        if (!current) {
            throw new Error("Timer not found");
        }

        if (expectedVersion !== undefined && current.version !== expectedVersion) {
            throw new TimerConflict();
        }

        const { next, events } = transform(current);
        const newVersion = current.version + 1;

        const result = tx
            .update(timers)
            .set({
                ...next,
                version: newVersion,
                updatedAt: new Date().toISOString(),
            })
            .where(and(eq(timers.id, id), eq(timers.version, current.version)))
            .run();

        if (result.changes === 0) {
            throw new TimerConflict();
        }

        const updated = tx.select().from(timers).where(eq(timers.id, id)).get();

        if (!updated) {
            throw new Error("Timer not found after update");
        }

        const loggable = (events ?? []).filter((ev) => ev.type in EVENT_TO_ACTIVITY);

        if (loggable.length > 0) {
            const nowIso = new Date().toISOString();
            tx.insert(activityLogs)
                .values(
                    loggable.map((ev) => ({
                        id: crypto.randomUUID(),
                        timerId: id,
                        timerName: updated.name,
                        userId,
                        eventType: EVENT_TO_ACTIVITY[ev.type],
                        timestamp: nowIso,
                        ...activityLogValues({ current, updated, event: ev }),
                    }))
                )
                .run();
        }

        const activityTypes = loggable.map((event) => EVENT_TO_ACTIVITY[event.type]);

        return {
            final: updated,
            events,
            ...timerQueryDirtiness(activityTypes),
        };
    });

    // Side effects after commit — never roll back on an emit failure.
    for (const ev of events ?? []) {
        emitTimerEvent(userId, { ...ev, timerId: id });
    }

    emitTimerEvent(userId, {
        type: "timer_changed",
        timerId: id,
        snapshot: final,
        activityDirty,
        focusStatsDirty,
        focusSessionsDirty,
    });
    return final;
}

// ============================================
// Fetch Operations
// ============================================

export const getTimersFromServer = createServerFn({
    method: "GET",
}).handler(async (): Promise<Timer[]> => {
    const userId = await requireUserId();

    try {
        const results: Timer[] = db
            .select()
            .from(timers)
            .where(eq(timers.userId, userId))
            .orderBy(desc(timers.createdAt))
            .all();

        return results;
    } catch (error) {
        console.error("[Server] getTimersFromServer error:", error);
        return [] as Timer[];
    }
});

// Narrow metadata to primitive-only values so TanStack's serialization
// type-checker (ValidateSerializableInput) is satisfied
type ParsedActivityLog = Omit<ActivityLog, "metadata"> & {
    metadata: Record<string, string | number | boolean | null> | null;
};

export const getActivityLogsFromServer = createServerFn({
    method: "GET",
}).handler(async (): Promise<ParsedActivityLog[]> => {
    const userId = await requireUserId();

    try {
        const rawResults = db
            .select()
            .from(activityLogs)
            .where(eq(activityLogs.userId, userId))
            .orderBy(desc(activityLogs.timestamp))
            .limit(1000)
            .all();

        return rawResults.map((log) => ({
            ...log,
            metadata: log.metadata as Record<string, string | number | boolean | null> | null,
        }));
    } catch (error) {
        console.error("[Server] getActivityLogsFromServer error:", error);
        return [];
    }
});

// ============================================
// Create / Delete
// ============================================

export const createTimerOnServer = createServerFn({
    method: "POST",
})
    .inputValidator((d: { name: string; timerType: "stopwatch" | "countdown" | "pomodoro"; duration?: number }) => d)
    .handler(async ({ data }): Promise<Timer> => {
        const userId = await requireUserId();
        const now = new Date().toISOString();
        const newTimer: NewTimer = {
            id: crypto.randomUUID(),
            userId,
            name: data.name,
            timerType: data.timerType,
            isRunning: 0,
            elapsedTime: 0,
            duration: data.duration ?? null,
            laps: [],
            createdAt: now,
            updatedAt: now,
            showTotal: 0,
            firstStartTime: null,
            startTime: null,
            pomodoroSettings: null,
            pomodoroPhase: null,
            pomodoroSessionCount: 0,
            version: 1,
        };

        db.insert(timers).values(newTimer).run();
        const created = db.select().from(timers).where(eq(timers.id, newTimer.id)).get()!;
        return created;
    });

export const deleteTimerFromServer = createServerFn({
    method: "POST",
})
    .inputValidator((d: { timerId: string }) => d)
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        const userId = await requireUserId();

        try {
            db.delete(timers)
                .where(and(eq(timers.id, data.timerId), eq(timers.userId, userId)))
                .run();
            return { success: true };
        } catch (error) {
            console.error("[Server] deleteTimerFromServer error:", error);
            return { success: false };
        }
    });

// ============================================
// Action Mutations (state-machine based)
// ============================================

export const startTimer = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string; expectedVersion?: number }) => d)
    .handler(async ({ data }) => {
        const userId = await requireUserId();

        return mutate({
            id: data.id,
            userId,
            expectedVersion: data.expectedVersion,
            transform: (current) => {
                const r = applyAction(current, { type: "start", nowMs: Date.now() });
                return { next: r.next, events: [{ type: "started" }] };
            },
        });
    });

export const pauseTimer = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string; expectedVersion?: number }) => d)
    .handler(async ({ data }) => {
        const userId = await requireUserId();

        return mutate({
            id: data.id,
            userId,
            expectedVersion: data.expectedVersion,
            transform: (current) => {
                const r = applyAction(current, { type: "pause", nowMs: Date.now() });
                const events: Array<{ type: string }> = [{ type: "paused" }];

                if (r.countdownComplete) {
                    events.push({ type: "countdown_complete" });
                }

                return { next: r.next, events };
            },
        });
    });

export const resetTimer = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string; expectedVersion?: number }) => d)
    .handler(async ({ data }) => {
        const userId = await requireUserId();

        return mutate({
            id: data.id,
            userId,
            expectedVersion: data.expectedVersion,
            transform: (current) => ({
                next: applyAction(current, { type: "reset" }).next,
                events: [{ type: "reset" }],
            }),
        });
    });

export const lapTimer = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string; expectedVersion?: number }) => d)
    .handler(async ({ data }) => {
        const userId = await requireUserId();

        return mutate({
            id: data.id,
            userId,
            expectedVersion: data.expectedVersion,
            transform: (current) => ({
                next: applyAction(current, { type: "lap", nowMs: Date.now() }).next,
                events: [{ type: "lapped" }],
            }),
        });
    });

export const advancePomodoroPhase = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string; expectedVersion?: number }) => d)
    .handler(async ({ data }) => {
        const userId = await requireUserId();

        return mutate({
            id: data.id,
            userId,
            expectedVersion: data.expectedVersion,
            transform: (current) => {
                const r = applyAction(current, { type: "advance_pomodoro_phase", nowMs: Date.now() });
                return {
                    next: r.next,
                    events: r.phaseTransition ? [{ type: "phase_changed", payload: r.phaseTransition }] : [],
                };
            },
        });
    });

export const setPomodoroSettings = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string; expectedVersion?: number; settings: PomodoroSettings }) => d)
    .handler(async ({ data }) => {
        const userId = await requireUserId();

        return mutate({
            id: data.id,
            userId,
            expectedVersion: data.expectedVersion,
            transform: (current) => ({
                next: applyAction(current, {
                    type: "set_pomodoro_settings",
                    settings: data.settings,
                }).next,
            }),
        });
    });

export const updateTimerMetadata = createServerFn({ method: "POST" })
    .inputValidator(
        (d: {
            id: string;
            expectedVersion?: number;
            patch: Partial<Pick<Timer, "name" | "showTotal" | "duration" | "elapsedTime" | "timerType">>;
        }) => d
    )
    .handler(async ({ data }) => {
        const userId = await requireUserId();

        return mutate({
            id: data.id,
            userId,
            expectedVersion: data.expectedVersion,
            transform: (current) => ({
                next: applyAction(current, { type: "update_metadata", patch: data.patch }).next,
            }),
        });
    });

// ============================================
// Activity log helper (used by useActivityLog)
// ============================================

export const getActivityLogsForTimer = createServerFn({
    method: "GET",
})
    .inputValidator((d: { timerId?: string }) => d)
    .handler(async ({ data }): Promise<ParsedActivityLog[]> => {
        const userId = await requireUserId();

        try {
            const query = db
                .select()
                .from(activityLogs)
                .where(
                    data.timerId
                        ? and(eq(activityLogs.userId, userId), eq(activityLogs.timerId, data.timerId))
                        : eq(activityLogs.userId, userId)
                )
                .orderBy(desc(activityLogs.timestamp))
                .limit(500)
                .all();

            return query.map((log) => ({
                ...log,
                metadata: log.metadata as Record<string, string | number | boolean | null> | null,
            }));
        } catch (error) {
            console.error("[Server] getActivityLogsForTimer error:", error);
            return [];
        }
    });

export const clearActivityLogs = createServerFn({ method: "POST" }).handler(
    async (): Promise<{ success: boolean; deleted: number }> => {
        const userId = await requireUserId();

        try {
            const result = db.delete(activityLogs).where(eq(activityLogs.userId, userId)).run();
            console.log("[Server] cleared", result.changes, "activity logs for user:", userId);
            return { success: true, deleted: result.changes };
        } catch (error) {
            console.error("[Server] clearActivityLogs error:", error);
            return { success: false, deleted: 0 };
        }
    }
);

// ============================================
// Productivity Stats Aggregation
// ============================================

const validPauseDuration = sql`${activityLogs.eventType} = 'pause'
    AND ${activityLogs.newValue} IS NOT NULL
    AND ${activityLogs.previousValue} IS NOT NULL
    AND ${activityLogs.newValue} > ${activityLogs.previousValue}`;
const pauseDuration = sql`${activityLogs.newValue} - ${activityLogs.previousValue}`;
// A work phase that ends while running: its last run has no pause row. The phase-change row stores the
// whole phase (`durationMs`) and the part earlier pause rows already counted (`previousValue`), so only
// the remainder is new tracked time.
const completedWorkDurationMs = sql`json_extract(${activityLogs.metadata}, '$.durationMs')`;
const validCompletedWorkTail = sql`${activityLogs.eventType} = 'pomodoro_phase_change'
    AND json_extract(${activityLogs.metadata}, '$.fromPhase') = 'work'
    AND ${activityLogs.previousValue} IS NOT NULL
    AND json_type(${activityLogs.metadata}, '$.durationMs') IN ('integer', 'real')
    AND ${completedWorkDurationMs} > ${activityLogs.previousValue}`;
const completedWorkTail = sql`${completedWorkDurationMs} - ${activityLogs.previousValue}`;
const isTrackedInterval = sql`((${validPauseDuration}) OR (${validCompletedWorkTail}))`;
const trackedDuration = sql`case when ${validPauseDuration} then ${pauseDuration}
    when ${validCompletedWorkTail} then ${completedWorkTail} else 0 end`;

export function queryProductivityStatsForUser(options: {
    userId: string;
    startIso: string;
    endIso: string;
}): ProductivityStats {
    const range = and(
        eq(activityLogs.userId, options.userId),
        gte(activityLogs.timestamp, options.startIso),
        lt(activityLogs.timestamp, options.endIso)
    );
    const summary = db
        .select({
            totalTimeTracked: sql<number>`coalesce(sum(${trackedDuration}), 0)`,
            sessionCount: sql<number>`coalesce(sum(case when ${isTrackedInterval} then 1 else 0 end), 0)`,
            longestSession: sql<number>`coalesce(max(${trackedDuration}), 0)`,
            pomodoroCompleted: sql<number>`coalesce(sum(case when ${activityLogs.eventType} = 'pomodoro_phase_change'
                and json_extract(${activityLogs.metadata}, '$.fromPhase') = 'work' then 1 else 0 end), 0)`,
        })
        .from(activityLogs)
        .where(range)
        .get();
    const timerRows = db
        .select({
            timerId: activityLogs.timerId,
            duration: sql<number>`sum(${trackedDuration})`,
        })
        .from(activityLogs)
        .where(and(range, isTrackedInterval))
        .groupBy(activityLogs.timerId)
        .all();
    const dayExpression = sql<string>`substr(${activityLogs.timestamp}, 1, 10)`;
    const dayRows = db
        .select({
            day: dayExpression,
            duration: sql<number>`sum(${trackedDuration})`,
        })
        .from(activityLogs)
        .where(and(range, isTrackedInterval))
        .groupBy(dayExpression)
        .all();
    const totalTimeTracked = summary?.totalTimeTracked ?? 0;
    const sessionCount = summary?.sessionCount ?? 0;

    return {
        totalTimeTracked,
        sessionCount,
        averageSessionDuration: sessionCount > 0 ? totalTimeTracked / sessionCount : 0,
        longestSession: summary?.longestSession ?? 0,
        timerBreakdown: Object.fromEntries(timerRows.map((row) => [row.timerId, row.duration])),
        dailyBreakdown: Object.fromEntries(dayRows.map((row) => [row.day, row.duration])),
        pomodoroCompleted: summary?.pomodoroCompleted ?? 0,
    };
}

export const getProductivityStats = createServerFn({ method: "GET" })
    .inputValidator((d: { startIso: string; endIso: string }) => d)
    .handler(async ({ data }): Promise<ProductivityStats> => {
        const userId = await requireUserId();

        return queryProductivityStatsForUser({ userId, startIso: data.startIso, endIso: data.endIso });
    });

export interface FocusStatsForToday {
    timeFocusedTodayMs: number;
    sessionsToday: number;
}

export function queryFocusStatsForUser(options: {
    userId: string;
    startIso: string;
    endIso: string;
}): FocusStatsForToday {
    const summary = db
        .select({
            timeFocusedTodayMs: sql<number>`coalesce(sum(${trackedDuration}), 0)`,
            sessionsToday: sql<number>`count(*)`,
        })
        .from(activityLogs)
        .where(
            and(
                eq(activityLogs.userId, options.userId),
                gte(activityLogs.timestamp, options.startIso),
                lt(activityLogs.timestamp, options.endIso),
                isTrackedInterval
            )
        )
        .get();

    return {
        timeFocusedTodayMs: summary?.timeFocusedTodayMs ?? 0,
        sessionsToday: summary?.sessionsToday ?? 0,
    };
}

export const aggregateFocusStats = createServerFn({ method: "GET" }).handler(async (): Promise<FocusStatsForToday> => {
    const userId = await requireUserId();

    // UTC start of today and start of tomorrow for lexicographic ISO comparison
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setUTCHours(0, 0, 0, 0);
    const startOfTomorrow = new Date(startOfToday);
    startOfTomorrow.setUTCDate(startOfTomorrow.getUTCDate() + 1);

    return queryFocusStatsForUser({
        userId,
        startIso: startOfToday.toISOString(),
        endIso: startOfTomorrow.toISOString(),
    });
});

export const aggregateFocusSessions = createServerFn({ method: "GET" }).handler(
    async (): Promise<FocusSessionBlock[]> => {
        const userId = await requireUserId();

        const now = new Date();
        const startOfToday = new Date(now);
        startOfToday.setUTCHours(0, 0, 0, 0);
        const startOfTomorrow = new Date(startOfToday);
        startOfTomorrow.setUTCDate(startOfTomorrow.getUTCDate() + 1);

        const rows = db
            .select({
                timerId: activityLogs.timerId,
                timestamp: activityLogs.timestamp,
                eventType: activityLogs.eventType,
                elapsedAtEvent: activityLogs.elapsedAtEvent,
                previousValue: activityLogs.previousValue,
                newValue: activityLogs.newValue,
                metadata: activityLogs.metadata,
            })
            .from(activityLogs)
            .where(
                and(
                    eq(activityLogs.userId, userId),
                    inArray(activityLogs.eventType, ["pause", "reset", "pomodoro_phase_change"]),
                    gte(activityLogs.timestamp, startOfToday.toISOString()),
                    lt(activityLogs.timestamp, startOfTomorrow.toISOString())
                )
            )
            .orderBy(asc(activityLogs.timestamp))
            .all();

        return focusSessionsFromPomodoroRows(rows);
    }
);
