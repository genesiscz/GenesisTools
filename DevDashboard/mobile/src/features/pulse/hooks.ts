import { useQuery } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { pulseHistoryQuery, pulseQuery, weatherQuery } from "@/features/pulse/queries";
import { useLiveRefetchInterval } from "@/live/provider";

/**
 * Component-facing Pulse hooks (D32). Components import THESE — never raw `useQuery`. Each hook is
 * a one-liner that grabs the active client from the provider and feeds the matching `queryOptions`
 * factory to `useQuery`. The mock↔real swap lives in the provider, so a screen using `usePulse()`
 * renders fixtures or live data without changing.
 *
 * ► REFERENCE SHAPE every feature copies:
 *     export const useX = () => useQuery(xQuery(useDashboardClient()));
 */

/** The pulse snapshot. The live `pulse` channel writes it while the stream is up; it polls only while it is not. */
export function usePulse() {
    const refetchInterval = useLiveRefetchInterval("pulse");
    return useQuery({ ...pulseQuery(useDashboardClient()), refetchInterval });
}

export function usePulseHistory(metric: string, minutes: number) {
    return useQuery(pulseHistoryQuery(useDashboardClient(), metric, minutes));
}

export function useWeather() {
    return useQuery(weatherQuery(useDashboardClient()));
}
