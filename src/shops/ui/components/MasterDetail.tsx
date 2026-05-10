import type { MasterDetail as MasterDetailType, PriceHistoryResponse } from "@app/shops/types";
import { Skeleton } from "@app/utils/ui/components/skeleton";
import { ImageOff } from "lucide-react";
import { CrossShopOffersTable } from "@app/shops/ui/components/CrossShopOffersTable";
import { OfferDetailTabs } from "@app/shops/ui/components/OfferDetailTabs";
import { PriceHistoryChart } from "@app/shops/ui/components/PriceHistoryChart";
import { ShopBadge } from "@app/shops/ui/components/ShopBadge";
import { StarWatchButton } from "@app/shops/ui/components/StarWatchButton";

interface MasterDetailProps {
    detail: MasterDetailType | undefined;
    history: PriceHistoryResponse | undefined;
    isLoading: boolean;
    isHistoryLoading: boolean;
}

export function MasterDetail({ detail, history, isLoading, isHistoryLoading }: MasterDetailProps) {
    if (isLoading || !detail) {
        return (
            <div className="space-y-6">
                <Skeleton className="h-48 w-full rounded" />
                <Skeleton className="h-72 w-full rounded" />
                <Skeleton className="h-64 w-full rounded" />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row gap-6 items-start">
                <div className="w-48 h-48 bg-zinc-900 border border-zinc-800 rounded overflow-hidden flex items-center justify-center shrink-0">
                    {detail.representative_image_url ? (
                        <img
                            src={detail.representative_image_url}
                            alt={detail.canonical_name}
                            className="w-full h-full object-contain"
                        />
                    ) : (
                        <ImageOff className="w-12 h-12 text-zinc-700" />
                    )}
                </div>
                <div className="flex-1 min-w-0 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <div className="font-mono text-[10px] tracking-[0.25em] text-muted-foreground uppercase mb-1">
                                {detail.brand ?? "no brand"} · {detail.master_category_name ?? "uncategorized"}
                            </div>
                            <h1 className="font-mono text-xl text-foreground leading-tight">{detail.canonical_name}</h1>
                        </div>
                        <StarWatchButton masterProductId={detail.id} />
                    </div>
                    <div className="flex flex-wrap items-end gap-4">
                        <div>
                            <div className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground uppercase">
                                Best Price
                            </div>
                            <div className="font-mono text-3xl text-[var(--color-neon-cyan)]">
                                {detail.best_price !== null ? `${detail.best_price.toFixed(2)} Kč` : "—"}
                            </div>
                        </div>
                        <ShopBadge origin={detail.best_price_shop} />
                        <div className="font-mono text-[10px] tracking-[0.15em] text-muted-foreground">
                            {detail.total_offers} shops
                        </div>
                    </div>
                    {detail.ean && (
                        <div className="font-mono text-[10px] tracking-[0.15em] text-muted-foreground">
                            EAN: <span className="text-foreground">{detail.ean}</span>
                        </div>
                    )}
                </div>
            </div>

            <PriceHistoryChart history={history} isLoading={isHistoryLoading} />

            <div>
                <h2 className="font-mono text-xs tracking-[0.25em] text-muted-foreground uppercase mb-3">
                    Cross-Shop Offers
                </h2>
                <CrossShopOffersTable offers={detail.offers} />
            </div>

            {detail.offers.length > 0 ? (
                <div>
                    <h2 className="font-mono text-xs tracking-[0.25em] text-muted-foreground uppercase mb-3">
                        Per-shop detail
                    </h2>
                    <OfferDetailTabs offers={detail.offers} />
                </div>
            ) : null}
        </div>
    );
}
