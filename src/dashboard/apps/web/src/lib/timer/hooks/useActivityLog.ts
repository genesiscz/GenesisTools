import type { ActivityLogEntry, ActivityLogQueryOptions, ProductivityStats } from "@dashboard/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { clearActivityLogs, getActivityLogsFromServer } from "@/lib/timer/timer-sync.server";

/** Server rows use ISO-string timestamps + nullable numbers; the UI type wants
 *  a Date and optional numbers. Normalize at the boundary. */
function toEntry(log: {
    id: string;
    timerId: string;
    timerName: string;
    userId: string;
    eventType: ActivityLogEntry["eventType"];
    timestamp: string;
    elapsedAtEvent: number;
    sessionDuration: number | null;
    previousValue: number | null;
    newValue: number | null;
    metadata: Record<string, unknown> | null;
}): ActivityLogEntry {
    return {
        id: log.id,
        timerId: log.timerId,
        timerName: log.timerName,
        userId: log.userId,
        eventType: log.eventType,
        timestamp: new Date(log.timestamp),
        elapsedAtEvent: log.elapsedAtEvent,
        sessionDuration: log.sessionDuration ?? undefined,
        previousValue: log.previousValue ?? undefined,
        newValue: log.newValue ?? undefined,
        metadata: log.metadata ?? undefined,
    };
}

interface UseActivityLogOptions {
    userId: string | null;
    autoRefresh?: boolean;
    refreshInterval?: number;
}

interface UseActivityLogReturn {
    entries: ActivityLogEntry[];
    loading: boolean;
    error: string | null;
    // Query methods
    getEntries: (options?: ActivityLogQueryOptions) => Promise<ActivityLogEntry[]>;
    getStats: (startDate: Date, endDate: Date) => Promise<ProductivityStats | null>;
    // Actions
    clearAll: () => Promise<void>;
    refresh: () => Promise<void>;
    // Filtering state
    filter: ActivityLogFilter;
    setFilter: (filter: Partial<ActivityLogFilter>) => void;
}

export interface ActivityLogFilter {
    timerId?: string;
    eventTypes?: Array<"start" | "pause" | "reset" | "lap" | "complete" | "time_edit" | "pomodoro_phase_change">;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
}

/**
 * Hook for managing activity log data and filtering.
 * Backed by the SQLite activity_logs table via server functions. Timer
 * mutations persist events in `timer-sync.server.ts#mutate`; this query is
 * invalidated by `useTimerSSE` on every timer event so the log stays live.
 */
export function useActivityLog({ userId, refreshInterval }: UseActivityLogOptions): UseActivityLogReturn {
    const [filter, setFilterState] = useState<ActivityLogFilter>({});
    const qc = useQueryClient();

    const query = useQuery({
        queryKey: ["activity-logs", userId],
        queryFn: async () => {
            const rows = await getActivityLogsFromServer({ data: userId! });
            return rows.map(toEntry);
        },
        enabled: !!userId,
        staleTime: 5_000,
        refetchInterval: refreshInterval,
        refetchOnWindowFocus: true,
    });

    const allEntries = query.data ?? [];
    const entries = applyFilter(allEntries, filter);

    const clearMutation = useMutation({
        mutationFn: () => clearActivityLogs({ data: { userId: userId! } }),
        onSuccess: () => {
            qc.setQueryData(["activity-logs", userId], []);
        },
    });

    async function getEntries(options?: ActivityLogQueryOptions): Promise<ActivityLogEntry[]> {
        const rows = await qc.ensureQueryData({
            queryKey: ["activity-logs", userId],
            queryFn: async () => (await getActivityLogsFromServer({ data: userId! })).map(toEntry),
        });

        return applyFilter(rows, { ...filter, ...options });
    }

    async function getStats(startDate: Date, endDate: Date): Promise<ProductivityStats | null> {
        const scoped = allEntries.filter((e) => e.timestamp >= startDate && e.timestamp <= endDate);

        if (scoped.length === 0) {
            return null;
        }

        const timerBreakdown: Record<string, number> = {};
        const dailyBreakdown: Record<string, number> = {};
        let pomodoroCompleted = 0;

        for (const e of scoped) {
            if (e.eventType === "complete") {
                pomodoroCompleted += 1;
            }

            const day = e.timestamp.toISOString().slice(0, 10);
            dailyBreakdown[day] = (dailyBreakdown[day] ?? 0) + (e.sessionDuration ?? 0);
            timerBreakdown[e.timerId] = (timerBreakdown[e.timerId] ?? 0) + (e.sessionDuration ?? 0);
        }

        const sessions = scoped.filter((e) => e.eventType === "pause" && e.sessionDuration);
        const durations = sessions.map((s) => s.sessionDuration ?? 0);
        const totalTimeTracked = durations.reduce((a, b) => a + b, 0);

        return {
            totalTimeTracked,
            sessionCount: sessions.length,
            averageSessionDuration: sessions.length ? totalTimeTracked / sessions.length : 0,
            longestSession: durations.length ? Math.max(...durations) : 0,
            timerBreakdown,
            dailyBreakdown,
            pomodoroCompleted,
        };
    }

    async function clearAll(): Promise<void> {
        await clearMutation.mutateAsync();
    }

    async function refresh(): Promise<void> {
        await qc.invalidateQueries({ queryKey: ["activity-logs", userId] });
    }

    function setFilter(newFilter: Partial<ActivityLogFilter>) {
        setFilterState((prev) => ({ ...prev, ...newFilter }));
    }

    return {
        entries,
        loading: query.isLoading,
        error: query.error ? String(query.error) : null,
        getEntries,
        getStats,
        clearAll,
        refresh,
        filter,
        setFilter,
    };
}

/**
 * Helper to apply filter to entries client-side
 */
function applyFilter(entries: ActivityLogEntry[], filter: ActivityLogFilter): ActivityLogEntry[] {
    let result = entries;

    if (filter.timerId) {
        result = result.filter((e) => e.timerId === filter.timerId);
    }

    if (filter.eventTypes?.length) {
        result = result.filter((e) => filter.eventTypes?.includes(e.eventType as (typeof filter.eventTypes)[number]));
    }

    if (filter.startDate) {
        result = result.filter((e) => new Date(e.timestamp) >= filter.startDate!);
    }

    if (filter.endDate) {
        result = result.filter((e) => new Date(e.timestamp) <= filter.endDate!);
    }

    if (filter.limit) {
        result = result.slice(0, filter.limit);
    }

    return result;
}

/**
 * Get today's date range
 */
export function getTodayRange(): { start: Date; end: Date } {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    return { start, end };
}

/**
 * Get this week's date range
 */
export function getWeekRange(): { start: Date; end: Date } {
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - now.getDay());
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    return { start, end };
}

/**
 * Get this month's date range
 */
export function getMonthRange(): { start: Date; end: Date } {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    return { start, end };
}
