import type { CoverageResponse } from "@app/shops/types";
import { CoverageShopCard } from "@app/shops/ui/components/CoverageShopCard";
import { EmptyState } from "@app/shops/ui/components/EmptyState";
import { Skeleton } from "@app/utils/ui/components/skeleton";
import { ShoppingBasket } from "lucide-react";

interface CoverageGridProps {
    data: CoverageResponse | undefined;
    isLoading: boolean;
}

export function CoverageGrid({ data, isLoading }: CoverageGridProps) {
    if (isLoading) {
        return (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {Array.from({ length: 8 }, (_, i) => (
                    <Skeleton key={i} className="h-44 rounded" />
                ))}
            </div>
        );
    }

    if (!data || data.rows.length === 0) {
        return (
            <EmptyState
                icon={<ShoppingBasket />}
                title="NO SHOPS REGISTERED"
                body="Run tools shops db migrate then tools shops crawl --shop rohlik to populate."
            />
        );
    }

    return (
        <div className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 border border-zinc-800 rounded-md p-4 bg-zinc-950">
                <div>
                    <div className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground uppercase">
                        Total Products
                    </div>
                    <div className="font-mono text-2xl text-[var(--color-neon-cyan)]">
                        {data.summary.total_products.toLocaleString()}
                    </div>
                </div>
                <div>
                    <div className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground uppercase">
                        Offers Today
                    </div>
                    <div className="font-mono text-2xl text-[var(--color-neon-emerald)]">
                        {data.summary.total_offers_today.toLocaleString()}
                    </div>
                </div>
                <div>
                    <div className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground uppercase">
                        Last Crawl
                    </div>
                    <div className="font-mono text-sm text-foreground mt-1.5">
                        {data.summary.last_crawl_at ? data.summary.last_crawl_at.slice(0, 16).replace("T", " ") : "—"}
                    </div>
                </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {data.rows.map((row) => (
                    <CoverageShopCard key={row.shop_origin} row={row} />
                ))}
            </div>
        </div>
    );
}
