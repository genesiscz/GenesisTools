import type { DiskUsageResult } from "@app/dev-dashboard/lib/disk/types";
import { useQuery } from "@tanstack/react-query";
import { DiskUsageBars } from "@/components/disk-janitor/DiskUsageBars";

export function DiskJanitorRoute() {
    const { data } = useQuery<DiskUsageResult>({
        queryKey: ["disk-usage"],
        queryFn: () => fetch("/api/disk/usage").then((r) => r.json()),
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
