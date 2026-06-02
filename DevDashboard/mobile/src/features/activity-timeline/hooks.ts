import { useQuery } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { startOfTodayMs, timelineQuery } from "@/features/activity-timeline/queries";

/** Component-facing timeline hook (D32). `since` defaults to local midnight today. */
export function useTimeline(sinceMs: number = startOfTodayMs()) {
    return useQuery(timelineQuery(useDashboardClient(), sinceMs));
}
