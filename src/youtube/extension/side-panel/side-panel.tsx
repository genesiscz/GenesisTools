import { type PipelineProgress, type VideoDetailTab, VideoDetailTabs } from "@app/utils/ui/components/youtube/tabs";
import type { JobStage } from "@app/youtube/lib/types";
import { send } from "@ext/api.bridge";
import { dataSource, useModels, useStartPipeline } from "@ext/api.hooks";
import type { ExtensionEvent } from "@ext/shared/messages";
import { ActivityView } from "@ext/side-panel/activity-view";
import { ChannelPanel } from "@ext/side-panel/channel-panel";
import { Header } from "@ext/side-panel/header";
import { PlaylistPanel } from "@ext/side-panel/playlist-panel";
import { connectEventPort } from "@ext/side-panel/port";
import { SettingsDialog } from "@ext/side-panel/settings-dialog";
import type { PanelTarget } from "@ext/side-panel/target";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

    if (target.kind === "playlist") {
        return <PlaylistPanel listId={target.listId} onClose={onClose} />;
    }

    return <VideoPanel videoId={target.videoId} placement={placement} />;
}

function VideoPanel({ videoId, placement }: { videoId: string; placement: Placement }) {
    const [active, setActive] = useState<VideoDetailTab>("summary");
    const [collapsed, setCollapsed] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [view, setView] = useState<"tabs" | "activity">("tabs");
    const startPipeline = useStartPipeline();
    const queryClient = useQueryClient();
    // Dev-only model picker data; regular builds never fetch it.
    const models = useModels(IS_DEV_BUILD);

    useEffect(() => {
        const cleanup = connectEventPort();
        return cleanup;
    }, []);

    // WS job events drive two things: live progress (spinners + progress bars
    // while a job runs for THIS video) and query invalidation when a job
    // finishes (so "Fetch comments" etc. actually surface their data).
    const [pipelineProgress, setPipelineProgress] = useState<PipelineProgress | null>(null);
    const activeJobIdsRef = useRef<Set<number>>(new Set());

    useEffect(() => {
        function onExtensionEvent(event: Event): void {
            const detail = (event as CustomEvent<ExtensionEvent>).detail;
            if (detail?.type !== "job:event") {
                return;
            }

            const jobEvent = detail.event;

            if (
                (jobEvent.type === "job:created" || jobEvent.type === "job:started") &&
                jobEvent.job.target === videoId
            ) {
                activeJobIdsRef.current.add(jobEvent.job.id);
                setPipelineProgress((prev) => prev ?? { progress: 0, message: null });
                return;
            }

            if (jobEvent.type === "stage:progress" && activeJobIdsRef.current.has(jobEvent.jobId)) {
                setPipelineProgress({ progress: jobEvent.progress, message: jobEvent.message ?? null });
                return;
            }

            if (jobEvent.type !== "job:completed" && jobEvent.type !== "job:failed") {
                return;
            }

            if (activeJobIdsRef.current.has(jobEvent.job.id)) {
                activeJobIdsRef.current.delete(jobEvent.job.id);

                if (activeJobIdsRef.current.size === 0) {
                    setPipelineProgress(null);
                }
            }

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
    // The height cap lives HERE with a definite value — percentage heights
    // can't resolve against the auto-height shadow host, so `max-h-full`
    // would never constrain the flex chain and the body's overflow-auto
    // would never engage (content then paints past the host clip instead of
    // scrolling).
    // transition-[height] + inherited `interpolate-size: allow-keywords` (set
    // on the extension root) animate auto→auto height changes on tab switch —
    // the card is what the user sees resize, so the transition lives here.
    const heightAnim = "transition-[height] duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]";
    const containerClass =
        placement === "inline"
            ? `flex h-auto max-h-[min(60vh,640px)] min-h-0 flex-col overflow-hidden rounded-xl border border-white/8 bg-card ${heightAnim}`
            : `flex h-auto max-h-[min(70vh,720px)] min-h-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-card shadow-2xl shadow-black/40 ${heightAnim}`;

    return (
        <div className={containerClass}>
            <Header
                collapsed={collapsed}
                onToggleCollapse={() => setCollapsed((v) => !v)}
                onOpenSettings={() => setSettingsOpen(true)}
            />
            <div className="yt-body-collapsible min-h-0 flex-1" data-collapsed={collapsed}>
                <div className="yt-scroll min-h-0 h-full overflow-auto">
                    {view === "activity" ? (
                        <ActivityView onBack={() => setView("tabs")} />
                    ) : (
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
                            pipelineProgress={pipelineProgress}
                            onRequireLogin={() => setSettingsOpen(true)}
                            onOpenWatch={(id, t) => void send({ type: "nav:openWatch", id, t })}
                        />
                    )}
                </div>
            </div>
            <SettingsDialog
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                devMode={IS_DEV_BUILD}
                onViewActivity={() => {
                    setSettingsOpen(false);
                    setView("activity");
                }}
            />
        </div>
    );
}
