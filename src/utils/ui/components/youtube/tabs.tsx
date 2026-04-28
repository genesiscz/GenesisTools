import { SafeJSON } from "@app/utils/json";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@app/utils/ui/components/tabs";
import { CommentsTab } from "@app/utils/ui/components/youtube/comments-tab";
import { InsightsTab } from "@app/utils/ui/components/youtube/insights-tab";
import { SummaryTab } from "@app/utils/ui/components/youtube/summary-tab";
import { TranscriptTab } from "@app/utils/ui/components/youtube/transcript-tab";
import type {
    AskCitation,
    JobStage,
    TimestampedSummaryEntry,
    Transcript,
    Video,
    VideoId,
    VideoLongSummary,
} from "@app/youtube/lib/types";
import { useEffect, useRef } from "react";

export type VideoDetailTab = "insights" | "summary" | "comments" | "transcript";

export interface RunPipeline {
    run: (stages: JobStage[]) => Promise<void>;
    isPending: boolean;
}

export interface VideoDetailDataSource {
    useVideo: (id: VideoId | null) => {
        data: { video: Video; transcripts?: Transcript[] } | undefined;
        isPending: boolean;
    };
    useTranscript: (
        id: VideoId | null,
        opts?: { lang?: string; source?: "captions" | "ai" }
    ) => { data: { transcript: Transcript } | undefined; isPending: boolean };
    useSummary: (
        id: VideoId | null,
        mode: "short" | "timestamped" | "long"
    ) => {
        data:
            | {
                  short?: string;
                  timestamped?: TimestampedSummaryEntry[];
                  long?: VideoLongSummary | null;
                  cached?: boolean;
              }
            | undefined;
        isPending: boolean;
    };
    useGenerateSummary: (id: VideoId) => {
        mutateAsync: (opts: {
            mode: "short" | "timestamped" | "long";
            force?: boolean;
            provider?: string;
            model?: string;
            targetBins?: number;
            tone?: "insightful" | "funny" | "actionable" | "controversial";
            format?: "list" | "qa";
            length?: "short" | "auto" | "detailed";
        }) => Promise<{
            short?: string;
            timestamped?: TimestampedSummaryEntry[];
            long?: VideoLongSummary | null;
            cached: boolean;
            jobId?: number;
        }>;
        isPending: boolean;
        error?: Error | null;
    };
    useAskVideo: (id: VideoId) => {
        mutateAsync: (vars: {
            question: string;
            topK?: number;
            provider?: string;
            model?: string;
        }) => Promise<{ answer: string; citations?: AskCitation[] }>;
        isPending: boolean;
    };
}

export interface VideoDetailTabsProps {
    videoId: VideoId;
    ds: VideoDetailDataSource;
    active: VideoDetailTab;
    onActiveChange: (tab: VideoDetailTab) => void;
    onSeek: (seconds: number) => void;
    runPipeline?: RunPipeline;
}

export function VideoDetailTabs({ videoId, ds, active, onActiveChange, onSeek, runPipeline }: VideoDetailTabsProps) {
    return (
        <Tabs
            value={active}
            onValueChange={(value) => onActiveChange(value as VideoDetailTab)}
            className="yt-panel rounded-3xl p-4"
        >
            <TabsList className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                <TabsTrigger value="insights">Insights</TabsTrigger>
                <TabsTrigger value="summary">Summary</TabsTrigger>
                <TabsTrigger value="comments">Comments</TabsTrigger>
                <TabsTrigger value="transcript">Transcript</TabsTrigger>
            </TabsList>
            <TabsContent value="insights">
                <InsightsTab
                    videoId={videoId}
                    onSeek={onSeek}
                    useSummary={ds.useSummary}
                    useGenerateSummary={ds.useGenerateSummary}
                />
            </TabsContent>
            <TabsContent value="summary">
                <SummaryTab videoId={videoId} useSummary={ds.useSummary} useGenerateSummary={ds.useGenerateSummary} />
            </TabsContent>
            <TabsContent value="comments">
                <CommentsTab />
            </TabsContent>
            <TabsContent value="transcript">
                <TranscriptTab
                    videoId={videoId}
                    onSeek={onSeek}
                    useTranscript={ds.useTranscript}
                    runPipeline={runPipeline}
                />
            </TabsContent>
        </Tabs>
    );
}

export function YouTubeIframe({ id, seekToSec }: { id: VideoId; seekToSec: number | null }) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);

    useEffect(() => {
        if (seekToSec === null) {
            return;
        }

        iframeRef.current?.contentWindow?.postMessage(
            SafeJSON.stringify({ event: "command", func: "seekTo", args: [seekToSec, true] }),
            "*"
        );
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
