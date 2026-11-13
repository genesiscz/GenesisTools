import { useQuery } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { glanceQuery } from "@/features/glance/queries";

/** The Mac's glance (the waiting counts), polled while `enabled`. Components read it here, never through a raw query. */
export function useGlance(enabled: boolean) {
    const client = useDashboardClient();
    return useQuery({ ...glanceQuery(client), enabled });
}
