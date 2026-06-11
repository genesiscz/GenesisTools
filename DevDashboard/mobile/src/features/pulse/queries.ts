import type { DashboardClient, PulseHistoryRes, PulseRes, WeatherRes } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

/**
 * Pulse feature data layer (D32 + per-feature layout). This file owns BOTH the query keys
 * (`pulseKeys`, co-located so no shared file grows per feature) and the TanStack v5 `queryOptions`
 * FACTORIES. Each factory closes over the injected `DashboardClient` and returns a fully-typed
 * options object (key + queryFn + polling). The thin `use*` hooks in `./hooks` pass
 * `useDashboardClient()` here and feed the result straight to `useQuery`.
 *
 * Why factories over the client (not a singleton): the mock↔real client is chosen by the
 * `ClientProvider`, so the SAME factory works against fixtures or a live device — the swap is
 * invisible to callers, and a prefetch / `setQueryData` path can reuse the exact factory.
 *
 * ► THIS IS THE REFERENCE OTHER FEATURES COPY. To add `src/features/<x>/`: define `<x>Keys` with a
 *   unique root segment, write one `queryOptions` factory per endpoint over `client.<domain>.*`,
 *   then a thin hook in `./hooks`. Touch NO shared file except (optionally) reading query-keys.ts.
 *
 * Polling mirrors the web Pulse UI: ~5 s live snapshot, ~10 s history (60 s for the 24 h range to
 * avoid hammering), 10 min weather. Background pause is the foundation's onlineManager/focusManager
 * wiring (src/lib/query.ts) — not re-implemented here.
 */

export const pulseKeys = {
    snap: ["pulse", "snap"] as const,
    history: (metric: string, minutes: number) => ["pulse", "history", metric, minutes] as const,
    weather: ["weather"] as const,
} as const;

export const SNAP_INTERVAL_MS = 5_000;
export const HISTORY_INTERVAL_MS = 10_000;
export const HISTORY_INTERVAL_LONG_MS = 60_000;
export const WEATHER_INTERVAL_MS = 600_000;
export const LONG_RANGE_MINUTES = 1440;

export function pulseQuery(client: DashboardClient) {
    return queryOptions<PulseRes>({
        queryKey: pulseKeys.snap,
        queryFn: () => client.system.pulse(),
        refetchInterval: SNAP_INTERVAL_MS,
    });
}

export function pulseHistoryQuery(client: DashboardClient, metric: string, minutes: number) {
    return queryOptions<PulseHistoryRes>({
        queryKey: pulseKeys.history(metric, minutes),
        queryFn: () => client.system.pulseHistory(metric, minutes),
        refetchInterval: minutes >= LONG_RANGE_MINUTES ? HISTORY_INTERVAL_LONG_MS : HISTORY_INTERVAL_MS,
    });
}

export function weatherQuery(client: DashboardClient) {
    return queryOptions<WeatherRes>({
        queryKey: pulseKeys.weather,
        queryFn: () => client.weather(),
        refetchInterval: WEATHER_INTERVAL_MS,
    });
}
