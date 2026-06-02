import { useQuery } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { pulseHistoryQuery, pulseQuery, weatherQuery } from "@/features/pulse/queries";

/**
 * Component-facing Pulse hooks (D32). Components import THESE — never raw `useQuery`. Each hook is
 * a one-liner that grabs the active client from the provider and feeds the matching `queryOptions`
 * factory to `useQuery`. The mock↔real swap lives in the provider, so a screen using `usePulse()`
 * renders fixtures or live data without changing.
 *
 * ► REFERENCE SHAPE every feature copies:
 *     export const useX = () => useQuery(xQuery(useDashboardClient()));
 */

export function usePulse() {
    return useQuery(pulseQuery(useDashboardClient()));
}

export function usePulseHistory(metric: string, minutes: number) {
    return useQuery(pulseHistoryQuery(useDashboardClient(), metric, minutes));
}

export function useWeather() {
    return useQuery(weatherQuery(useDashboardClient()));
}
