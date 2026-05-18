import type { MasterListItem } from "@app/shops/types";
import { ShopBadge } from "@app/shops/ui/components/ShopBadge";
import { Card } from "@app/utils/ui/components/card";
import { chartSeriesPalette } from "@app/utils/ui/graphs/colors";
import { Link } from "@tanstack/react-router";
import { ImageOff } from "lucide-react";

interface BrowseCardProps {
    item: MasterListItem;
}

export function BrowseCard({ item }: BrowseCardProps) {
    const accent = chartSeriesPalette[(item.master_category_id ?? 0) % chartSeriesPalette.length];

    return (
        <Link
            to="/master/$id"
            params={{ id: String(item.id) }}
            className="group block focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 rounded"
        >
            <Card
                className="overflow-hidden transition-all duration-200 group-hover:-translate-y-0.5 group-hover:shadow-[0_12px_24px_rgba(34,211,238,0.18)]"
                style={{ borderBottom: `4px solid ${accent}` }}
            >
                <div className="relative aspect-square bg-muted overflow-hidden">
                    {item.representative_image_url ? (
                        <img
                            src={item.representative_image_url}
                            alt={item.canonical_name}
                            loading="lazy"
                            className="w-full h-full object-contain transition-transform duration-300 group-hover:scale-105 group-hover:brightness-110"
                        />
                    ) : (
                        <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                            <ImageOff className="w-8 h-8" />
                        </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 px-2 py-1.5 bg-gradient-to-t from-black/90 to-transparent translate-y-full group-hover:translate-y-0 transition-transform duration-200">
                        <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                            {item.brand ?? "no brand"}
                        </div>
                    </div>
                </div>
                <div className="px-3 py-2 flex flex-col gap-1.5">
                    <div className="font-mono text-xs leading-tight text-foreground line-clamp-2 min-h-[2.4em]">
                        {item.canonical_name}
                    </div>
                    <div className="flex items-center justify-between">
                        <div className="font-mono text-sm text-[var(--color-neon-cyan)]">
                            {item.best_price !== null ? `${item.best_price.toFixed(2)} Kč` : "—"}
                        </div>
                        <div className="flex items-center gap-1">
                            <ShopBadge origin={item.best_price_shop} />
                            <span className="font-mono text-[10px] text-muted-foreground">
                                {item.total_offers}× shops
                            </span>
                        </div>
                    </div>
                </div>
            </Card>
        </Link>
    );
}
