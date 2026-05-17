import { useQuery } from "@tanstack/react-query";
import { useAssistantStreakQuery } from "@/lib/assistant/hooks/useAssistantQueries";
import { aggregateFocusStats } from "@/lib/timer/timer-sync.server";

export interface AggregatedFocusStats {
    timeFocusedTodayMs: number;
    sessionsToday: number;
    dayStreak: number;
}

/**
 * Returns today's focus stats for FocusHero.
 * - timeFocusedTodayMs / sessionsToday: aggregated from today's activity_logs.
 * - dayStreak: read from assistantStreaks table via existing hook.
 *
 * The ["focus-stats-today", userId] query key is invalidated by useTimerSSE on
 * every timer event, so this stays live without a separate SSE subscription.
 */
export function useAggregatedFocusStats(userId: string | null): AggregatedFocusStats {
    const focusQuery = useQuery({
        queryKey: ["focus-stats-today", userId],
        queryFn: () => aggregateFocusStats(),
        enabled: !!userId,
        staleTime: 10_000,
        refetchOnWindowFocus: true,
    });

    const streakQuery = useAssistantStreakQuery(userId);

    return {
        timeFocusedTodayMs: focusQuery.data?.timeFocusedTodayMs ?? 0,
        sessionsToday: focusQuery.data?.sessionsToday ?? 0,
        dayStreak: streakQuery.data?.currentStreakDays ?? 0,
    };
}
