import { useQuery } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { weatherSnapshotQuery } from "@/features/weather/queries";

/**
 * Component-facing weather hook (D32). Components import THIS — never raw `useQuery`. One-liner that
 * grabs the active client from the provider and feeds the `weatherSnapshotQuery` factory to
 * `useQuery`, so the mock↔real swap stays invisible to the card.
 */

export function useWeatherCard() {
    return useQuery(weatherSnapshotQuery(useDashboardClient()));
}
