import type { Timer } from "@/drizzle";

export interface TimerSSECacheEvent {
    type: string;
    snapshot?: Timer;
    activityDirty?: boolean;
    focusStatsDirty?: boolean;
    focusSessionsDirty?: boolean;
}

export interface TimerQueryCache {
    setQueryData<T>(queryKey: readonly unknown[], updater: (old: T | undefined) => T | undefined): unknown;
    invalidateQueries(filters: { queryKey: readonly unknown[] }): unknown;
}

export function applyCommittedTimerEvent(cache: TimerQueryCache, userId: string, event: TimerSSECacheEvent): void {
    if (event.type !== "timer_changed") {
        return;
    }

    if (event.snapshot) {
        cache.setQueryData<Timer[]>(["timers", userId], (old) => {
            if (!Array.isArray(old)) {
                return old;
            }

            return old.map((timer) => (timer.id === event.snapshot?.id ? event.snapshot : timer));
        });
    } else {
        cache.invalidateQueries({ queryKey: ["timers", userId] });
    }

    if (event.activityDirty) {
        cache.invalidateQueries({ queryKey: ["activity-logs", userId] });
    }

    if (event.focusStatsDirty) {
        cache.invalidateQueries({ queryKey: ["focus-stats-today", userId] });
    }

    if (event.focusSessionsDirty) {
        cache.invalidateQueries({ queryKey: ["focus-sessions-today", userId] });
    }
}

export function recoverTimerQueries(cache: TimerQueryCache, userId: string): void {
    cache.invalidateQueries({ queryKey: ["timers", userId] });

    for (const key of ["activity-logs", "focus-stats-today", "focus-sessions-today"] as const) {
        cache.invalidateQueries({ queryKey: [key, userId] });
    }
}
