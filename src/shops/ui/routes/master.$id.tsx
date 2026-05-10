import type { MasterDetail as MasterDetailType, PriceHistoryResponse } from "@app/shops/types";
import { MasterDetail } from "@app/shops/ui/components/MasterDetail";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

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
            const res = await fetch(`/api/master/${id}/history?days=1825`);
            if (!res.ok) {
                throw new Error(`history fetch failed: ${res.status}`);
            }

            return res.json();
        },
    });

    const bestTimeQuery = useQuery({
        queryKey: ["master", id, "best-time"],
        queryFn: async (): Promise<{
            best_weekday: { weekday_name: string; avg_price: number; sample_size: number } | null;
        }> => {
            const res = await fetch(`/api/master/${id}/history?stats=1`);
            if (!res.ok) {
                throw new Error(`best-time fetch failed: ${res.status}`);
            }

            return res.json();
        },
    });

    const watchlistQuery = useQuery({
        queryKey: ["watchlist"],
        queryFn: async (): Promise<{ master_product_id: number; target_price: number | null }[]> => {
            const res = await fetch("/api/watchlist");
            if (!res.ok) {
                throw new Error(`watchlist fetch failed: ${res.status}`);
            }

            return res.json();
        },
    });

    const watchEntry = watchlistQuery.data?.find((w) => w.master_product_id === Number(id));
    const targetPrice = watchEntry?.target_price ?? null;
    const isFavorite = watchEntry !== undefined;

    return (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
            <MasterDetail
                detail={detailQuery.data}
                history={historyQuery.data}
                isLoading={detailQuery.isLoading}
                isHistoryLoading={historyQuery.isLoading}
                targetPrice={targetPrice}
                bestTime={bestTimeQuery.data?.best_weekday ?? null}
                isFavorite={isFavorite}
            />
        </div>
    );
}
