import { Button } from "@app/utils/ui/components/button";
import { type VideoDetailTab, VideoDetailTabs } from "@app/utils/ui/components/youtube/tabs";
import { dataSource, useStartPipeline } from "@ext/api.hooks";
import { Header } from "@ext/side-panel/header";
import { connectEventPort } from "@ext/side-panel/port";
import { useEffect, useState } from "react";

export function SidePanel({ videoId, onClose }: { videoId: string | null; onClose: () => void }) {
    const [active, setActive] = useState<VideoDetailTab>("summary");
    const startPipeline = useStartPipeline();

    useEffect(() => {
        const cleanup = connectEventPort();
        return cleanup;
    }, []);

    function seek(seconds: number): void {
        window.postMessage({ event: "command", func: "seekTo", args: [seconds, true] }, "https://www.youtube.com");
    }

    async function transcribe(): Promise<void> {
        if (!videoId) {
            return;
        }

        await startPipeline.mutateAsync({
            target: videoId,
            targetKind: "video",
            stages: ["metadata", "captions", "transcribe", "summarize"],
        });
    }

    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground shadow-[-24px_0_70px_rgba(0,0,0,0.55)]">
            <Header onClose={onClose} />
            {!videoId ? (
                <div className="p-4 text-sm text-muted-foreground">Open a YouTube video to see insights.</div>
            ) : (
                <>
                    <div className="border-b border-primary/15 bg-primary/5 p-3">
                        <Button className="w-full" onClick={transcribe} disabled={startPipeline.isPending}>
                            {startPipeline.isPending ? "Queueing…" : "Transcribe and summarise this video"}
                        </Button>
                    </div>
                    <div className="yt-scroll min-h-0 flex-1 overflow-auto p-3">
                        <VideoDetailTabs
                            videoId={videoId}
                            ds={dataSource}
                            onSeek={seek}
                            active={active}
                            onActiveChange={setActive}
                        />
                    </div>
                </>
            )}
        </div>
    );
}
