import { Button } from "@app/utils/ui/components/button";
import type { ChannelHandle } from "@app/youtube/lib/types";
import { useToggleWatchlist, useWatchlist } from "@app/yt/api.hooks";
import { VideoList } from "@app/yt/components/videos/video-list";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/channels/$handle")({
    component: ChannelDetailPage,
});

function ChannelDetailPage() {
    const { handle } = Route.useParams();
    const watchlist = useWatchlist();
    const toggle = useToggleWatchlist();
    const followed = (watchlist.data ?? []).some((entry) => entry.channelHandle === handle);

    return (
        <div className="space-y-3">
            <div className="flex justify-end">
                <Button
                    size="sm"
                    variant={followed ? "outline" : "default"}
                    disabled={toggle.isPending}
                    onClick={() => toggle.mutate({ handle, follow: !followed })}
                >
                    {followed ? "Unfollow" : "Follow"}
                </Button>
            </div>
            <VideoList handle={handle as ChannelHandle} />
        </div>
    );
}
