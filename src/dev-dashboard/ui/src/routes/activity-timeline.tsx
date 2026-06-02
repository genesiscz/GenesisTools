import { paths } from "@app/dev-dashboard/contract/endpoints";
import type { TimelineEvent } from "@app/dev-dashboard/lib/timeline/types";
import { useQuery } from "@tanstack/react-query";
import { Timeline } from "@/components/activity-timeline/Timeline";
import { fetchJson } from "@/lib/api";

/** Local midnight today, epoch ms — the default "today on this machine" lower bound. */
function startOfTodayMs(): number {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/**
 * Activity Timeline route — the unified "today on this machine" feed (daemon runs + agent Q&A +
 * terminal launches), grouped by hour. Consumes the same `GET /api/timeline` route as the mobile
 * app (web↔mobile parity); the merge + sort happens server-side, the UI just groups by hour.
 */
export function ActivityTimelineRoute() {
    const since = startOfTodayMs();

    const { data, isLoading } = useQuery({
        queryKey: ["timeline", "feed", since],
        queryFn: () => fetchJson<TimelineEvent[]>(paths.timeline({ since })),
        refetchInterval: 20_000,
    });

    if (isLoading && !data) {
        return (
            <div className="dd-panel flex h-[calc(100vh-2rem)] items-center justify-center text-[var(--dd-text-muted)]">
                Loading activity…
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4 p-2">
            <h1 className="dd-accent-text text-sm font-semibold">Today on this machine</h1>
            <Timeline events={data ?? []} />
        </div>
    );
}
