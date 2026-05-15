/**
 * Timer Sync Server - Drizzle + better-sqlite3 (sync)
 *
 * All mutations are action-based (start/pause/reset/lap/...).
 * Client never sends elapsedTime — server computes from startTime + previousElapsed.
 * Optimistic concurrency via `version` column: UPDATE ... WHERE id=? AND version=?
 */

import type { PomodoroSettings } from "@dashboard/shared";
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { type ActivityLog, activityLogs, db, type NewTimer, type Timer, timers } from "@/drizzle";
import { emitTimerEvent } from "./timer-events.server";
import { applyAction } from "./timer-state-machine";

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
    const current = db
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

    const result = db
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

    const final = db.select().from(timers).where(eq(timers.id, id)).get();

    if (!final) {
        throw new Error("Timer not found after update");
    }

    // Persist meaningful events to the activity log (timeline + stats). This
    // is the single write site for every action-based mutation — secondary to
    // the timer write, so a failure here must not fail the mutation.
    const loggable = (events ?? []).filter((ev) => ev.type in EVENT_TO_ACTIVITY);

    if (loggable.length > 0) {
        try {
            const nowIso = new Date().toISOString();
            db.insert(activityLogs)
                .values(
                    loggable.map((ev) => ({
                        id: crypto.randomUUID(),
                        timerId: id,
                        timerName: final.name,
                        userId,
                        eventType: EVENT_TO_ACTIVITY[ev.type],
                        timestamp: nowIso,
                        elapsedAtEvent: final.elapsedTime ?? 0,
                        previousValue: current.elapsedTime ?? 0,
                        newValue: final.elapsedTime ?? 0,
                        metadata: (ev.payload as Record<string, unknown> | undefined) ?? {},
                    }))
                )
                .run();
        } catch (err) {
            console.error("[Server] failed to persist activity log for timer", id, err);
        }
    }

    for (const ev of events ?? []) {
        emitTimerEvent(userId, { ...ev, timerId: id });
    }

    emitTimerEvent(userId, { type: "timer_changed", timerId: id, snapshot: final });
    return final;
}

// ============================================
// Fetch Operations
// ============================================

export const getTimersFromServer = createServerFn({
    method: "GET",
})
    .inputValidator((d: string) => d) // userId
    .handler(({ data: userId }) => {
        try {
            console.log("[Server] getTimersFromServer called for user:", userId);

            const results: Timer[] = db
                .select()
                .from(timers)
                .where(eq(timers.userId, userId))
                .orderBy(desc(timers.createdAt))
                .all();

            console.log("[Server] Returning", results.length, "timers");
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
})
    .inputValidator((d: string) => d) // userId
    .handler(({ data: userId }): ParsedActivityLog[] => {
        try {
            console.log("[Server] getActivityLogsFromServer called for user:", userId);

            const rawResults = db
                .select()
                .from(activityLogs)
                .where(eq(activityLogs.userId, userId))
                .orderBy(desc(activityLogs.timestamp))
                .limit(1000)
                .all();

            console.log("[Server] Returning", rawResults.length, "activity logs");

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
    .inputValidator(
        (d: { userId: string; name: string; timerType: "stopwatch" | "countdown" | "pomodoro"; duration?: number }) => d
    )
    .handler(({ data }): Timer => {
        const now = new Date().toISOString();
        const newTimer: NewTimer = {
            id: crypto.randomUUID(),
            userId: data.userId,
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
    .inputValidator((d: { timerId: string; userId: string }) => d)
    .handler(({ data }): { success: boolean } => {
        try {
            db.delete(timers).where(eq(timers.id, data.timerId)).run();
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
    .inputValidator((d: { id: string; userId: string; expectedVersion?: number }) => d)
    .handler(({ data }) =>
        mutate({
            id: data.id,
            userId: data.userId,
            expectedVersion: data.expectedVersion,
            transform: (current) => {
                const r = applyAction(current, { type: "start", nowMs: Date.now() });
                return { next: r.next, events: [{ type: "started" }] };
            },
        })
    );

export const pauseTimer = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string; userId: string; expectedVersion?: number }) => d)
    .handler(({ data }) =>
        mutate({
            id: data.id,
            userId: data.userId,
            expectedVersion: data.expectedVersion,
            transform: (current) => {
                const r = applyAction(current, { type: "pause", nowMs: Date.now() });
                const events: Array<{ type: string }> = [{ type: "paused" }];

                if (r.countdownComplete) {
                    events.push({ type: "countdown_complete" });
                }

                return { next: r.next, events };
            },
        })
    );

export const resetTimer = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string; userId: string; expectedVersion?: number }) => d)
    .handler(({ data }) =>
        mutate({
            id: data.id,
            userId: data.userId,
            expectedVersion: data.expectedVersion,
            transform: (current) => ({
                next: applyAction(current, { type: "reset" }).next,
                events: [{ type: "reset" }],
            }),
        })
    );

export const lapTimer = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string; userId: string; expectedVersion?: number }) => d)
    .handler(({ data }) =>
        mutate({
            id: data.id,
            userId: data.userId,
            expectedVersion: data.expectedVersion,
            transform: (current) => ({
                next: applyAction(current, { type: "lap", nowMs: Date.now() }).next,
                events: [{ type: "lapped" }],
            }),
        })
    );

export const advancePomodoroPhase = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string; userId: string; expectedVersion?: number }) => d)
    .handler(({ data }) =>
        mutate({
            id: data.id,
            userId: data.userId,
            expectedVersion: data.expectedVersion,
            transform: (current) => {
                const r = applyAction(current, { type: "advance_pomodoro_phase" });
                return {
                    next: r.next,
                    events: r.phaseTransition ? [{ type: "phase_changed", payload: r.phaseTransition }] : [],
                };
            },
        })
    );

export const setPomodoroSettings = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string; userId: string; expectedVersion?: number; settings: PomodoroSettings }) => d)
    .handler(({ data }) =>
        mutate({
            id: data.id,
            userId: data.userId,
            expectedVersion: data.expectedVersion,
            transform: (current) => ({
                next: applyAction(current, {
                    type: "set_pomodoro_settings",
                    settings: data.settings,
                }).next,
            }),
        })
    );

export const updateTimerMetadata = createServerFn({ method: "POST" })
    .inputValidator(
        (d: {
            id: string;
            userId: string;
            expectedVersion?: number;
            patch: Partial<Pick<Timer, "name" | "showTotal" | "duration" | "elapsedTime" | "timerType">>;
        }) => d
    )
    .handler(({ data }) =>
        mutate({
            id: data.id,
            userId: data.userId,
            expectedVersion: data.expectedVersion,
            transform: (current) => ({
                next: applyAction(current, { type: "update_metadata", patch: data.patch }).next,
            }),
        })
    );

// ============================================
// Activity log helper (used by useActivityLog)
// ============================================

export const getActivityLogsForTimer = createServerFn({
    method: "GET",
})
    .inputValidator((d: { userId: string; timerId?: string }) => d)
    .handler(({ data }): ParsedActivityLog[] => {
        try {
            const query = db
                .select()
                .from(activityLogs)
                .where(
                    data.timerId
                        ? and(eq(activityLogs.userId, data.userId), eq(activityLogs.timerId, data.timerId))
                        : eq(activityLogs.userId, data.userId)
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

export const clearActivityLogs = createServerFn({ method: "POST" })
    .inputValidator((d: { userId: string }) => d)
    .handler(({ data }): { success: boolean; deleted: number } => {
        try {
            const result = db.delete(activityLogs).where(eq(activityLogs.userId, data.userId)).run();
            console.log("[Server] cleared", result.changes, "activity logs for user:", data.userId);
            return { success: true, deleted: result.changes };
        } catch (error) {
            console.error("[Server] clearActivityLogs error:", error);
            return { success: false, deleted: 0 };
        }
    });
