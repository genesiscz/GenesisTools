import { useQuery } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { netStatusQuery } from "@/features/network-status/queries";

/** Component-facing network-status hook (D32). Components import THIS — never raw `useQuery`. */
export function useNetStatus() {
    return useQuery(netStatusQuery(useDashboardClient()));
}
