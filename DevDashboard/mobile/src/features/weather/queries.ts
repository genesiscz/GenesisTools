import type { DashboardClient, WeatherRes } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

/**
 * Weather feature data layer (D32 + per-feature layout). Co-locates `weatherFeatureKeys` and the
 * `queryOptions` factory over the injected `DashboardClient` (see src/features/pulse/queries.ts —
 * the reference this copies). The thin `useWeatherCard` hook in `./hooks` feeds this to `useQuery`.
 *
 * KEY-ROOT NOTE: Pulse already owns the `["weather"]` root (`pulseKeys.weather`) for the same
 * `client.weather()` endpoint. To avoid two features writing the same shared root from different
 * files, this feature uses a DISTINCT root `["weather-card", "snapshot"]`. React Query would dedupe
 * an identical key, but distinct roots keep per-feature invalidation independent (D32 rule #1: each
 * feature leads with a UNIQUE root). The cost is one extra `client.weather()` fetch when both the
 * Pulse weather block and a standalone weather card mount at once — acceptable (10-min poll). See
 * 20-impl-09-rest-notes.md.
 */

export const weatherFeatureKeys = {
    snapshot: ["weather-card", "snapshot"] as const,
} as const;

export const WEATHER_INTERVAL_MS = 600_000;

export function weatherSnapshotQuery(client: DashboardClient) {
    return queryOptions<WeatherRes>({
        queryKey: weatherFeatureKeys.snapshot,
        queryFn: () => client.weather(),
        refetchInterval: WEATHER_INTERVAL_MS,
    });
}
