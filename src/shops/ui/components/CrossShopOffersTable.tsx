import type { MasterOfferRow } from "@app/shops/types";
import { Badge } from "@app/utils/ui/components/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@app/utils/ui/components/table";
import { ExternalLink } from "lucide-react";
import { ShopBadge } from "./ShopBadge";

interface CrossShopOffersTableProps {
    offers: MasterOfferRow[];
}

export function CrossShopOffersTable({ offers }: CrossShopOffersTableProps) {
    if (offers.length === 0) {
        return (
            <div className="border border-dashed border-zinc-800 rounded p-8 text-center font-mono text-xs tracking-[0.2em] text-muted-foreground uppercase">
                no offers
            </div>
        );
    }

    const bestPrice = Math.min(...offers.filter((o) => o.current_price !== null).map((o) => o.current_price as number));

    return (
        <div className="border border-zinc-800 rounded-md overflow-hidden">
            <Table>
                <TableHeader>
                    <TableRow className="font-mono text-[10px] tracking-[0.2em] uppercase">
                        <TableHead>Shop</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead className="text-right">Price</TableHead>
                        <TableHead className="text-right">Original</TableHead>
                        <TableHead className="text-right">Disc.</TableHead>
                        <TableHead>Stock</TableHead>
                        <TableHead className="text-right">Open</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {offers.map((offer) => {
                        const isBest = offer.current_price === bestPrice;
                        return (
                            <TableRow
                                key={offer.product_id}
                                className={
                                    isBest
                                        ? "bg-cyan-500/5 hover:bg-cyan-500/10 transition-colors"
                                        : "hover:bg-white/5 transition-colors"
                                }
                            >
                                <TableCell>
                                    <ShopBadge origin={offer.shop_origin} label={offer.shop_display_name} />
                                </TableCell>
                                <TableCell className="font-mono text-xs max-w-md truncate" title={offer.name}>
                                    {offer.name}
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm">
                                    {offer.current_price !== null ? (
                                        <span className={isBest ? "text-[var(--color-neon-cyan)]" : ""}>
                                            {offer.current_price.toFixed(2)} Kč
                                        </span>
                                    ) : (
                                        <span className="text-muted-foreground">—</span>
                                    )}
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs text-muted-foreground line-through">
                                    {offer.original_price !== null ? `${offer.original_price.toFixed(2)} Kč` : ""}
                                </TableCell>
                                <TableCell className="text-right">
                                    {offer.claimed_discount_percent !== null ? (
                                        <Badge
                                            variant="outline"
                                            className="font-mono text-[10px] border-amber-400/40 text-amber-300"
                                        >
                                            -{offer.claimed_discount_percent.toFixed(0)}%
                                        </Badge>
                                    ) : null}
                                </TableCell>
                                <TableCell>
                                    {offer.in_stock === 1 ? (
                                        <span className="font-mono text-[10px] text-emerald-400 tracking-[0.15em]">
                                            IN STOCK
                                        </span>
                                    ) : offer.in_stock === 0 ? (
                                        <span className="font-mono text-[10px] text-rose-400 tracking-[0.15em]">
                                            OUT
                                        </span>
                                    ) : (
                                        <span className="font-mono text-[10px] text-muted-foreground">—</span>
                                    )}
                                </TableCell>
                                <TableCell className="text-right">
                                    <a
                                        href={offer.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 font-mono text-[10px] text-[var(--color-neon-cyan)] hover:underline"
                                    >
                                        <ExternalLink className="w-3 h-3" />
                                        BUY
                                    </a>
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </div>
    );
}
