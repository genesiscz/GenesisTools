import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@app/utils/ui/components/badge";
import { Card, CardContent } from "@app/utils/ui/components/card";
import { ProgressBar } from "@app/yt/components/pipeline/progress-bar";
import { Loading } from "@app/yt/components/shared/loading";
import { VideoDetailTabs, type VideoDetailTab } from "@app/yt/components/video-detail/tabs";
import { formatDate, formatDuration, formatNumber } from "@app/yt/lib/format";
import { useVideo } from "@app/yt/api.hooks";
import { useEventStream } from "@app/yt/ws.client";
import type { VideoId } from "@app/youtube/lib/types";
import { Captions, Eye, Radio } from "lucide-react";

export const Route = createFileRoute("/videos/$id")({
    component: VideoDetailPage,
});

function VideoDetailPage() {
    const { id } = Route.useParams();
    const video = useVideo(id as VideoId);
    const [activeTab, setActiveTab] = useState<VideoDetailTab>("summary");
    const [seekToSec, setSeekToSec] = useState<number | null>(null);
    const [progress, setProgress] = useState(0);
    const queryClient = useQueryClient();

    useEventStream({
        enabled: true,
        onEvent: (event) => {
            if (event.type === "stage:progress") {
                setProgress(event.progress);
            }
            if (event.type === "job:completed" || event.type === "job:failed") {
                queryClient.invalidateQueries({ queryKey: ["video", id] });
                queryClient.invalidateQueries({ queryKey: ["summary", id] });
                queryClient.invalidateQueries({ queryKey: ["transcript", id] });
            }
        },
    });

    if (video.isPending) {
        return <Loading label="Loading video" />;
    }

    if (!video.data) {
        return <Card className="yt-panel"><CardContent className="p-8">Video not found.</CardContent></Card>;
    }

    return (
        <div className="grid grid-cols-12 gap-6">
            <section className="col-span-12 space-y-4 lg:col-span-7">
                <YouTubeIframe id={id as VideoId} seekToSec={seekToSec} />
                <header className="yt-panel rounded-3xl p-5">
                    <p className="font-mono text-xs uppercase tracking-[0.28em] text-secondary">{video.data.video.channelHandle}</p>
                    <h1 className="mt-2 text-2xl font-bold leading-tight">{video.data.video.title}</h1>
                    <div className="mt-3 flex flex-wrap gap-2">
                        <Badge variant="outline"><Radio className="size-3" /> {formatDate(video.data.video.uploadDate)}</Badge>
                        <Badge variant="outline">{formatDuration(video.data.video.durationSec)}</Badge>
                        <Badge variant="outline"><Eye className="size-3" /> {formatNumber(video.data.video.viewCount)}</Badge>
                        <Badge variant={video.data.transcripts.length > 0 ? "cyber-secondary" : "outline"}>
                            <Captions className="size-3" /> {video.data.transcripts.length} transcript{video.data.transcripts.length === 1 ? "" : "s"}
                        </Badge>
                    </div>
                </header>
                <ProgressBar videoId={id as VideoId} value={progress} />
            </section>
            <aside className="col-span-12 lg:col-span-5">
                <VideoDetailTabs videoId={id as VideoId} active={activeTab} onActiveChange={setActiveTab} onSeek={setSeekToSec} />
            </aside>
        </div>
    );
}

function YouTubeIframe({ id, seekToSec }: { id: VideoId; seekToSec: number | null }) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);

    useEffect(() => {
        if (seekToSec === null) {
            return;
        }

        iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: "command", func: "seekTo", args: [seekToSec, true] }), "*");
    }, [seekToSec]);

    return (
        <div className="yt-panel overflow-hidden rounded-3xl p-2">
            <div className="aspect-video overflow-hidden rounded-2xl bg-black">
                <iframe
                    ref={iframeRef}
                    title="YouTube player"
                    src={`https://www.youtube.com/embed/${encodeURIComponent(id)}?enablejsapi=1`}
                    className="h-full w-full"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowFullScreen
                />
            </div>
        </div>
    );
}
