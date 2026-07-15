import { type VideoDetailTab, VideoDetailTabs } from "@app/utils/ui/components/youtube/tabs";
import type { JobStage } from "@app/youtube/lib/types";
import { dataSource, useModels, useStartPipeline } from "@ext/api.hooks";
import type { ExtensionEvent } from "@ext/shared/messages";
import { ChannelPanel } from "@ext/side-panel/channel-panel";
import { Header } from "@ext/side-panel/header";
import { connectEventPort } from "@ext/side-panel/port";
import type { PanelTarget } from "@ext/side-panel/target";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

declare const __EXT_DEV_RELOAD__: boolean;
const IS_DEV_BUILD = typeof __EXT_DEV_RELOAD__ !== "undefined" && __EXT_DEV_RELOAD__;

type Placement = "inline" | "fixed";

export function SidePanel({
    target,
    placement,
    onClose,
}: {
    target: PanelTarget;
    placement: Placement;
    onClose: () => void;
}) {
    if (target.kind === "channel") {
        return <ChannelPanel handle={target.handle} onClose={onClose} />;
    }

    return <VideoPanel videoId={target.videoId} placement={placement} />;
}

function VideoPanel({ videoId, placement }: { videoId: string; placement: Placement }) {
    const [active, setActive] = useState<VideoDetailTab>("summary");
    const [collapsed, setCollapsed] = useState(false);
    const startPipeline = useStartPipeline();
    const queryClient = useQueryClient();
    // Dev-only model picker data; regular builds never fetch it.
    const models = useModels(IS_DEV_BUILD);

    useEffect(() => {
        const cleanup = connectEventPort();
        return cleanup;
    }, []);

    // When any pipeline job finishes, invalidate the query for the tab whose
    // data it touched. Without this the "Fetch comments" button enqueues a
    // job but the panel never notices when comments actually land.
    useEffect(() => {
        function onExtensionEvent(event: Event): void {
            const detail = (event as CustomEvent<ExtensionEvent>).detail;
            if (detail?.type !== "job:event") {
                return;
            }

            const jobEvent = detail.event;
            if (jobEvent.type !== "job:completed") {
                return;
            }

            const stages = jobEvent.job.stages ?? [];
            if (stages.includes("comments")) {
                queryClient.invalidateQueries({ queryKey: ["comments", videoId] });
            }
            if (stages.includes("captions") || stages.includes("transcribe")) {
                queryClient.invalidateQueries({ queryKey: ["transcript", videoId] });
            }
            if (stages.includes("summarize")) {
                queryClient.invalidateQueries({ queryKey: ["summary", videoId] });
            }
            if (stages.includes("metadata")) {
                queryClient.invalidateQueries({ queryKey: ["video", videoId] });
            }
        }
        document.addEventListener("yt-extension-event", onExtensionEvent);
        return () => document.removeEventListener("yt-extension-event", onExtensionEvent);
    }, [queryClient, videoId]);

    function seek(seconds: number): void {
        window.postMessage({ event: "command", func: "seekTo", args: [seconds, true] }, "https://www.youtube.com");
    }

    const runStages = useCallback(
        async (stages: JobStage[]): Promise<void> => {
            await startPipeline.mutateAsync({ target: videoId, targetKind: "video", stages });
        },
        [startPipeline.mutateAsync, videoId]
    );

    const runPipeline = useMemo(
        () => ({ isPending: startPipeline.isPending, run: runStages }),
        [startPipeline.isPending, runStages]
    );

    // Single surface — border + bg live on this one wrapper. VideoDetailTabs
    // renders chromeless so we don't nest two containers.
    const containerClass =
        placement === "inline"
            ? "flex h-auto min-h-0 flex-col overflow-hidden rounded-xl border border-white/8 bg-card"
            : "flex h-auto min-h-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-card shadow-2xl shadow-black/40";

    return (
        <div className={containerClass}>
            <Header collapsed={collapsed} onToggleCollapse={() => setCollapsed((v) => !v)} />
            <div className="yt-body-collapsible min-h-0 flex-1" data-collapsed={collapsed}>
                <div className="yt-scroll min-h-0 h-full overflow-auto">
                    <VideoDetailTabs
                        videoId={videoId}
                        ds={dataSource}
                        onSeek={seek}
                        active={active}
                        onActiveChange={setActive}
                        runPipeline={runPipeline}
                        chromeless
                        devMode={IS_DEV_BUILD}
                        modelPresets={models.data?.presets ?? []}
                    />
                </div>
            </div>
        </div>
    );
}
