import type { CompareResponse } from "@app/shops/types";
import { CompareGrid } from "@app/shops/ui/components/CompareGrid";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

interface CompareSearch {
    ids?: string;
}

export const Route = createFileRoute("/compare")({
    validateSearch: (search: Record<string, unknown>): CompareSearch => ({
        ids: typeof search.ids === "string" ? search.ids : undefined,
    }),
    component: ComparePage,
});

function ComparePage() {
    const search = Route.useSearch();
    const ids = search.ids ?? "";

    const compareQuery = useQuery({
        queryKey: ["compare", ids],
        queryFn: async (): Promise<CompareResponse> => {
            const res = await fetch(`/api/compare?ids=${encodeURIComponent(ids)}`);
            if (!res.ok) {
                const body = await res.json().catch(() => ({ error: "compare failed" }));
                throw new Error(body.error ?? "compare failed");
            }

            return res.json();
        },
        enabled: ids.length > 0,
    });

    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
            <h1 className="font-mono tracking-[0.3em] text-sm text-muted-foreground uppercase">
                Compare :: <span className="text-foreground">N-Way</span>
            </h1>
            {ids.length === 0 ? (
                <div className="font-mono text-xs text-muted-foreground tracking-[0.15em] uppercase border border-dashed border-border rounded-md p-12 text-center">
                    pass <span className="text-[var(--color-neon-cyan)]">?ids=A,B,C</span> to compare master products
                </div>
            ) : (
                <CompareGrid data={compareQuery.data} isLoading={compareQuery.isLoading} />
            )}
        </div>
    );
}
