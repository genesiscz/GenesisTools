import { Badge } from "@app/utils/ui/components/badge";
import { Button } from "@app/utils/ui/components/button";
import { Card, CardContent } from "@app/utils/ui/components/card";
import type { Notification } from "@app/shops/db/NotificationsRepository";

interface Props {
    notification: Notification;
    onAck: (id: number) => void;
    onOpen: (masterId: number) => void;
}

export function NotificationCard({ notification, onAck, onOpen }: Props) {
    const acked = notification.acknowledged_at !== null;
    return (
        <Card className={acked ? "opacity-60 bg-zinc-950/40" : "bg-red-950/20 border-red-500/30"}>
            <CardContent className="py-3 px-4 flex items-center justify-between gap-4 font-mono">
                <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <Badge variant={acked ? "secondary" : "destructive"}>{notification.reason}</Badge>
                        <span className="text-zinc-300 text-sm">
                            {notification.shop_origin} · {notification.curr_price?.toFixed(2)} CZK
                        </span>
                    </div>
                    <span className="text-[10px] uppercase tracking-wider text-zinc-500">{notification.fired_at}</span>
                </div>
                <div className="flex gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => onOpen(notification.master_product_id)}>
                        Open
                    </Button>
                    {!acked && (
                        <Button size="sm" variant="outline" onClick={() => onAck(notification.id)}>
                            Acknowledge
                        </Button>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}
