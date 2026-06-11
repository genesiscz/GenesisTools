import { useQuery } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { daemonRunLogQuery, daemonRunsQuery, daemonStatusQuery } from "@/features/daemon/queries";

/**
 * Component-facing daemon hooks (D32). Components import THESE — never raw `useQuery`. One-liners
 * over the active client from the provider, so the mock↔real swap stays invisible.
 *
 * ► REFERENCE SHAPE: `export const useX = () => useQuery(xQuery(useDashboardClient()));`
 */

export function useDaemonStatus() {
    return useQuery(daemonStatusQuery(useDashboardClient()));
}

export function useDaemonRuns(limit?: number) {
    return useQuery(daemonRunsQuery(useDashboardClient(), limit));
}

export function useDaemonRunLog(logFile: string | null) {
    return useQuery(daemonRunLogQuery(useDashboardClient(), logFile));
}
