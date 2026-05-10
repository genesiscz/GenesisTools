import type { FavoriteWithState } from "@app/shops/db/FavoritesRepository";
import type { Notification } from "@app/shops/db/NotificationsRepository";
import { FilterPills, type WatchlistFilter } from "@app/shops/ui/components/FilterPills";
import { PasteUrlQuickAdd } from "@app/shops/ui/components/PasteUrlQuickAdd";
import { WatchlistTable } from "@app/shops/ui/components/WatchlistTable";
import { useSseStream } from "@app/shops/ui/hooks/useSseStream";
import { SafeJSON } from "@app/utils/json";
import { Card, CardContent, CardHeader, CardTitle } from "@app/utils/ui/components/card";
import { Input } from "@app/utils/ui/components/input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/watchlist")({
    component: WatchlistPage,
});

interface NotificationFiredPayload {
    id: number;
    favorite_id: number;
    title: string;
    body: string;
    detailUrl: string;
}

const SSE_EVENTS = ["notification-fired"] as const;

function WatchlistPage() {
    const queryClient = useQueryClient();
    const router = useRouter();
    const [filter, setFilter] = useState<WatchlistFilter>("all");
    const [query, setQuery] = useState("");

    const watchlist = useQuery({
        queryKey: ["watchlist"],
        queryFn: async () => (await fetch("/api/watchlist")).json() as Promise<FavoriteWithState[]>,
    });
    const notifications = useQuery({
        queryKey: ["notifications", "unacked"],
        queryFn: async () => (await fetch("/api/notifications?only_unacked=1")).json() as Promise<Notification[]>,
    });

    useSseStream({
        url: "/api/events",
        events: SSE_EVENTS,
        onBatch: (batch) => {
            for (const frame of batch) {
                if (frame.type === "notification-fired") {
                    const payload = frame.data as NotificationFiredPayload;
                    queryClient.invalidateQueries({ queryKey: ["watchlist"] });
                    queryClient.invalidateQueries({ queryKey: ["notifications", "unacked"] });
                    toast.success(payload.title, {
                        description: payload.body,
                        action: { label: "Open", onClick: () => router.navigate({ to: payload.detailUrl }) },
                    });
                }
            }
        },
    });

    const ack = useMutation({
        mutationFn: async (id: number) => fetch(`/api/notifications/${id}/ack`, { method: "POST" }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications", "unacked"] }),
    });
    const remove = useMutation({
        mutationFn: async (id: number) => fetch(`/api/watchlist/${id}/delete`, { method: "POST" }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["watchlist"] }),
    });
    const snooze = useMutation({
        mutationFn: async (favoriteId: number) =>
            fetch(`/api/watchlist/${favoriteId}/edit`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ cooldown_hours: 24 * 7 }),
            }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["watchlist"] }),
    });

    const rows = watchlist.data ?? [];
    const notifs = notifications.data ?? [];
    const alertingFavoriteIds = useMemo(
        () => new Set(notifs.filter((n) => !n.acknowledged_at).map((n) => n.favorite_id)),
        [notifs]
    );
    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return rows.filter((r) => {
            if (filter === "alerting" && !alertingFavoriteIds.has(r.id)) {
                return false;
            }

            if (filter === "quiet" && alertingFavoriteIds.has(r.id)) {
                return false;
            }

            if (q && !`${r.label ?? ""} ${r.master_product_id}`.toLowerCase().includes(q)) {
                return false;
            }

            return true;
        });
    }, [rows, filter, query, alertingFavoriteIds]);

    const counts: Record<WatchlistFilter, number> = {
        all: rows.length,
        alerting: rows.filter((r) => alertingFavoriteIds.has(r.id)).length,
        quiet: rows.filter((r) => !alertingFavoriteIds.has(r.id)).length,
    };

    return (
        <div className="px-6 py-4 space-y-4">
            <div className="sticky top-14 z-20 backdrop-blur bg-zinc-950/80 border-b border-zinc-800/60 py-3 flex items-center gap-4">
                <PasteUrlQuickAdd />
                <FilterPills value={filter} onChange={setFilter} counts={counts} />
                <Input
                    placeholder="Search label / id..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="w-56 font-mono bg-zinc-950/60 border-zinc-700"
                />
            </div>
            <Card className="bg-zinc-950/40">
                <CardHeader>
                    <CardTitle className="font-mono uppercase tracking-wider text-xs text-zinc-400">
                        Watchlist · {filtered.length}/{rows.length}
                    </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                    <WatchlistTable
                        rows={filtered}
                        notifications={notifs}
                        sparklines={{}}
                        onAck={(id) => ack.mutate(id)}
                        onSnooze={(favId) => snooze.mutate(favId)}
                        onRemove={(favId) => remove.mutate(favId)}
                        onOpen={(masterId) => router.navigate({ to: `/master/${masterId}` })}
                    />
                </CardContent>
            </Card>
        </div>
    );
}
