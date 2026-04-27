import { useEffect, useRef } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@app/utils/ui/components/tabs";
import { CommentsTab } from "@app/utils/ui/components/youtube/comments-tab";
import { InsightsTab } from "@app/utils/ui/components/youtube/insights-tab";
import { SummaryTab } from "@app/utils/ui/components/youtube/summary-tab";
import { TranscriptTab } from "@app/utils/ui/components/youtube/transcript-tab";
import type { AskCitation, TimestampedSummaryEntry, Transcript, Video, VideoId } from "@app/youtube/lib/types";

export type VideoDetailTab = "insights" | "summary" | "comments" | "transcript";

export interface VideoDetailDataSource {
    useVideo: (id: VideoId | null) => { data: { video: Video; transcripts?: Transcript[] } | undefined; isPending: boolean };
    useTranscript: (id: VideoId | null, opts?: { lang?: string; source?: "captions" | "ai" }) => { data: { transcript: Transcript } | undefined; isPending: boolean };
    useSummary: (id: VideoId | null, mode: "short" | "timestamped") => { data: { short?: string; timestamped?: TimestampedSummaryEntry[] } | undefined; isPending: boolean };
    useAskVideo: (id: VideoId) => { mutateAsync: (vars: { question: string; topK?: number }) => Promise<{ answer: string; citations?: AskCitation[] }> };
}

export interface VideoDetailTabsProps {
    videoId: VideoId;
    ds: VideoDetailDataSource;
    active: VideoDetailTab;
    onActiveChange: (tab: VideoDetailTab) => void;
    onSeek: (seconds: number) => void;
}

export function VideoDetailTabs({ videoId, ds, active, onActiveChange, onSeek }: VideoDetailTabsProps) {
    return (
        <Tabs value={active} onValueChange={(value) => onActiveChange(value as VideoDetailTab)} className="yt-panel rounded-3xl p-4">
            <TabsList className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                <TabsTrigger value="insights">Insights</TabsTrigger>
                <TabsTrigger value="summary">Summary</TabsTrigger>
                <TabsTrigger value="comments">Comments</TabsTrigger>
                <TabsTrigger value="transcript">Transcript</TabsTrigger>
            </TabsList>
            <TabsContent value="insights"><InsightsTab videoId={videoId} useSummary={ds.useSummary} /></TabsContent>
            <TabsContent value="summary"><SummaryTab videoId={videoId} onSeek={onSeek} useSummary={ds.useSummary} /></TabsContent>
            <TabsContent value="comments"><CommentsTab /></TabsContent>
            <TabsContent value="transcript"><TranscriptTab videoId={videoId} onSeek={onSeek} useTranscript={ds.useTranscript} /></TabsContent>
        </Tabs>
    );
}

export function YouTubeIframe({ id, seekToSec }: { id: VideoId; seekToSec: number | null }) {
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
