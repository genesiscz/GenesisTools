import type { ContainersResult } from "@app/dev-dashboard/lib/containers/types";
import { useQuery } from "@tanstack/react-query";
import { ContainersTable } from "@/components/containers/ContainersTable";

export function ContainersRoute() {
    const { data } = useQuery<ContainersResult>({
        queryKey: ["containers"],
        queryFn: () => fetch("/api/containers").then((r) => r.json()),
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
