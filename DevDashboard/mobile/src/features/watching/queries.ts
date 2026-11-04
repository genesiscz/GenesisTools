import {
    type DashboardClient,
    ENDPOINTS,
    type WatchingDto,
    type WatchMuteReceiptDto,
    type WatchRowDto,
    type WatchSourceId,
} from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

export const watchingKeys = { list: ["watching", "list"] as const };

/** The sources poll on their own schedules on the Mac; a minute keeps the list fresh without loading it. */
export const WATCHING_INTERVAL_MS = 60_000;

/** How long the Mute action silences a watch. */
export const MUTE_MINUTES = 120;

export function watchingQuery(client: DashboardClient) {
    return queryOptions<WatchingDto>({
        queryKey: watchingKeys.list,
        queryFn: () => client.call(ENDPOINTS.gatewayWatching, {}),
        refetchInterval: WATCHING_INTERVAL_MS,
    });
}

export function muteWatch(
    client: DashboardClient,
    input: { source: WatchSourceId; id: string; minutes: number; idempotencyKey: string }
): Promise<WatchMuteReceiptDto> {
    const { idempotencyKey, ...body } = input;
    return client.call(ENDPOINTS.watchingMute, body, { idempotencyKey });
}

/** Rows of the chosen source, or all of them. */
export function rowsOf(data: WatchingDto | undefined, source: WatchSourceId | "all"): WatchRowDto[] {
    const rows = data?.rows ?? [];
    return source === "all" ? rows : rows.filter((row) => row.source === source);
}

/** How many rows want a look (alert or down, not muted). */
export function attentionCount(rows: readonly WatchRowDto[]): number {
    return rows.filter((row) => (row.state === "alert" || row.state === "down") && !row.mutedUntil).length;
}
