import { SafeJSON } from "@app/utils/json";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@app/utils/ui/components/tabs";
import { AskTab } from "@app/utils/ui/components/youtube/ask-tab";
import { CommentsTab } from "@app/utils/ui/components/youtube/comments-tab";
import { InsightsTab } from "@app/utils/ui/components/youtube/insights-tab";
import type { ModelPreset } from "@app/utils/ui/components/youtube/llm-confirm-dialog";
import { scrollIntoPanelView } from "@app/utils/ui/components/youtube/scroll";
import { SummaryTab } from "@app/utils/ui/components/youtube/summary-tab";
import { TranscriptTab } from "@app/utils/ui/components/youtube/transcript-tab";
import type {
    AskCitation,
    JobStage,
    LlmEstimate,
    LockedArtifact,
    PresetKind,
    PromptPreset,
    QaHistoryItem,
    QaSource,
    QueueStats,
    SummaryMode,
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
    ) => {
        data: { transcript: Transcript; speakerLabels?: Record<number, string> } | undefined;
        isPending: boolean;
    };
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
                  /** 2-letter ISO language the stored summary was generated in. */
                  lang?: string;
                  cached?: boolean;
                  locked?: undefined;
              }
            | LockedArtifact
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
            presetId?: number;
            /** 2-letter ISO output language; per-generation override of the user preference. */
            lang?: string;
        }) => Promise<{
            short?: string;
            timestamped?: TimestampedSummaryEntry[];
            long?: VideoLongSummary | null;
            lang?: string;
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
            presetId?: number;
            sources?: QaSource[];
            scope?: "video" | "channel";
        }) => Promise<{
            answer: string;
            citations?: AskCitation[];
            citedVideos?: Record<string, { title: string; uploadDate: string | null; thumbUrl: string | null }>;
        }>;
        isPending: boolean;
    };
    /** Pre-flight cost estimate (`/videos/:id/estimate`). Optional — consumers
     *  without it fall back to generic billing copy in the confirm dialog. */
    useEstimate?: (
        id: VideoId | null,
        opts: {
            mode: "short" | "timestamped" | "long";
            provider?: string;
            model?: string;
            lang?: string;
            enabled?: boolean;
        }
    ) => { data: LlmEstimate | undefined; isPending: boolean };
    /** Server-side per-user Q&A history (`/users/qa-history`). Optional —
     *  consumers without it show only the in-session ask flow. */
    useQaHistory?: (id: VideoId | null) => {
        data: { items: QaHistoryItem[] } | undefined;
        isPending: boolean;
    };
    /** Creates a public share link (`POST /shares`). Optional — consumers
     *  without user accounts don't get share buttons. */
    useCreateShare?: () => {
        mutateAsync: (vars: {
            kind: "summary" | "qa";
            videoId: VideoId;
            mode?: "short" | "timestamped" | "long";
            qaHistoryId?: number;
        }) => Promise<{ url: string }>;
        isPending: boolean;
    };
    /** Feature 11 style presets (`GET /users/presets`). Optional — consumers
     *  without user accounts don't get the Style picker. */
    useListPresets?: (kind?: PresetKind, enabled?: boolean) => { data: PromptPreset[] | undefined; isPending: boolean };
    useCreatePreset?: () => {
        mutateAsync: (vars: { name: string; kind: PresetKind; instructions: string }) => Promise<{
            preset: PromptPreset;
        }>;
        isPending: boolean;
    };
    /** Upserts per-video speaker labels (`PUT /videos/:id/speakers`). */
    useSetSpeakers: (id: VideoId) => {
        mutateAsync: (vars: {
            speakers: Array<{ idx: number; label: string }>;
        }) => Promise<{ speakerLabels?: Record<number, string> }>;
        isPending: boolean;
    };
    /** Feature 08 Layer 2: AI-translates the transcript into another language
     *  (`POST /videos/:id/transcript/translate`). Optional — consumers
     *  without user accounts don't get the transcript language Select. */
    useTranslateTranscript?: (id: VideoId) => {
        mutateAsync: (vars: { lang: string }) => Promise<{ transcript: Transcript; creditsSpent: number }>;
        isPending: boolean;
        error?: Error | null;
    };
    /** Feature 12: POSTs the summary-audio synthesis
     *  (`POST /videos/:id/summary/audio`). Optional — consumers without user
     *  accounts don't get the "Listen" mini player. */
    useGenerateSummaryAudio?: (id: VideoId) => {
        mutateAsync: (vars?: { voice?: string }) => Promise<{ url: string; cached: boolean }>;
        isPending: boolean;
        error?: Error | null;
    };
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
    /** Resolved server defaults per task — names the "server default" row in
     *  the dev-mode picker instead of leaving it a mystery. */
    modelDefaults?: {
        summarize?: { provider: string; model: string } | null;
        qa?: { provider: string; model: string } | null;
    };
    /** Live progress of a running job for this video — drives button spinners + dialog progress. */
    pipelineProgress?: PipelineProgress | null;
    /** Live queue stats — the transcript tab shows how many jobs are ahead. */
    queueStats?: QueueStats | null;
    /** Opens the sign-in surface (settings dialog) when a spend endpoint
     *  returns 401. Receives the bounced action as `retry` — the owner runs it
     *  after a successful login so the user never has to re-click. */
    onRequireLogin?: (retry?: () => void) => void;
    /** Opens the diamonds/subscription surface when a spend endpoint returns a
     *  402 (out of free quota / diamonds) — the confirm dialogs turn it into a
     *  friendly upsell. */
    onUpgrade?: () => void;
    /** Open another video's watch page at a timestamp (cross-video citations). */
    onOpenWatch?: (videoId: string, t: number) => void;
    /** Streaming `summary:partial` payloads keyed by mode (long / timestamped). */
    partialSummaries?: Partial<Record<SummaryMode, unknown>>;
    /** Mode currently receiving streamed partials, or null when idle. */
    streamingMode?: SummaryMode | null;
    /** Current playback second (1 Hz bridge), or null when unknown. */
    playerTime?: number | null;
    /** Feature 08: the signed-in user's output-language preference (2-letter
     *  ISO), or "en" when signed out / unset — seeds the generation dialogs'
     *  language Select and the Ask tab's active-language suffix. */
    outputLang?: string;
    /** Feature 12: turns the relative URL `useGenerateSummaryAudio` resolves
     *  into a fetchable, token-authenticated URL for `<audio src>`. */
    buildAudioSrc?: (relativeUrl: string) => string;
    /** Feature 12: pauses the YouTube player via the existing postMessage
     *  bridge — called right before the summary mini player starts. */
    onPlayVideo?: () => void;
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
    modelDefaults,
    pipelineProgress,
    queueStats,
    onRequireLogin,
    onUpgrade,
    onOpenWatch,
    partialSummaries,
    streamingMode,
    playerTime,
    outputLang,
    buildAudioSrc,
    onPlayVideo,
}: VideoDetailTabsProps) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const pendingCommentRef = useRef<string | null>(null);

    // Cited-comment jump: switch to the Comments tab, then (once its cards
    // exist in the DOM) scroll the thread into view and flash it once.
    function showComment(commentId: string) {
        pendingCommentRef.current = commentId;
        onActiveChange("comments");
    }

    useEffect(() => {
        if (active !== "comments" || pendingCommentRef.current === null) {
            return;
        }

        const commentId = pendingCommentRef.current;
        const root = rootRef.current;

        if (!root) {
            return;
        }

        let observer: MutationObserver | null = null;
        let timeout: number | null = null;

        function reveal(card: Element) {
            pendingCommentRef.current = null;
            observer?.disconnect();

            if (timeout !== null) {
                window.clearTimeout(timeout);
            }

            scrollIntoPanelView(card);
            card.classList.add("yt-flash");
            setTimeout(() => card.classList.remove("yt-flash"), 2100);
        }

        const existing = root.querySelector(`[data-comment-id="${CSS.escape(commentId)}"]`);

        if (existing) {
            reveal(existing);
            return;
        }

        observer = new MutationObserver(() => {
            const card = root.querySelector(`[data-comment-id="${CSS.escape(commentId)}"]`);

            if (card) {
                reveal(card);
            }
        });
        observer.observe(root, { childList: true, subtree: true });

        timeout = window.setTimeout(() => {
            observer?.disconnect();
            pendingCommentRef.current = null;
        }, 3000);

        return () => {
            observer?.disconnect();

            if (timeout !== null) {
                window.clearTimeout(timeout);
            }
        };
    }, [active]);

    return (
        <div ref={rootRef} className="contents">
            <Tabs
                value={active}
                onValueChange={(value) => onActiveChange(value as VideoDetailTab)}
                className={chromeless ? "yt-tabs-root p-4" : "yt-tabs-root yt-panel rounded-3xl p-4"}
            >
                {/* Chromeless = the ~400px extension panel: five triggers only fit
                    on one row with tighter padding and the panel's 12px caption
                    size, and the bar pins to the top of the panel's scroller
                    (full-bleed over the p-4 gutter) so switching tabs never
                    requires scrolling back up. The dashboard keeps the roomy grid. */}
                <TabsList
                    className={
                        chromeless
                            ? "sticky top-0 z-10 -mx-4 -mt-4 flex-nowrap justify-between gap-0.5 rounded-none border-x-0 border-t-0 bg-card px-2 py-1.5"
                            : "grid grid-cols-3 gap-2 lg:grid-cols-5"
                    }
                >
                    {(
                        [
                            ["insights", "Insights"],
                            ["summary", "Summary"],
                            ["ask", "Ask"],
                            ["comments", "Comments"],
                            ["transcript", "Transcript"],
                        ] as const
                    ).map(([value, label]) => (
                        <TabsTrigger
                            key={value}
                            value={value}
                            className={chromeless ? "shrink-0 whitespace-nowrap px-1.5 py-1.5 text-xs" : undefined}
                        >
                            {label}
                        </TabsTrigger>
                    ))}
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
                        modelDefault={modelDefaults?.summarize}
                        onRequireLogin={onRequireLogin}
                        onUpgrade={onUpgrade}
                        pipelineProgress={pipelineProgress}
                        partialTimestamped={partialSummaries?.timestamped}
                        streaming={streamingMode === "timestamped"}
                        outputLang={outputLang}
                    />
                </TabsContent>
                <TabsContent value="summary" className="yt-tab-pane">
                    <SummaryTab
                        videoId={videoId}
                        useSummary={ds.useSummary}
                        useGenerateSummary={ds.useGenerateSummary}
                        useEstimate={ds.useEstimate}
                        useCreateShare={ds.useCreateShare}
                        useListPresets={ds.useListPresets}
                        useCreatePreset={ds.useCreatePreset}
                        devMode={devMode}
                        modelPresets={modelPresets}
                        modelDefault={modelDefaults?.summarize}
                        onRequireLogin={onRequireLogin}
                        onUpgrade={onUpgrade}
                        pipelineProgress={pipelineProgress}
                        partialLong={partialSummaries?.long}
                        streaming={streamingMode === "long"}
                        onSeek={onSeek}
                        playerTime={playerTime}
                        outputLang={outputLang}
                        useGenerateSummaryAudio={ds.useGenerateSummaryAudio}
                        buildAudioSrc={buildAudioSrc}
                        onPlayVideo={onPlayVideo}
                    />
                </TabsContent>
                <TabsContent value="ask" className="yt-tab-pane">
                    <AskTab
                        videoId={videoId}
                        onSeek={onSeek}
                        useAskVideo={ds.useAskVideo}
                        useQaHistory={ds.useQaHistory}
                        useCreateShare={ds.useCreateShare}
                        useListPresets={ds.useListPresets}
                        useCreatePreset={ds.useCreatePreset}
                        onRequireLogin={onRequireLogin}
                        onUpgrade={onUpgrade}
                        useComments={ds.useComments}
                        runPipeline={runPipeline}
                        pipelineProgress={pipelineProgress}
                        onShowComment={showComment}
                        onOpenWatch={onOpenWatch}
                        outputLang={outputLang}
                    />
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
                        useSetSpeakers={ds.useSetSpeakers}
                        useVideo={ds.useVideo}
                        useTranslateTranscript={ds.useTranslateTranscript}
                        runPipeline={runPipeline}
                        pipelineProgress={pipelineProgress}
                        queueStats={queueStats}
                        playerTime={playerTime}
                    />
                </TabsContent>
            </Tabs>
        </div>
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
