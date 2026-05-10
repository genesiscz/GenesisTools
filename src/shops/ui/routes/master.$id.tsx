import type { MasterDetail as MasterDetailType, PriceHistoryResponse } from "@app/shops/types";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { MasterDetail } from "@app/shops/ui/components/MasterDetail";

export const Route = createFileRoute("/master/$id")({
    component: MasterPage,
});

function MasterPage() {
    const { id } = Route.useParams();

    const detailQuery = useQuery({
        queryKey: ["master-detail", id],
        queryFn: async (): Promise<MasterDetailType> => {
            const res = await fetch(`/api/master/${id}`);
            if (!res.ok) {
                const body = await res.json().catch(() => ({ error: "fetch failed" }));
                throw new Error(body.error ?? `master detail failed: ${res.status}`);
            }

            return res.json();
        },
    });

    const historyQuery = useQuery({
        queryKey: ["master-history", id],
        queryFn: async (): Promise<PriceHistoryResponse> => {
            const res = await fetch(`/api/master/${id}/history?days=90`);
            if (!res.ok) {
                throw new Error(`history fetch failed: ${res.status}`);
            }

            return res.json();
        },
    });

    return (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
            <MasterDetail
                detail={detailQuery.data}
                history={historyQuery.data}
                isLoading={detailQuery.isLoading}
                isHistoryLoading={historyQuery.isLoading}
            />
        </div>
    );
}
