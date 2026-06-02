import { useQuery } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { containersQuery } from "@/features/containers/queries";

/**
 * Component-facing containers hook (D32). Components import THIS — never raw `useQuery`. One-liner
 * over the active client from the provider, so the mock↔real swap stays invisible.
 */

export function useContainers() {
    return useQuery(containersQuery(useDashboardClient()));
}
