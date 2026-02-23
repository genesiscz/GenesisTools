/**
 * Timer Sync Server - Drizzle + Generic Events
 *
 * Migrated from raw SQL to Drizzle ORM with:
 * - Full type safety
 * - Automatic type inference
 * - Generic event broadcasting for real-time updates
 * - No manual type conversions needed
 */

import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { type ActivityLog, activityLogs, db, type Timer, timers } from "@/drizzle";
import { broadcastToUser } from "@/lib/events/server";

// ============================================
// Types (now inferred from Drizzle schema!)
// ============================================

// CRUD operation types for PowerSync sync
interface CrudOperation {
    id: string;
    op: "PUT" | "PATCH" | "DELETE";
    table: string;
    data: Record<string, unknown>;
}

interface UploadBatchInput {
    operations: CrudOperation[];
}

// ============================================
// CRUD Batch Upload (PowerSync Sync)
// ============================================

/**
 * Upload CRUD batch from PowerSync to server database
 *
 * Now uses:
 * - Drizzle ORM for type-safe queries
 * - Generic event broadcaster for real-time updates
 *
 * @example
 * ```ts
 * await uploadSyncBatch({
 *   operations: [
 *     { id: '123', op: 'PUT', table: 'timers', data: {...} },
 *     { id: '456', op: 'DELETE', table: 'timers', data: { id: '456' } }
 *   ]
 * })
 * ```
 */
export const uploadSyncBatch = createServerFn({
    method: "POST",
})
    .inputValidator((d: UploadBatchInput) => d)
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        const { operations } = data;

        if (!operations || operations.length === 0) {
            return { success: true };
        }

        console.log(`[Sync] Processing ${operations.length} operations...`);

        const affectedUserIds = new Set<string>();

        // Process each operation
        for (const op of operations) {
            if (!op.id || !op.data) {
                console.warn("[Sync] Skipping operation with missing id/data:", op);
                continue;
            }

            // Track affected users for event broadcasting
            if (op.data.user_id) {
                affectedUserIds.add(op.data.user_id as string);
            }

            // Process based on table
            try {
                if (op.table === "timers") {
                    console.log("[Sync] Processing timer operation:", op.op, op.id);
                    await processTimerOperation(op);
                } else if (op.table === "activity_logs") {
                    console.log("[Sync] Processing activity log operation:", op.op, op.id);
                    await processActivityLogOperation(op);
                }
            } catch (error) {
                console.error(`[Sync] Failed to process ${op.table} operation ${op.op}:`, error);
                console.error("[Sync] Operation data:", JSON.stringify(op, null, 2));
                // Continue processing other operations
            }
        }

        // Broadcast events to affected users
        for (const userId of affectedUserIds) {
            broadcastToUser("timer", userId, {
                type: "sync",
                timestamp: Date.now(),
            });
            console.log(`[Sync] Broadcasted event to user: ${userId}`);
        }

        console.log(`[Sync] Completed ${operations.length} operations`);
        return { success: true };
    });

/**
 * Process timer CRUD operation with Drizzle
 */
async function processTimerOperation(op: CrudOperation) {
    const data = op.data;

    switch (op.op) {
        case "PUT":
            // Upsert timer (insert or replace)
            console.log("[Sync] PUT operation data:", JSON.stringify(data, null, 2));
            await db
                .insert(timers)
                .values({
                    id: op.id,
                    name: data.name as string,
                    timerType: data.timer_type as "stopwatch" | "countdown" | "pomodoro",
                    isRunning: (data.is_running as number) ?? 0,
                    elapsedTime: (data.elapsed_time as number) ?? 0,
                    duration: (data.duration as number | null) ?? null,
                    laps:
                        (data.laps as Array<{
                            number: number;
                            lapTime: number;
                            splitTime: number;
                            timestamp: string;
                        }>) ?? [],
                    userId: data.user_id as string,
                    createdAt: data.created_at as string,
                    updatedAt: data.updated_at as string,
                    showTotal: (data.show_total as number) ?? 0,
                    firstStartTime: (data.first_start_time as string | null) ?? null,
                    startTime: (data.start_time as string | null) ?? null,
                    pomodoroSettings:
                        (data.pomodoro_settings as {
                            workDuration: number;
                            shortBreakDuration: number;
                            longBreakDuration: number;
                            sessionsBeforeLongBreak: number;
                        } | null) ?? null,
                    pomodoroPhase: (data.pomodoro_phase as "work" | "short_break" | "long_break" | null) ?? null,
                    pomodoroSessionCount: (data.pomodoro_session_count as number) ?? 0,
                })
                .onConflictDoUpdate({
                    target: timers.id,
                    set: {
                        name: data.name as string,
                        timerType: data.timer_type as "stopwatch" | "countdown" | "pomodoro",
                        isRunning: (data.is_running as number) ?? 0,
                        elapsedTime: (data.elapsed_time as number) ?? 0,
                        duration: (data.duration as number | null) ?? null,
                        laps:
                            (data.laps as Array<{
                                number: number;
                                lapTime: number;
                                splitTime: number;
                                timestamp: string;
                            }>) ?? [],
                        updatedAt: data.updated_at as string,
                        showTotal: (data.show_total as number) ?? 0,
                        firstStartTime: (data.first_start_time as string | null) ?? null,
                        startTime: (data.start_time as string | null) ?? null,
                        pomodoroSettings:
                            (data.pomodoro_settings as {
                                workDuration: number;
                                shortBreakDuration: number;
                                longBreakDuration: number;
                                sessionsBeforeLongBreak: number;
                            } | null) ?? null,
                        pomodoroPhase: (data.pomodoro_phase as "work" | "short_break" | "long_break" | null) ?? null,
                        pomodoroSessionCount: (data.pomodoro_session_count as number) ?? 0,
                    },
                });
            break;

        case "PATCH": {
            // Update specific fields (only update what's provided)
            console.log("[Sync] PATCH timer:", op.id, "fields:", Object.keys(data));
            const updates: Partial<typeof timers.$inferInsert> = {
                updatedAt: (data.updated_at as string) ?? new Date().toISOString(),
            };

            // Add any provided fields
            if (data.name !== undefined) {
                updates.name = data.name as string;
            }
            if (data.timer_type !== undefined) {
                updates.timerType = data.timer_type as "stopwatch" | "countdown" | "pomodoro";
            }
            if (data.is_running !== undefined) {
                updates.isRunning = data.is_running as number;
            }
            if (data.elapsed_time !== undefined) {
                updates.elapsedTime = data.elapsed_time as number;
            }
            if (data.duration !== undefined) {
                updates.duration = data.duration as number | null;
            }
            if (data.laps !== undefined) {
                updates.laps = data.laps as Array<{
                    number: number;
                    lapTime: number;
                    splitTime: number;
                    timestamp: string;
                }>;
            }
            if (data.show_total !== undefined) {
                updates.showTotal = data.show_total as number;
            }
            if (data.first_start_time !== undefined) {
                updates.firstStartTime = data.first_start_time as string | null;
            }
            if (data.start_time !== undefined) {
                updates.startTime = data.start_time as string | null;
            }
            if (data.pomodoro_settings !== undefined) {
                updates.pomodoroSettings = data.pomodoro_settings as {
                    workDuration: number;
                    shortBreakDuration: number;
                    longBreakDuration: number;
                    sessionsBeforeLongBreak: number;
                } | null;
            }
            if (data.pomodoro_phase !== undefined) {
                updates.pomodoroPhase = data.pomodoro_phase as "work" | "short_break" | "long_break" | null;
            }
            if (data.pomodoro_session_count !== undefined) {
                updates.pomodoroSessionCount = data.pomodoro_session_count as number;
            }

            console.log("[Sync] PATCH updates:", updates);
            await db.update(timers).set(updates).where(eq(timers.id, op.id));
            break;
        }

        case "DELETE":
            // Delete timer
            await db.delete(timers).where(eq(timers.id, op.id));
            break;
    }
}

/**
 * Process activity log CRUD operation with Drizzle
 */
async function processActivityLogOperation(op: CrudOperation) {
    const data = op.data;

    switch (op.op) {
        case "PUT":
            // Insert activity log (logs are immutable, so just insert)
            await db
                .insert(activityLogs)
                .values({
                    id: op.id,
                    timerId: data.timer_id as string,
                    timerName: data.timer_name as string,
                    userId: data.user_id as string,
                    eventType: data.event_type as ActivityLog["eventType"],
                    timestamp: data.timestamp as string,
                    elapsedAtEvent: (data.elapsed_at_event as number) ?? 0,
                    sessionDuration: (data.session_duration as number | null) ?? null,
                    previousValue: (data.previous_value as number | null) ?? null,
                    newValue: (data.new_value as number | null) ?? null,
                    metadata: (data.metadata as Record<string, unknown>) ?? {},
                })
                .onConflictDoNothing(); // Activity logs are immutable
            break;

        case "DELETE":
            // Delete activity log
            await db.delete(activityLogs).where(eq(activityLogs.id, op.id));
            break;
    }
}

// ============================================
// Fetch Operations
// ============================================

/**
 * Get all timers for a user from the server database
 *
 * Now uses Drizzle select with automatic type inference.
 * No manual row conversions needed!
 */
export const getTimersFromServer = createServerFn({
    method: "GET",
})
    .inputValidator((d: string) => d) // userId
    .handler(async ({ data: userId }): Promise<Timer[]> => {
        try {
            console.log("[Server] getTimersFromServer called for user:", userId);

            const results = await db
                .select()
                .from(timers)
                .where(eq(timers.userId, userId))
                .orderBy(desc(timers.createdAt));

            console.log("[Server] Returning", results.length, "timers");

            // Parse JSONB fields (neon-http doesn't auto-parse them)
            const parsedResults = results.map((timer) => ({
                ...timer,
                laps: typeof timer.laps === "string" ? JSON.parse(timer.laps || "[]") : timer.laps,
                pomodoroSettings:
                    timer.pomodoroSettings && typeof timer.pomodoroSettings === "string"
                        ? JSON.parse(timer.pomodoroSettings)
                        : timer.pomodoroSettings,
            }));

            return parsedResults;
        } catch (error) {
            console.error("[Server] getTimersFromServer error:", error);
            return [];
        }
    });

/**
 * Get all activity logs for a user from the server database
 *
 * Now uses Drizzle select with automatic type inference.
 */
export const getActivityLogsFromServer = createServerFn({
    method: "GET",
})
    .inputValidator((d: string) => d) // userId
    .handler(async ({ data: userId }): Promise<ActivityLog[]> => {
        try {
            console.log("[Server] getActivityLogsFromServer called for user:", userId);

            const results = await db
                .select()
                .from(activityLogs)
                .where(eq(activityLogs.userId, userId))
                .orderBy(desc(activityLogs.timestamp))
                .limit(1000);

            console.log("[Server] Returning", results.length, "activity logs");

            // Parse JSONB fields (neon-http doesn't auto-parse them)
            const parsedResults = results.map((log) => ({
                ...log,
                metadata: log.metadata && typeof log.metadata === "string" ? JSON.parse(log.metadata) : log.metadata,
            }));

            return parsedResults;
        } catch (error) {
            console.error("[Server] getActivityLogsFromServer error:", error);
            return [];
        }
    });

// ============================================
// Delete Operations
// ============================================

/**
 * Delete a timer from the server database
 *
 * Now uses Drizzle delete with type-safe where clause.
 */
export const deleteTimerFromServer = createServerFn({
    method: "POST",
})
    .inputValidator((d: { timerId: string; userId: string }) => d)
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        try {
            await db.delete(timers).where(eq(timers.id, data.timerId));

            // Broadcast event to user
            broadcastToUser("timer", data.userId, {
                type: "sync",
                timestamp: Date.now(),
            });

            return { success: true };
        } catch (error) {
            console.error("[Server] deleteTimerFromServer error:", error);
            return { success: false };
        }
    });
