import type { CoverageResponse } from "@app/shops/types";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CoverageGrid } from "@app/shops/ui/components/CoverageGrid";

export const Route = createFileRoute("/coverage")({
    component: CoveragePage,
});

function CoveragePage() {
    const coverageQuery = useQuery({
        queryKey: ["coverage"],
        queryFn: async (): Promise<CoverageResponse> => {
            const res = await fetch("/api/coverage");
            if (!res.ok) {
                throw new Error(`coverage fetch failed: ${res.status}`);
            }

            return res.json();
        },
        refetchInterval: 30_000,
    });

    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
            <h1 className="font-mono tracking-[0.3em] text-sm text-muted-foreground uppercase">
                Coverage :: <span className="text-foreground">Per-Shop Capability Matrix</span>
            </h1>
            <CoverageGrid data={coverageQuery.data} isLoading={coverageQuery.isLoading} />
        </div>
    );
}
