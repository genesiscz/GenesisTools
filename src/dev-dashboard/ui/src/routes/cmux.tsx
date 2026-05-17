import { useQuery } from "@tanstack/react-query";
import { CmuxSessionList } from "@/components/CmuxSessionList";
import { cmuxApi } from "@/lib/api";

export function CmuxRoute() {
    const { data, isError, error } = useQuery({
        queryKey: ["cmux", "snapshot"],
        queryFn: cmuxApi.snapshot,
        refetchInterval: 2000,
    });

    return (
        <div className="h-[calc(100vh-2rem)]">
            {isError ? (
                <div className="dd-panel flex h-full items-center justify-center text-[#f87171]">
                    Failed to load cmux snapshot: {error instanceof Error ? error.message : String(error)}
                </div>
            ) : data?.snapshot ? (
                <CmuxSessionList snapshot={data.snapshot} />
            ) : (
                <div className="dd-panel flex h-full items-center justify-center text-[var(--dd-text-muted)]">
                    Loading cmux snapshot...
                </div>
            )}
        </div>
    );
}
