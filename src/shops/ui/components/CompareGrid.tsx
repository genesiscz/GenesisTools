import type { CompareResponse } from "@app/shops/types";
import { CrossShopOffersTable } from "@app/shops/ui/components/CrossShopOffersTable";
import { ShopBadge } from "@app/shops/ui/components/ShopBadge";
import { Card, CardContent, CardHeader, CardTitle } from "@app/utils/ui/components/card";
import { ImageOff } from "lucide-react";

interface CompareGridProps {
    data: CompareResponse | undefined;
    isLoading: boolean;
}

export function CompareGrid({ data, isLoading }: CompareGridProps) {
    if (isLoading || !data) {
        return <div className="font-mono text-xs text-muted-foreground tracking-[0.15em] uppercase">loading…</div>;
    }

    if (data.items.length === 0) {
        return (
            <div className="font-mono text-xs text-muted-foreground tracking-[0.15em] uppercase border border-dashed border-border rounded-md p-12 text-center">
                no master products match the requested ids
            </div>
        );
    }

    return (
        <div className={`grid gap-4 ${data.items.length > 1 ? "lg:grid-cols-2" : ""}`}>
            {data.items.map((item) => (
                <Card key={item.id}>
                    <CardHeader className="flex flex-row items-start gap-3 pb-3">
                        <div className="w-20 h-20 bg-muted border border-border rounded overflow-hidden flex items-center justify-center shrink-0">
                            {item.representative_image_url ? (
                                <img
                                    src={item.representative_image_url}
                                    alt={item.canonical_name}
                                    className="w-full h-full object-contain"
                                />
                            ) : (
                                <ImageOff className="w-6 h-6 text-muted-foreground" />
                            )}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground uppercase mb-1">
                                {item.brand ?? "no brand"}
                            </div>
                            <CardTitle className="font-mono text-sm leading-tight">{item.canonical_name}</CardTitle>
                            <div className="flex items-end gap-2 mt-2">
                                <span className="font-mono text-2xl text-[var(--color-neon-cyan)]">
                                    {item.best_price !== null ? `${item.best_price.toFixed(2)} Kč` : "—"}
                                </span>
                                <ShopBadge origin={item.best_price_shop} />
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent>
                        <CrossShopOffersTable offers={item.offers} />
                    </CardContent>
                </Card>
            ))}
        </div>
    );
}
