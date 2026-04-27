import { createFileRoute } from "@tanstack/react-router";
import { VideoList } from "@yt/components/videos/video-list";
import type { ChannelHandle } from "@app/youtube/lib/types";

export const Route = createFileRoute("/channels/$handle")({
    component: ChannelDetailPage,
});

function ChannelDetailPage() {
    const { handle } = Route.useParams();

    return <VideoList handle={handle as ChannelHandle} />;
}
