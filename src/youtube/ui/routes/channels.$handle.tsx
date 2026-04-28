import type { ChannelHandle } from "@app/youtube/lib/types";
import { VideoList } from "@app/yt/components/videos/video-list";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/channels/$handle")({
    component: ChannelDetailPage,
});

function ChannelDetailPage() {
    const { handle } = Route.useParams();

    return <VideoList handle={handle as ChannelHandle} />;
}
