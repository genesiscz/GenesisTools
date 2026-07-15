import { SafeJSON } from "@app/utils/json";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@app/utils/ui/components/tabs";
import { AskTab } from "@app/utils/ui/components/youtube/ask-tab";
import { CommentsTab } from "@app/utils/ui/components/youtube/comments-tab";
import { InsightsTab } from "@app/utils/ui/components/youtube/insights-tab";
import type { ModelPreset } from "@app/utils/ui/components/youtube/llm-confirm-dialog";
import { SummaryTab } from "@app/utils/ui/components/youtube/summary-tab";
import { TranscriptTab } from "@app/utils/ui/components/youtube/transcript-tab";
import type {
    AskCitation,
    JobStage,
    LlmEstimate,
    TimestampedSummaryEntry,
    Transcript,
    Video,
    VideoComment,
    VideoId,
    VideoLongSummary,
} from "@app/youtube/lib/types";
import { useEffect, useRef } from "react";

export type VideoDetailTab = "insights" | "summary" | "ask" | "comments" | "transcript";

export interface RunPipeline {
    run: (stages: JobStage[]) => Promise<void>;
    isPending: boolean;
}

/** Live progress of a running pipeline job for this video (from WS job events). */
export interface PipelineProgress {
    progress: number;
    message: string | null;
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
    useComments: (id: VideoId | null) => {
        data: { comments: VideoComment[] } | undefined;
        isPending: boolean;
    };
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
    /** Pre-flight cost estimate (`/videos/:id/estimate`). Optional — consumers
     *  without it fall back to generic billing copy in the confirm dialog. */
    useEstimate?: (
        id: VideoId | null,
        opts: { mode: "short" | "timestamped" | "long"; provider?: string; model?: string; enabled?: boolean }
    ) => { data: LlmEstimate | undefined; isPending: boolean };
}

export interface VideoDetailTabsProps {
    videoId: VideoId;
    ds: VideoDetailDataSource;
    active: VideoDetailTab;
    onActiveChange: (tab: VideoDetailTab) => void;
    onSeek: (seconds: number) => void;
    runPipeline?: RunPipeline;
    /** Drop the outer `.yt-panel` wrapper — for consumers providing their own surface (e.g. the extension side panel). */
    chromeless?: boolean;
    /** Dev mode: expose provider/model override inputs in the LLM confirm dialog. */
    devMode?: boolean;
    /** Server-detected provider/model matrix for the dev-mode picker. */
    modelPresets?: ModelPreset[];
    /** Live progress of a running job for this video — drives button spinners + dialog progress. */
    pipelineProgress?: PipelineProgress | null;
}

export function VideoDetailTabs({
    videoId,
    ds,
    active,
    onActiveChange,
    onSeek,
    runPipeline,
    chromeless,
    devMode,
    modelPresets,
    pipelineProgress,
}: VideoDetailTabsProps) {
    return (
        <Tabs
            value={active}
            onValueChange={(value) => onActiveChange(value as VideoDetailTab)}
            className={chromeless ? "yt-tabs-root p-4" : "yt-tabs-root yt-panel rounded-3xl p-4"}
        >
            <TabsList className="grid grid-cols-3 gap-2 lg:grid-cols-5">
                <TabsTrigger value="insights">Insights</TabsTrigger>
                <TabsTrigger value="summary">Summary</TabsTrigger>
                <TabsTrigger value="ask">Ask</TabsTrigger>
                <TabsTrigger value="comments">Comments</TabsTrigger>
                <TabsTrigger value="transcript">Transcript</TabsTrigger>
            </TabsList>
            <TabsContent value="insights" className="yt-tab-pane">
                <InsightsTab
                    videoId={videoId}
                    onSeek={onSeek}
                    useSummary={ds.useSummary}
                    useGenerateSummary={ds.useGenerateSummary}
                    useEstimate={ds.useEstimate}
                    devMode={devMode}
                    modelPresets={modelPresets}
                    pipelineProgress={pipelineProgress}
                />
            </TabsContent>
            <TabsContent value="summary" className="yt-tab-pane">
                <SummaryTab
                    videoId={videoId}
                    useSummary={ds.useSummary}
                    useGenerateSummary={ds.useGenerateSummary}
                    useEstimate={ds.useEstimate}
                    devMode={devMode}
                    modelPresets={modelPresets}
                    pipelineProgress={pipelineProgress}
                />
            </TabsContent>
            <TabsContent value="ask" className="yt-tab-pane">
                <AskTab videoId={videoId} onSeek={onSeek} useAskVideo={ds.useAskVideo} />
            </TabsContent>
            <TabsContent value="comments" className="yt-tab-pane">
                <CommentsTab
                    videoId={videoId}
                    useComments={ds.useComments}
                    runPipeline={runPipeline}
                    pipelineProgress={pipelineProgress}
                />
            </TabsContent>
            <TabsContent value="transcript" className="yt-tab-pane">
                <TranscriptTab
                    videoId={videoId}
                    onSeek={onSeek}
                    useTranscript={ds.useTranscript}
                    runPipeline={runPipeline}
                    pipelineProgress={pipelineProgress}
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
