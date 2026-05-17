import { BulkAddOrdersTable, type ProviderOrders } from "@app/shops/ui/components/BulkAddOrdersTable";
import { type SpendInsights, SpendSummary } from "@app/shops/ui/components/SpendSummary";
import { RequireAuth, requireAuthBeforeLoad } from "@app/shops/ui/lib/useAuthMe";
import { SafeJSON } from "@app/utils/json";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";

export const Route = createFileRoute("/orders")({
    component: () => (
        <RequireAuth>
            <OrdersPage />
        </RequireAuth>
    ),
    beforeLoad: requireAuthBeforeLoad,
});

interface BulkAddResult {
    added: number;
    skipped_existing: number;
    errors: { input: unknown; error: string }[];
}

function OrdersPage() {
    const navigate = useNavigate();
    const qc = useQueryClient();
    const insights = useQuery({
        queryKey: ["insights", "spend"],
        queryFn: async () => (await fetch("/api/insights/spend")).json() as Promise<SpendInsights>,
    });
    const orders = useQuery({
        queryKey: ["orders", "list"],
        queryFn: async () => (await fetch("/api/orders/list?limit=50")).json() as Promise<ProviderOrders[]>,
    });

    const bulkAdd = useMutation<BulkAddResult, Error, { master_product_id: number }[]>({
        mutationFn: async (items) => {
            const res = await fetch("/api/watchlist/bulk-add", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ items }),
            });
            return (await res.json()) as BulkAddResult;
        },
        onSuccess: (r) => {
            toast.success(`Added ${r.added}, skipped ${r.skipped_existing}`);
            qc.invalidateQueries({ queryKey: ["watchlist"] });
        },
    });

    return (
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
            <h1 className="font-mono tracking-[0.3em] text-sm text-muted-foreground uppercase">
                Orders :: <span className="text-foreground">spend & bulk-add</span>
            </h1>
            {insights.data ? (
                <SpendSummary
                    data={insights.data}
                    onProductClick={(id) => navigate({ to: "/master/$id", params: { id: String(id) } })}
                />
            ) : (
                <div className="font-mono text-xs text-muted-foreground">loading insights…</div>
            )}
            {orders.data ? (
                <BulkAddOrdersTable
                    providers={orders.data}
                    onBulkAdd={(items) => bulkAdd.mutateAsync(items).then(() => undefined)}
                />
            ) : (
                <div className="font-mono text-xs text-muted-foreground">loading orders…</div>
            )}
        </div>
    );
}
