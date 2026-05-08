import type { MasterDetail as MasterDetailType, PriceHistoryResponse } from "@app/shops/types";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { MasterDetail } from "./MasterDetail";
import { ProductSearchPanel } from "./ProductSearchPanel";

export function WorkspaceSplit() {
    const [selectedId, setSelectedId] = useState<number | null>(null);

    const detailQuery = useQuery({
        queryKey: ["master-detail", selectedId],
        queryFn: async (): Promise<MasterDetailType> => {
            const res = await fetch(`/api/master/${selectedId}`);
            if (!res.ok) {
                throw new Error(`master detail failed: ${res.status}`);
            }

            return res.json();
        },
        enabled: selectedId !== null,
    });

    const historyQuery = useQuery({
        queryKey: ["master-history", selectedId],
        queryFn: async (): Promise<PriceHistoryResponse> => {
            const res = await fetch(`/api/master/${selectedId}/history?days=90`);
            if (!res.ok) {
                throw new Error(`history fetch failed: ${res.status}`);
            }

            return res.json();
        },
        enabled: selectedId !== null,
    });

    return (
        <div className="grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-3 h-[calc(100vh-200px)] min-h-[500px]">
            <div className="border border-zinc-800 rounded-md overflow-hidden bg-zinc-950 lg:max-w-md">
                <ProductSearchPanel
                    onSelect={(id, type) => {
                        if (type === "master") {
                            setSelectedId(id);
                        }
                    }}
                />
            </div>
            <div className="border border-zinc-800 rounded-md overflow-y-auto p-4 bg-zinc-950">
                {selectedId === null ? (
                    <div className="h-full flex items-center justify-center font-mono text-xs tracking-[0.2em] text-muted-foreground uppercase">
                        select a master from the left
                    </div>
                ) : (
                    <MasterDetail
                        detail={detailQuery.data}
                        history={historyQuery.data}
                        isLoading={detailQuery.isLoading}
                        isHistoryLoading={historyQuery.isLoading}
                    />
                )}
            </div>
        </div>
    );
}
