import { useQuery } from "@tanstack/react-query";
import { CmuxSessionList } from "@/components/CmuxSessionList";
import { cmuxApi } from "@/lib/api";

export function CmuxRoute() {
    const { data } = useQuery({
        queryKey: ["cmux", "snapshot"],
        queryFn: cmuxApi.snapshot,
        refetchInterval: 2000,
    });

    return (
        <div className="h-[calc(100vh-2rem)]">
            {data?.snapshot ? (
                <CmuxSessionList snapshot={data.snapshot} />
            ) : (
                <div className="dd-panel flex h-full items-center justify-center text-[var(--dd-text-muted)]">
                    Loading cmux snapshot...
                </div>
            )}
        </div>
    );
}
