import { Tabs, TabsContent, TabsList, TabsTrigger } from "@app/utils/ui/components/tabs";
import { CommentsTab } from "@app/yt/components/video-detail/comments-tab";
import { InsightsTab } from "@app/yt/components/video-detail/insights-tab";
import { SummaryTab } from "@app/yt/components/video-detail/summary-tab";
import { TranscriptTab } from "@app/yt/components/video-detail/transcript-tab";
import type { VideoId } from "@app/youtube/lib/types";

export type VideoDetailTab = "insights" | "summary" | "comments" | "transcript";

export function VideoDetailTabs({ videoId, active, onActiveChange, onSeek }: { videoId: VideoId; active: VideoDetailTab; onActiveChange: (tab: VideoDetailTab) => void; onSeek: (seconds: number) => void }) {
    return (
        <Tabs value={active} onValueChange={(value) => onActiveChange(value as VideoDetailTab)} className="yt-panel rounded-3xl p-4">
            <TabsList className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                <TabsTrigger value="insights">Insights</TabsTrigger>
                <TabsTrigger value="summary">Summary</TabsTrigger>
                <TabsTrigger value="comments">Comments</TabsTrigger>
                <TabsTrigger value="transcript">Transcript</TabsTrigger>
            </TabsList>
            <TabsContent value="insights"><InsightsTab videoId={videoId} /></TabsContent>
            <TabsContent value="summary"><SummaryTab videoId={videoId} onSeek={onSeek} /></TabsContent>
            <TabsContent value="comments"><CommentsTab /></TabsContent>
            <TabsContent value="transcript"><TranscriptTab videoId={videoId} onSeek={onSeek} /></TabsContent>
        </Tabs>
    );
}
