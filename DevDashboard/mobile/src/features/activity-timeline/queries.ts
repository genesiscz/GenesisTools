import type { DashboardClient, TimelineEvent } from "@dd/contract";
import { paths } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

/**
 * Activity-timeline data layer (D32). Co-locates `timelineKeys` + a `queryOptions` factory over the
 * injected `DashboardClient`. ESCAPE HATCH: the contract has no typed `client.timeline.*` namespace,
 * so we use generic `client.get<TimelineEvent[]>(paths.timeline(...))` (same shape daemon uses).
 *
 * The mock falls through `escapeHatch` and returns the `MOCK_TIMELINE` array; a real device returns
 * the merged array from GET /api/timeline. `asArray` guards the not-yet-mocked-route `{}` case.
 *
 * Polling: 20 s — new runs/Q&A/terminals trickle in; the timeline is a slow feed, not a live ticker.
 */

export const timelineKeys = {
    feed: (sinceMs: number) => ["timeline", "feed", sinceMs] as const,
} as const;

export const TIMELINE_INTERVAL_MS = 20_000;

/** Local midnight today, epoch ms — the default lower bound shown by the screen. */
export function startOfTodayMs(): number {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function asArray<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
}

export function timelineQuery(client: DashboardClient, sinceMs: number) {
    return queryOptions<TimelineEvent[]>({
        queryKey: timelineKeys.feed(sinceMs),
        queryFn: async () =>
            asArray<TimelineEvent>(await client.get<TimelineEvent[]>(paths.timeline({ since: sinceMs }))),
        refetchInterval: TIMELINE_INTERVAL_MS,
    });
}
