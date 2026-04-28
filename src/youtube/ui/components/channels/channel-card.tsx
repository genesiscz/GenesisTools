import { Badge } from "@app/utils/ui/components/badge";
import { Button } from "@app/utils/ui/components/button";
import { Card, CardContent } from "@app/utils/ui/components/card";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@app/utils/ui/components/dropdown-menu";
import type { Channel } from "@app/youtube/lib/types";
import { useRemoveChannel, useSyncChannel } from "@app/yt/api.hooks";
import { formatDateTime, formatNumber } from "@app/yt/lib/format";
import { useNavigate } from "@tanstack/react-router";
import { MoreVertical, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

export function ChannelCard({ channel }: { channel: Channel }) {
    const navigate = useNavigate();
    const sync = useSyncChannel();
    const remove = useRemoveChannel();

    async function onSync() {
        await sync.mutateAsync({ handle: channel.handle });
        toast.success(`Sync queued for ${channel.handle}`);
    }

    async function onRemove() {
        await remove.mutateAsync(channel.handle);
        toast.success(`${channel.handle} removed`);
    }

    return (
        <Card className="yt-panel yt-card-hover group overflow-hidden">
            <CardContent className="space-y-4 p-5">
                <div className="flex items-start justify-between gap-3">
                    <button
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        onClick={() => navigate({ to: "/channels/$handle", params: { handle: channel.handle } })}
                    >
                        {channel.thumbUrl ? (
                            <img
                                src={channel.thumbUrl}
                                alt=""
                                className="size-14 rounded-full border border-primary/30 object-cover"
                            />
                        ) : (
                            <div className="grid size-14 place-items-center rounded-full border border-primary/30 bg-primary/10 font-mono text-lg text-primary">
                                {channel.handle.slice(1, 3).toUpperCase()}
                            </div>
                        )}
                        <div className="min-w-0">
                            <h3 className="truncate text-lg font-semibold">{channel.title ?? channel.handle}</h3>
                            <p className="font-mono text-xs text-secondary">{channel.handle}</p>
                        </div>
                    </button>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="opacity-70 transition-opacity group-hover:opacity-100"
                            >
                                <MoreVertical className="size-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={onSync}>
                                <RefreshCw className="size-4" /> Sync
                            </DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onClick={onRemove}>
                                <Trash2 className="size-4" /> Remove
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Badge variant="cyber-secondary">{formatNumber(channel.subscriberCount)} subs</Badge>
                    <Badge variant="outline">synced {formatDateTime(channel.lastSyncedAt)}</Badge>
                </div>
            </CardContent>
        </Card>
    );
}
