import type { ActivityLogEntry, ActivityLogQueryOptions, ProductivityStats } from "@dashboard/shared";
import { useState } from "react";

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
 * Activity log persistence is not yet implemented in the server-side architecture;
 * this hook returns empty state as a no-op stub until a server function is added.
 */
export function useActivityLog({
    userId: _userId,
    autoRefresh: _autoRefresh,
    refreshInterval: _refreshInterval,
}: UseActivityLogOptions): UseActivityLogReturn {
    const [filter, setFilterState] = useState<ActivityLogFilter>({});

    async function getEntries(_options?: ActivityLogQueryOptions): Promise<ActivityLogEntry[]> {
        return [];
    }

    async function getStats(_startDate: Date, _endDate: Date): Promise<ProductivityStats | null> {
        return null;
    }

    async function clearAll(): Promise<void> {
        // no-op
    }

    async function refresh(): Promise<void> {
        // no-op
    }

    function setFilter(newFilter: Partial<ActivityLogFilter>) {
        setFilterState((prev) => ({ ...prev, ...newFilter }));
    }

    return {
        entries: [],
        loading: false,
        error: null,
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

// Suppress unused-function warning — applyFilter is a utility kept for future use
void applyFilter;

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
