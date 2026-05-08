import { Button } from "@app/utils/ui/components/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import type { Notification } from "../../db/NotificationsRepository";
import { NotificationCard } from "../components/NotificationCard";

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
        <div className="px-6 py-4 space-y-4">
            <div className="flex items-center justify-between">
                <h2 className="font-display text-lg text-zinc-200">
                    Notifications · <span className="text-cyan-300">{pending}</span> pending
                </h2>
                <Button size="sm" variant="outline" onClick={() => ackAll.mutate()} disabled={pending === 0}>
                    Ack all
                </Button>
            </div>
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
        </div>
    );
}
