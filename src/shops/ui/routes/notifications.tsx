import { Button } from "@app/utils/ui/components/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { BellOff } from "lucide-react";
import type { Notification } from "@app/shops/db/NotificationsRepository";
import { EmptyState } from "@app/shops/ui/components/EmptyState";
import { NotificationCard } from "@app/shops/ui/components/NotificationCard";

export const Route = createFileRoute("/notifications")({
    component: NotificationsPage,
});

function NotificationsPage() {
    const queryClient = useQueryClient();
    const router = useRouter();
    const data = useQuery({
        queryKey: ["notifications", "all"],
        queryFn: async () => (await fetch("/api/notifications?limit=100")).json() as Promise<Notification[]>,
    });
    const ack = useMutation({
        mutationFn: async (id: number) => fetch(`/api/notifications/${id}/ack`, { method: "POST" }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
    });
    const ackAll = useMutation({
        mutationFn: async () => fetch(`/api/notifications/all/ack`, { method: "POST" }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
    });
    const rows = data.data ?? [];
    const pending = rows.filter((r) => !r.acknowledged_at).length;
    return (
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-5">
            <div className="flex items-center justify-between gap-3">
                <h1 className="font-mono tracking-[0.3em] text-sm text-muted-foreground uppercase">
                    Alerts ::{" "}
                    <span className="text-foreground">
                        {pending} pending · {rows.length} total
                    </span>
                </h1>
                <Button size="sm" variant="outline" onClick={() => ackAll.mutate()} disabled={pending === 0}>
                    Ack all
                </Button>
            </div>
            {rows.length === 0 ? (
                <EmptyState
                    icon={<BellOff />}
                    title="No alerts"
                    body="Watchlist alerts fire when a tracked product hits its target price or moves outside the cooldown. Add a watch on /watchlist to start receiving notifications."
                />
            ) : (
                <div className="grid gap-2">
                    {rows.map((n) => (
                        <NotificationCard
                            key={n.id}
                            notification={n}
                            onAck={(id) => ack.mutate(id)}
                            onOpen={(masterId) => router.navigate({ to: `/master/${masterId}` })}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
