import { type PipelineProgress, type VideoDetailTab, VideoDetailTabs } from "@app/utils/ui/components/youtube/tabs";
import type { PipelineJob } from "@app/youtube/lib/jobs.types";
import type { JobStage, SummaryMode } from "@app/youtube/lib/types";
import { send } from "@ext/api.bridge";
import { buildAudioSrc, dataSource, useConfig, useMe, useModels, useStartPipeline, useSummary } from "@ext/api.hooks";
import { loadUiLang } from "@ext/shared/i18n";
import type { ExtensionEvent, PlayerChaptersMessage } from "@ext/shared/messages";
import { type AccountSection, AccountView } from "@ext/side-panel/account-view";
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

export function SidePanel({ target, placement }: { target: PanelTarget; placement: Placement }) {
    if (target.kind === "channel") {
        return <ChannelPanel handle={target.handle} />;
    }

    if (target.kind === "playlist") {
        return <PlaylistPanel listId={target.listId} />;
    }

    return <VideoPanel videoId={target.videoId} placement={placement} />;
}

function VideoPanel({ videoId, placement }: { videoId: string; placement: Placement }) {
    const [active, setActive] = useState<VideoDetailTab>("summary");
    const [collapsed, setCollapsed] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [view, setView] = useState<"tabs" | "account">("tabs");
    const [accountSection, setAccountSection] = useState<AccountSection>("activity");
    // `playerTime` is the throttled value handed to the tab subtree; the ref
    // holds the raw 1 Hz position so we can push an exact value the instant a
    // consumer that needs it (the transcript's follow-mode) becomes visible.
    const [playerTime, setPlayerTime] = useState<number | null>(null);
    const playerTimeRef = useRef<number | null>(null);
    const activeRef = useRef(active);
    const lastPushedTimeBucketRef = useRef<number | null>(null);
    const startPipeline = useStartPipeline();
    const queryClient = useQueryClient();
    // Dev-only model picker data; regular builds never fetch it.
    const models = useModels(IS_DEV_BUILD);
    const me = useMe();
    const config = useConfig();

    // Login-gated action retry: a 401'd action registers itself here before
    // the settings dialog opens; the moment `useMe` reports a user, the dialog
    // closes and the action re-runs — the user never has to re-click.
    const pendingLoginRetry = useRef<(() => void) | null>(null);
    const requireLogin = useCallback((retry?: () => void) => {
        pendingLoginRetry.current = retry ?? null;
        setSettingsOpen(true);
    }, []);

    useEffect(() => {
        if (!me.data?.user) {
            return;
        }

        const retry = pendingLoginRetry.current;
        if (!retry) {
            return;
        }

        pendingLoginRetry.current = null;
        setSettingsOpen(false);
        retry();
    }, [me.data?.user]);

    useEffect(() => {
        void loadUiLang();
    }, []);

    // Entering the transcript tab needs the current second immediately (its
    // follow-mode drives off it) instead of waiting up to 5s for the next
    // pushed tick, so flush the raw ref value on the switch.
    useEffect(() => {
        activeRef.current = active;

        if (active === "transcript" && playerTimeRef.current !== null) {
            lastPushedTimeBucketRef.current = Math.floor(playerTimeRef.current / 5);
            setPlayerTime(playerTimeRef.current);
        }
    }, [active]);

    useEffect(() => {
        function onWindowMessage(event: MessageEvent): void {
            if (event.source !== window) {
                return;
            }

            const data = event.data as { type?: unknown; t?: unknown } | null;

            if (data?.type !== "player:time" || typeof data.t !== "number") {
                return;
            }

            const t = data.t;
            playerTimeRef.current = t;

            // The transcript tab's follow-mode needs the exact second every
            // tick; the other consumers (chapter highlight, audio-jump
            // detection) only need ~5s granularity. Skip the 1 Hz whole-subtree
            // re-render unless the transcript is showing or the 5s bucket rolled.
            const bucket = Math.floor(t / 5);
            if (activeRef.current === "transcript") {
                lastPushedTimeBucketRef.current = bucket;
                setPlayerTime(t);
                return;
            }

            if (bucket !== lastPushedTimeBucketRef.current) {
                lastPushedTimeBucketRef.current = bucket;
                setPlayerTime(t);
            }
        }

        window.addEventListener("message", onWindowMessage);
        return () => window.removeEventListener("message", onWindowMessage);
    }, []);

    useEffect(() => {
        const cleanup = connectEventPort();
        return cleanup;
    }, []);

    // WS job events drive two things: live progress (spinners + progress bars
    // while a job runs for THIS video) and query invalidation when a job
    // finishes (so "Fetch comments" etc. actually surface their data).
    const [pipelineProgress, setPipelineProgress] = useState<PipelineProgress | null>(null);
    const activeJobIdsRef = useRef<Set<number>>(new Set());
    // Streaming summary:partial payloads (kept past job:completed so the
    // refetched query swaps content in without a flash of emptiness).
    const [partialSummaries, setPartialSummaries] = useState<Partial<Record<SummaryMode, unknown>>>({});
    const [streamingMode, setStreamingMode] = useState<SummaryMode | null>(null);
    const streamingJobRef = useRef<{ jobId: number; modes: Set<SummaryMode> } | null>(null);

    useEffect(() => {
        setPartialSummaries({});
        setStreamingMode(null);
        streamingJobRef.current = null;
    }, [videoId]);

    const invalidateForStages = useCallback(
        (stages: JobStage[]): void => {
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
        },
        [queryClient, videoId]
    );

    const longSummary = useSummary(videoId, "long");
    const longChapters = longSummary.data?.long?.chapters;

    useEffect(() => {
        const chapters: PlayerChaptersMessage["chapters"] = [];

        for (const chapter of longChapters ?? []) {
            if (typeof chapter.startSec === "number") {
                chapters.push({ title: chapter.title, startSec: chapter.startSec });
            }
        }

        const message: PlayerChaptersMessage = { type: "player:chapters", videoId, chapters };
        window.postMessage(message, "https://www.youtube.com");
    }, [longChapters, videoId]);

    useEffect(
        () => () => {
            const message: PlayerChaptersMessage = { type: "player:chapters", videoId, chapters: [] };
            window.postMessage(message, "https://www.youtube.com");
        },
        [videoId]
    );

    useEffect(() => {
        function onExtensionEvent(event: Event): void {
            const detail = (event as CustomEvent<ExtensionEvent>).detail;
            if (detail?.type !== "job:event") {
                return;
            }

            const jobEvent = detail.event;

            if (jobEvent.type === "summary:partial") {
                if (jobEvent.videoId !== videoId) {
                    return;
                }

                if (streamingJobRef.current?.jobId !== jobEvent.jobId) {
                    streamingJobRef.current = { jobId: jobEvent.jobId, modes: new Set() };
                }

                if (!streamingJobRef.current.modes.has(jobEvent.mode)) {
                    streamingJobRef.current.modes.add(jobEvent.mode);
                    if (jobEvent.mode === "long") {
                        setActive("summary");
                    } else if (jobEvent.mode === "timestamped") {
                        setActive("insights");
                    }
                }

                setPartialSummaries((prev) => ({ ...prev, [jobEvent.mode]: jobEvent.partial }));
                setStreamingMode(jobEvent.mode);
                return;
            }

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

            if (streamingJobRef.current?.jobId === jobEvent.job.id) {
                streamingJobRef.current = null;
                setStreamingMode(null);

                if (jobEvent.type === "job:failed") {
                    setPartialSummaries({});
                }
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

            invalidateForStages(jobEvent.job.stages ?? []);
        }
        document.addEventListener("yt-extension-event", onExtensionEvent);
        return () => document.removeEventListener("yt-extension-event", onExtensionEvent);
    }, [invalidateForStages]);

    // WS fallback poll: the MV3 service worker (and its events WebSocket) can
    // be dead while a job runs — without this the panel would never learn the
    // job finished and "Fetch comments" would look like it did nothing. While
    // any job is tracked, poll its status and run the same invalidations the
    // WS handler would.
    useEffect(() => {
        if (pipelineProgress === null) {
            return;
        }

        const timer = setInterval(() => {
            for (const jobId of activeJobIdsRef.current) {
                void send<{ job: PipelineJob }>({ type: "api:getJob", id: jobId }).then(({ job }) => {
                    if (job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled") {
                        setPipelineProgress({ progress: job.progress, message: job.progressMessage });
                        return;
                    }

                    if (!activeJobIdsRef.current.delete(job.id)) {
                        return;
                    }

                    if (activeJobIdsRef.current.size === 0) {
                        setPipelineProgress(null);
                    }

                    if (job.status === "completed") {
                        invalidateForStages(job.stages ?? []);
                    }
                });
            }
        }, 3000);

        return () => clearInterval(timer);
    }, [pipelineProgress, invalidateForStages]);

    function seek(seconds: number): void {
        window.postMessage({ event: "command", func: "seekTo", args: [seconds, true] }, "https://www.youtube.com");
    }

    // Feature 12 exclusivity, direction 1: panel audio play → pause YouTube
    // via the same postMessage bridge `seek` uses.
    function pauseVideo(): void {
        window.postMessage({ event: "command", func: "pauseVideo", args: [] }, "https://www.youtube.com");
    }

    const runStages = useCallback(
        async (stages: JobStage[]): Promise<void> => {
            const result = await startPipeline.mutateAsync({ target: videoId, targetKind: "video", stages });
            // Track the job from the POST response, not just from WS job:created —
            // the loader must show even when the events socket is down.
            activeJobIdsRef.current.add(result.job.id);
            setPipelineProgress((prev) => prev ?? { progress: 0, message: null });
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
            {/* Nested flex (not h-full): percentage heights can't resolve against
                the collapsible's auto height, so `h-full` computed to auto and the
                overflow-auto box never scrolled — wheel events fell through to the
                YouTube page. Flex sizing distributes real layout space instead.
                overscroll-contain stops the page from scrolling when the panel
                hits its top/bottom. */}
            <div className="yt-body-collapsible flex min-h-0 flex-1 flex-col" data-collapsed={collapsed}>
                <div className="yt-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    {view === "account" ? (
                        <AccountView
                            section={accountSection}
                            onSectionChange={setAccountSection}
                            onBack={() => setView("tabs")}
                            onRequireLogin={requireLogin}
                            onOpenWatch={(id, t) => void send({ type: "nav:openWatch", id, t })}
                        />
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
                            modelDefaults={models.data?.defaults}
                            pipelineProgress={pipelineProgress}
                            onRequireLogin={requireLogin}
                            onOpenWatch={(id, t) => void send({ type: "nav:openWatch", id, t })}
                            partialSummaries={partialSummaries}
                            streamingMode={streamingMode}
                            playerTime={playerTime}
                            outputLang={me.data?.user.outputLang ?? undefined}
                            buildAudioSrc={
                                config.data
                                    ? (relativeUrl: string) => buildAudioSrc(relativeUrl, config.data)
                                    : undefined
                            }
                            onPlayVideo={pauseVideo}
                        />
                    )}
                </div>
            </div>
            <SettingsDialog
                open={settingsOpen}
                onOpenChange={(open) => {
                    setSettingsOpen(open);
                    // Manual close without logging in abandons the queued action.
                    if (!open) {
                        pendingLoginRetry.current = null;
                    }
                }}
                devMode={IS_DEV_BUILD}
                onOpenAccount={(accountSectionId) => {
                    setSettingsOpen(false);
                    setAccountSection(accountSectionId);
                    setView("account");
                }}
            />
        </div>
    );
}
