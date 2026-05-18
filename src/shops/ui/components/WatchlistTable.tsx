import type { FavoriteWithState } from "@app/shops/db/FavoritesRepository";
import type { Notification } from "@app/shops/db/NotificationsRepository";
import { WatchlistRow } from "@app/shops/ui/components/WatchlistRow";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@app/utils/ui/components/table";

interface Props {
    rows: FavoriteWithState[];
    notifications: Notification[];
    sparklines: Record<number, Array<{ d: string; c: number | null }>>;
    onAck: (notificationId: number) => void;
    onSnooze: (favoriteId: number) => void;
    onRemove: (favoriteId: number) => void;
    onOpen: (masterId: number) => void;
}

export function WatchlistTable({ rows, notifications, sparklines, onAck, onSnooze, onRemove, onOpen }: Props) {
    const byFavorite = new Map<number, Notification[]>();
    for (const n of notifications) {
        if (n.acknowledged_at) {
            continue;
        }

        const bucket = byFavorite.get(n.favorite_id) ?? [];
        bucket.push(n);
        byFavorite.set(n.favorite_id, bucket);
    }

    return (
        <Table>
            <TableHeader>
                <TableRow className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    <TableHead className="w-8">★</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Target</TableHead>
                    <TableHead className="text-right">Current</TableHead>
                    <TableHead className="text-right">Δ</TableHead>
                    <TableHead>Sparkline</TableHead>
                    <TableHead className="w-32">Last seen</TableHead>
                    <TableHead className="w-20 text-center">Shops</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {rows.map((r) => (
                    <WatchlistRow
                        key={r.id}
                        row={r}
                        pendingNotifications={byFavorite.get(r.id) ?? []}
                        sparklinePoints={sparklines[r.master_product_id] ?? []}
                        onAck={onAck}
                        onSnooze={onSnooze}
                        onRemove={onRemove}
                        onOpen={onOpen}
                    />
                ))}
            </TableBody>
        </Table>
    );
}
