import type { ContainersResult } from "@app/dev-dashboard/contract/dto";
import { ENDPOINTS } from "@app/dev-dashboard/contract/endpoint-table";
import { useQuery } from "@tanstack/react-query";
import { ContainersTable } from "@/components/containers/ContainersTable";
import { dashboard } from "@/lib/dashboard-client";

export function ContainersRoute() {
    const { data } = useQuery<ContainersResult>({
        queryKey: ["containers"],
        queryFn: () => dashboard.call(ENDPOINTS.containers, {}),
        refetchInterval: 5000,
    });

    return (
        <div className="h-[calc(100vh-2rem)]">
            {data ? (
                <ContainersTable result={data} />
            ) : (
                <div className="dd-panel flex h-full items-center justify-center text-[var(--dd-text-muted)]">
                    Loading containers...
                </div>
            )}
        </div>
    );
}
