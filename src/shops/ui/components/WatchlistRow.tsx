import type { FavoriteWithState } from "@app/shops/db/FavoritesRepository";
import type { Notification } from "@app/shops/db/NotificationsRepository";
import { PriceSparkline } from "@app/shops/ui/components/PriceSparkline";
import { Badge } from "@app/utils/ui/components/badge";
import { Button } from "@app/utils/ui/components/button";
import { TableCell, TableRow } from "@app/utils/ui/components/table";
import { cn } from "@app/utils/ui/lib/utils";

interface Props {
    row: FavoriteWithState;
    pendingNotifications: Notification[];
    sparklinePoints: Array<{ d: string; c: number | null }>;
    onAck: (notificationId: number) => void;
    onSnooze: (favoriteId: number) => void;
    onRemove: (favoriteId: number) => void;
    onOpen: (masterId: number) => void;
}

export function WatchlistRow({ row, pendingNotifications, sparklinePoints, onAck, onSnooze, onRemove, onOpen }: Props) {
    const alerting = pendingNotifications.length > 0;
    const buyUrl = pendingNotifications[0]?.shop_origin ? `https://www.${pendingNotifications[0].shop_origin}` : null;
    return (
        <TableRow
            className={cn(
                "transition-all hover:-translate-y-px font-mono",
                alerting && "bg-red-950/20 border-l-4 !border-l-red-500"
            )}
        >
            <TableCell className="w-8">
                {alerting && (
                    <Badge variant="destructive" className="px-1.5">
                        ✦
                    </Badge>
                )}
            </TableCell>
            <TableCell>
                <div className="flex flex-col">
                    <span className="text-zinc-100 font-medium">{row.label ?? `master#${row.master_product_id}`}</span>
                    <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                        {row.restricted_to_shop ? `[${row.restricted_to_shop} only]` : "[any shop]"}
                    </span>
                </div>
            </TableCell>
            <TableCell className="text-right text-zinc-300">
                {row.target_price !== null ? row.target_price.toFixed(2) : "—"}
            </TableCell>
            <TableCell className="text-right">
                {row.best_price !== null ? (
                    <span>
                        <span className="text-cyan-300 font-medium">{row.best_price.toFixed(2)}</span>
                        <span className="text-zinc-500 text-[10px] ml-1">{row.best_shop}</span>
                    </span>
                ) : (
                    <span className="text-zinc-500">no offer</span>
                )}
            </TableCell>
            <TableCell className="text-right">
                {row.delta_percent !== null && row.delta_percent !== 0 ? (
                    <span className={cn(row.delta_percent > 0 ? "text-emerald-300" : "text-zinc-400")}>
                        {(row.delta_percent * 100).toFixed(1)}%
                    </span>
                ) : (
                    <span className="text-zinc-500">—</span>
                )}
            </TableCell>
            <TableCell className="w-32">
                <PriceSparkline points={sparklinePoints} />
            </TableCell>
            <TableCell className="w-32">
                <span
                    className={`text-[11px] font-mono ${
                        row.last_observed_at && Date.now() - new Date(row.last_observed_at).getTime() < 24 * 3_600_000
                            ? "text-muted-foreground"
                            : "text-zinc-500"
                    }`}
                >
                    {row.last_observed_at ? `${relativeTime(row.last_observed_at)} ago` : "never"}
                </span>
            </TableCell>
            <TableCell className="w-20 text-center">
                <Badge variant={row.shops_covered > 0 ? "secondary" : "outline"} className="text-[9px] tracking-widest">
                    {row.shops_covered}
                </Badge>
            </TableCell>
            <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => onOpen(row.master_product_id)}>
                        Open
                    </Button>
                    {alerting && buyUrl && (
                        <Button size="sm" variant="default" asChild>
                            <a href={buyUrl} target="_blank" rel="noreferrer">
                                Buy
                            </a>
                        </Button>
                    )}

                    {alerting && (
                        <Button size="sm" variant="outline" onClick={() => onSnooze(row.id)}>
                            Snooze 7d
                        </Button>
                    )}

                    {alerting && pendingNotifications[0] && (
                        <Button size="sm" variant="outline" onClick={() => onAck(pendingNotifications[0].id)}>
                            Ack
                        </Button>
                    )}

                    {!alerting && (
                        <Button size="sm" variant="ghost" onClick={() => onRemove(row.id)}>
                            Remove
                        </Button>
                    )}
                </div>
            </TableCell>
        </TableRow>
    );
}

function relativeTime(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    const h = Math.floor(ms / 3_600_000);
    if (h < 1) {
        return `${Math.max(1, Math.floor(ms / 60_000))}m`;
    }

    if (h < 48) {
        return `${h}h`;
    }

    return `${Math.floor(h / 24)}d`;
}
