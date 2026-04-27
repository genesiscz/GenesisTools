import { Badge } from "@app/utils/ui/components/badge";
import { Card, CardContent } from "@app/utils/ui/components/card";
import {
    type RunPipeline,
    type VideoDetailDataSource,
    type VideoDetailTab,
    VideoDetailTabs,
    YouTubeIframe,
} from "@app/utils/ui/components/youtube";
import type { JobStage, VideoId } from "@app/youtube/lib/types";
import {
    useAskVideo,
    useGenerateSummary,
    useStartPipeline,
    useSummary,
    useTranscript,
    useVideo,
} from "@app/yt/api.hooks";
import { ProgressBar } from "@app/yt/components/pipeline/progress-bar";
import { Loading } from "@app/yt/components/shared/loading";
import { formatDate, formatDuration, formatNumber } from "@app/yt/lib/format";
import { useEventStream } from "@app/yt/ws.client";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Captions, Eye, Radio } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

const videoDetailDataSource: VideoDetailDataSource = {
    useVideo,
    useTranscript,
    useSummary,
    useGenerateSummary,
    useAskVideo,
};

export const Route = createFileRoute("/videos/$id")({
    component: VideoDetailPage,
});

function VideoDetailPage() {
    const { id } = Route.useParams();
    const video = useVideo(id as VideoId);
    const [activeTab, setActiveTab] = useState<VideoDetailTab>("summary");
    const [seekToSec, setSeekToSec] = useState<number | null>(null);
    const [progress, setProgress] = useState(0);
    const [progressMessage, setProgressMessage] = useState<string | null>(null);
    const queryClient = useQueryClient();
    const startPipeline = useStartPipeline();
    const runPipeline = useMemo<RunPipeline>(
        () => ({
            isPending: startPipeline.isPending,
            run: async (stages: JobStage[]) => {
                try {
                    await startPipeline.mutateAsync({ target: id, targetKind: "video", stages });
                } catch (error) {
                    toast.error("Pipeline failed to start", {
                        description: error instanceof Error ? error.message : String(error),
                    });
                }
            },
        }),
        [id, startPipeline]
    );

    useEventStream({
        enabled: true,
        onEvent: (event) => {
            if (event.type === "job:started" || event.type === "stage:started") {
                setProgress(0.02);
                setProgressMessage("Starting…");
            }
            if (event.type === "stage:progress") {
                setProgress(event.progress);
                setProgressMessage(event.message ?? null);
            }
            if (event.type === "job:completed") {
                setProgress(1);
                setProgressMessage("Done");
                queryClient.invalidateQueries({ queryKey: ["video", id] });
                queryClient.invalidateQueries({ queryKey: ["summary", id] });
                queryClient.invalidateQueries({ queryKey: ["transcript", id] });
            }
            if (event.type === "job:failed") {
                setProgressMessage("Failed");
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
        return (
            <Card className="yt-panel">
                <CardContent className="p-8">Video not found.</CardContent>
            </Card>
        );
    }

    return (
        <div className="grid grid-cols-12 gap-6">
            <section className="col-span-12 space-y-4 lg:col-span-7">
                <YouTubeIframe id={id as VideoId} seekToSec={seekToSec} />
                <header className="yt-panel rounded-3xl p-5">
                    <p className="font-mono text-xs uppercase tracking-[0.28em] text-secondary">
                        {video.data.video.channelHandle}
                    </p>
                    <h1 className="mt-2 text-2xl font-bold leading-tight">{video.data.video.title}</h1>
                    <div className="mt-3 flex flex-wrap gap-2">
                        <Badge variant="outline">
                            <Radio className="size-3" /> {formatDate(video.data.video.uploadDate)}
                        </Badge>
                        <Badge variant="outline">{formatDuration(video.data.video.durationSec)}</Badge>
                        <Badge variant="outline">
                            <Eye className="size-3" /> {formatNumber(video.data.video.viewCount)}
                        </Badge>
                        <Badge variant={video.data.transcripts.length > 0 ? "cyber-secondary" : "outline"}>
                            <Captions className="size-3" /> {video.data.transcripts.length} transcript
                            {video.data.transcripts.length === 1 ? "" : "s"}
                        </Badge>
                    </div>
                </header>
                <ProgressBar videoId={id as VideoId} value={progress} message={progressMessage} />
            </section>
            <aside className="col-span-12 lg:col-span-5">
                <VideoDetailTabs
                    videoId={id as VideoId}
                    ds={videoDetailDataSource}
                    active={activeTab}
                    onActiveChange={setActiveTab}
                    onSeek={setSeekToSec}
                    runPipeline={runPipeline}
                />
            </aside>
        </div>
    );
}
