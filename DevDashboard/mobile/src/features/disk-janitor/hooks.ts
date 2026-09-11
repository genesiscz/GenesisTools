import { useQuery } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { diskUsageQuery } from "@/features/disk-janitor/queries";

/** Component-facing disk-usage hook (D32). Components import THIS — never raw `useQuery`. */
export function useDiskUsage() {
    return useQuery(diskUsageQuery(useDashboardClient()));
}
