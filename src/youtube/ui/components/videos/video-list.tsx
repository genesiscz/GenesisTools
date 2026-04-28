import { Badge } from "@app/utils/ui/components/badge";
import { Button } from "@app/utils/ui/components/button";
import type { ChannelHandle } from "@app/youtube/lib/types";
import { useChannels, useSyncChannel, useVideos } from "@app/yt/api.hooks";
import { EmptyState } from "@app/yt/components/shared/empty-state";
import { Loading } from "@app/yt/components/shared/loading";
import { VideoCard } from "@app/yt/components/videos/video-card";
import { type VideoListFilterState, VideoListFilters } from "@app/yt/components/videos/video-list-filters";
import { formatDateTime, formatNumber } from "@app/yt/lib/format";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export function VideoList({ handle }: { handle: ChannelHandle }) {
    const [filters, setFilters] = useState<VideoListFilterState>({ since: "", limit: 30, includeShorts: false });
    const videos = useVideos({
        channel: handle,
        since: filters.since || undefined,
        limit: filters.limit,
        includeShorts: filters.includeShorts,
    });
    const channels = useChannels();
    const sync = useSyncChannel();
    const channel = channels.data?.find((item) => item.handle === handle);

    async function onSync() {
        await sync.mutateAsync({
            handle,
            since: filters.since || undefined,
            limit: filters.limit,
            includeShorts: filters.includeShorts,
        });
        toast.success(`Sync queued for ${handle}`);
    }

    if (videos.isPending || channels.isPending) {
        return <Loading label="Loading videos" />;
    }

    return (
        <div className="space-y-6">
            <header className="yt-panel rounded-3xl p-5">
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <div className="flex items-center gap-4">
                        {channel?.thumbUrl ? (
                            <img
                                src={channel.thumbUrl}
                                alt=""
                                className="size-16 rounded-full border border-primary/30 object-cover"
                            />
                        ) : (
                            <div className="grid size-16 place-items-center rounded-full border border-primary/30 bg-primary/10 text-primary">
                                {handle.slice(1, 3).toUpperCase()}
                            </div>
                        )}
                        <div>
                            <p className="font-mono text-xs uppercase tracking-[0.25em] text-secondary">{handle}</p>
                            <h1 className="text-3xl font-bold">{channel?.title ?? handle}</h1>
                            <div className="mt-2 flex flex-wrap gap-2">
                                <Badge variant="cyber-secondary">{formatNumber(channel?.subscriberCount)} subs</Badge>
                                <Badge variant="outline">synced {formatDateTime(channel?.lastSyncedAt)}</Badge>
                            </div>
                        </div>
                    </div>
                    <Button onClick={onSync} disabled={sync.isPending} className="btn-glow">
                        <RefreshCw className="mr-2 size-4" /> Sync
                    </Button>
                </div>
            </header>
            <VideoListFilters value={filters} onChange={setFilters} />
            {videos.data?.length === 0 ? (
                <EmptyState
                    title="No videos cached"
                    body="Run a sync to discover this channel's videos and transcripts."
                    cta={<Button onClick={onSync}>Sync now</Button>}
                />
            ) : (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {videos.data?.map((video) => (
                        <VideoCard key={video.id} video={video} />
                    ))}
                </div>
            )}
        </div>
    );
}
