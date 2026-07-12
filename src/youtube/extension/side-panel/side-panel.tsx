import { Button } from "@app/utils/ui/components/button";
import { type RunPipeline, type VideoDetailTab, VideoDetailTabs } from "@app/utils/ui/components/youtube/tabs";
import type { JobStage } from "@app/youtube/lib/types";
import { dataSource, useStartPipeline } from "@ext/api.hooks";
import type { ExtensionEvent } from "@ext/shared/messages";
import { ChannelPanel } from "@ext/side-panel/channel-panel";
import { Header } from "@ext/side-panel/header";
import { connectEventPort } from "@ext/side-panel/port";
import type { PanelTarget } from "@ext/side-panel/target";
import { useCallback, useEffect, useMemo, useState } from "react";

export function SidePanel({ target, onClose }: { target: PanelTarget; onClose: () => void }) {
    if (target.kind === "channel") {
        return <ChannelPanel handle={target.handle} onClose={onClose} />;
    }

    return <VideoPanel videoId={target.videoId} onClose={onClose} />;
}

type PipelineActionKey = "transcribe" | "summarise" | "comments" | "full";

const PIPELINE_ACTIONS: Array<{ key: PipelineActionKey; label: string; pendingLabel: string; stages: JobStage[] }> = [
    {
        key: "transcribe",
        label: "Transcribe",
        pendingLabel: "Transcribing…",
        stages: ["metadata", "captions", "transcribe"],
    },
    {
        key: "summarise",
        label: "Summarise",
        pendingLabel: "Summarising…",
        stages: ["metadata", "captions", "summarize"],
    },
    { key: "comments", label: "Fetch comments", pendingLabel: "Fetching…", stages: ["metadata", "comments"] },
    {
        key: "full",
        label: "Full analysis",
        pendingLabel: "Running…",
        stages: ["metadata", "captions", "transcribe", "summarize", "comments"],
    },
];

function VideoPanel({ videoId, onClose }: { videoId: string; onClose: () => void }) {
    const [active, setActive] = useState<VideoDetailTab>("summary");
    const [pendingAction, setPendingAction] = useState<PipelineActionKey | null>(null);
    const [runningJobs, setRunningJobs] = useState<Partial<Record<PipelineActionKey, number>>>({});
    const startPipeline = useStartPipeline();

    useEffect(() => {
        const cleanup = connectEventPort();
        return cleanup;
    }, []);

    useEffect(() => {
        function onExtensionEvent(event: Event): void {
            const detail = (event as CustomEvent<ExtensionEvent>).detail;
            if (detail?.type !== "job:event") {
                return;
            }

            const jobEvent = detail.event;
            const isTerminal =
                jobEvent.type === "job:completed" ||
                jobEvent.type === "job:failed" ||
                jobEvent.type === "job:cancelled";
            if (!isTerminal) {
                return;
            }

            const jobId = jobEvent.type === "job:cancelled" ? jobEvent.jobId : jobEvent.job.id;
            setRunningJobs((prev) => {
                const next: Partial<Record<PipelineActionKey, number>> = {};
                let changed = false;
                for (const key of Object.keys(prev) as PipelineActionKey[]) {
                    if (prev[key] === jobId) {
                        changed = true;
                        continue;
                    }

                    next[key] = prev[key];
                }

                return changed ? next : prev;
            });
        }

        document.addEventListener("yt-extension-event", onExtensionEvent);
        return () => document.removeEventListener("yt-extension-event", onExtensionEvent);
    }, []);

    function seek(seconds: number): void {
        window.postMessage({ event: "command", func: "seekTo", args: [seconds, true] }, "https://www.youtube.com");
    }

    const runStages = useCallback(
        async (stages: JobStage[]): Promise<void> => {
            await startPipeline.mutateAsync({ target: videoId, targetKind: "video", stages });
        },
        [startPipeline.mutateAsync, videoId]
    );

    async function runAction(action: PipelineActionKey, stages: JobStage[]): Promise<void> {
        setPendingAction(action);
        try {
            const { job } = await startPipeline.mutateAsync({ target: videoId, targetKind: "video", stages });
            setRunningJobs((prev) => ({ ...prev, [action]: job.id }));
        } catch (error) {
            console.error("Failed to run pipeline action:", error);
        } finally {
            setPendingAction(null);
        }
    }

    const runPipeline = useMemo<RunPipeline>(
        () => ({ isPending: startPipeline.isPending, run: runStages }),
        [startPipeline.isPending, runStages]
    );

    function isBusy(action: PipelineActionKey): boolean {
        return pendingAction === action || runningJobs[action] !== undefined;
    }

    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground shadow-[-24px_0_70px_rgba(0,0,0,0.55)]">
            <Header onClose={onClose} />
            <div className="grid grid-cols-2 gap-2 border-b border-primary/15 bg-primary/5 p-3">
                {PIPELINE_ACTIONS.map((action) => (
                    <Button
                        key={action.key}
                        size="sm"
                        variant={action.key === "full" ? undefined : "cyber-secondary"}
                        onClick={() => runAction(action.key, action.stages)}
                        disabled={isBusy(action.key)}
                    >
                        {isBusy(action.key) ? action.pendingLabel : action.label}
                    </Button>
                ))}
            </div>
            <div className="yt-scroll min-h-0 flex-1 overflow-auto p-3">
                <VideoDetailTabs
                    videoId={videoId}
                    ds={dataSource}
                    onSeek={seek}
                    active={active}
                    onActiveChange={setActive}
                    runPipeline={runPipeline}
                />
            </div>
        </div>
    );
}
