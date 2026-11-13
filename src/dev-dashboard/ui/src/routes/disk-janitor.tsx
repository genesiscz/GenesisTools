import type { DiskUsageResult } from "@app/dev-dashboard/contract/dto";
import { ENDPOINTS } from "@app/dev-dashboard/contract/endpoint-table";
import { useQuery } from "@tanstack/react-query";
import { DiskUsageBars } from "@/components/disk-janitor/DiskUsageBars";
import { dashboard } from "@/lib/dashboard-client";

export function DiskJanitorRoute() {
    const { data } = useQuery<DiskUsageResult>({
        queryKey: ["disk-usage"],
        queryFn: () => dashboard.call(ENDPOINTS.diskUsage, {}),
        refetchInterval: 60000,
    });

    return (
        <div className="h-[calc(100vh-2rem)]">
            {data ? (
                <DiskUsageBars result={data} />
            ) : (
                <div className="dd-panel flex h-full items-center justify-center text-[var(--dd-text-muted)]">
                    Scanning disk...
                </div>
            )}
        </div>
    );
}
