/**
 * Timer Sync Server - Drizzle + better-sqlite3 (sync)
 */

import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { type ActivityLog, activityLogs, db, type Timer, timers } from "@/drizzle";

// ============================================
// Fetch Operations
// ============================================

/**
 * Get all timers for a user from the server database
 */
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

/**
 * Get all activity logs for a user from the server database
 */
// Narrow metadata to primitive-only values so TanStack's serialization
// type-checker (ValidateSerializableInput) is satisfied — metadata values
// are always JSON primitives in practice (e.g. pomodoroPhase: string).
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

            const parsedResults: ParsedActivityLog[] = rawResults.map((log) => ({
                ...log,
                metadata: log.metadata as Record<string, string | number | boolean | null> | null,
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
 */
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
