import { Button } from "@app/utils/ui/components/button";
import { LlmConfirmDialog, type ModelPreset } from "@app/utils/ui/components/youtube/llm-confirm-dialog";
import { PanelLoading } from "@app/utils/ui/components/youtube/loading";
import { errorCodeOf } from "@app/utils/ui/components/youtube/login-required";
import { LongSummaryView } from "@app/utils/ui/components/youtube/long-summary-view";
import { OUTPUT_LANGS } from "@app/utils/ui/components/youtube/output-langs";
import { ShareButton } from "@app/utils/ui/components/youtube/share-button";
import { StyleSelect } from "@app/utils/ui/components/youtube/style-select";
import { SummaryAudioPlayer } from "@app/utils/ui/components/youtube/summary-audio-player";
import {
    LENGTH_PHRASES,
    SummaryControlsBar,
    type SummaryControlsState,
    seedControlsFromTaskDefault,
    TONE_PHRASES,
} from "@app/utils/ui/components/youtube/summary-controls";
import { toPartialLongSummary } from "@app/utils/ui/components/youtube/summary-partials";
import type { PipelineProgress, VideoDetailDataSource } from "@app/utils/ui/components/youtube/tabs";
import type { LlmEstimate, LockedArtifact, VideoId, VideoLongSummary } from "@app/youtube/lib/types";
import { CREDIT_COSTS } from "@app/youtube/lib/types";
import type { TaskDefaultSettings } from "@app/youtube/lib/user-settings";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const NO_ESTIMATE = { data: undefined, isPending: false } as const;

export interface SummaryTabProps {
    videoId: VideoId;
    useSummary: (
        id: VideoId | null,
        mode: "short" | "timestamped" | "long"
    ) => {
        data:
            | { long?: VideoLongSummary | null; lang?: string; cached?: boolean; locked?: undefined }
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
            tone?: SummaryControlsState["tone"];
            length?: SummaryControlsState["length"];
            presetId?: number;
            lang?: string;
        }) => Promise<{ long?: VideoLongSummary | null; lang?: string; cached: boolean; jobId?: number }>;
        isPending: boolean;
        error?: Error | null;
    };
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
    useCreateShare?: VideoDetailDataSource["useCreateShare"];
    useListPresets?: VideoDetailDataSource["useListPresets"];
    useCreatePreset?: VideoDetailDataSource["useCreatePreset"];
    /** Streaming `summary:partial` payload for the long mode, if a generation is running. */
    partialLong?: unknown;
    /** True while long-summary partials are streaming in. */
    streaming?: boolean;
    /** Seeks the player; enables chapter timecode pills. */
    onSeek?: (seconds: number) => void;
    /** Current playback second (1 Hz bridge) — drives the "playing" chapter state. */
    playerTime?: number | null;
    /** Signed-in user's output-language preference (2-letter ISO). Default "en". */
    outputLang?: string;
    /** Feature 12: POSTs the summary-audio synthesis and returns an
     *  authenticated, fetchable `<audio src>` URL. Optional — consumers
     *  without user accounts don't get the "Listen" mini player. */
    useGenerateSummaryAudio?: (id: VideoId) => {
        mutateAsync: (vars?: { voice?: string }) => Promise<{ url: string; cached: boolean }>;
        isPending: boolean;
        error?: Error | null;
    };
    /** Turns the relative URL `useGenerateSummaryAudio` resolves into a fetchable, token-authenticated URL. */
    buildAudioSrc?: (relativeUrl: string) => string;
    /** Pauses the YouTube player via the existing postMessage bridge — called right before the mini player starts. */
    onPlayVideo?: () => void;
}

export function SummaryTab({
    videoId,
    useSummary,
    useGenerateSummary,
    useEstimate,
    useCreateShare,
    useListPresets,
    useCreatePreset,
    devMode,
    modelPresets,
    modelDefault,
    onRequireLogin,
    onUpgrade,
    taskDefault,
    pipelineProgress,
    partialLong,
    streaming,
    onSeek,
    playerTime,
    outputLang,
    useGenerateSummaryAudio,
    buildAudioSrc,
    onPlayVideo,
}: SummaryTabProps & {
    devMode?: boolean;
    modelPresets?: ModelPreset[];
    modelDefault?: { provider: string; model: string } | null;
    onRequireLogin?: (retry?: () => void) => void;
    onUpgrade?: () => void;
    taskDefault?: TaskDefaultSettings;
    pipelineProgress?: PipelineProgress | null;
}) {
    const summary = useSummary(videoId, "long");
    const generate = useGenerateSummary(videoId);
    const createShare = useCreateShare?.();
    const userPresets = useListPresets?.("summary");
    const createPreset = useCreatePreset?.();
    const generateAudio = useGenerateSummaryAudio?.(videoId);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [controls, setControls] = useState<SummaryControlsState>(() => seedControlsFromTaskDefault(taskDefault));
    const [modelSel, setModelSel] = useState<{ provider?: string; model?: string }>({});
    const [linkCopied, setLinkCopied] = useState(false);
    const [presetId, setPresetId] = useState<number | null>(null);
    const [lang, setLang] = useState(() => taskDefault?.lang ?? outputLang ?? "en");
    // Settings can resolve after this tab mounts (async query). Seed once, when
    // the per-task default first becomes available, so a saved preference still
    // applies without clobbering later user changes.
    const seededTaskDefaultRef = useRef(false);
    useEffect(() => {
        if (seededTaskDefaultRef.current || !taskDefault) {
            return;
        }

        seededTaskDefaultRef.current = true;
        setControls(seedControlsFromTaskDefault(taskDefault));

        if (taskDefault.lang) {
            setLang(taskDefault.lang);
        }
    }, [taskDefault]);
    const estimate = useEstimate?.(videoId, { mode: "long", ...modelSel, lang, enabled: confirmOpen }) ?? NO_ESTIMATE;
    // The dialog only ever fronts a fresh (re)generation — unlocking happens
    // on the teaser card — so quote the full generation price, not the
    // reuse/owned price the estimate endpoint reports for existing artifacts.
    const dialogEstimate: LlmEstimate | null = estimate.data
        ? { ...estimate.data, reused: false, creditCost: CREDIT_COSTS["summary:long"] }
        : null;
    const lockedInfo = summary.data?.locked ? summary.data : null;
    const long = (summary.data && !summary.data.locked && summary.data.long) || null;
    const currentLang = summary.data && !summary.data.locked && long !== null ? (summary.data.lang ?? "en") : null;
    const hasPartial = partialLong !== undefined;

    function openConfirm() {
        setLang(taskDefault?.lang ?? outputLang ?? "en");
        setConfirmOpen(true);
    }

    useEffect(() => {
        // First streamed partial closes the confirm dialog — content takes over
        // from the dialog's progress view. Reuse unlocks never stream, so this
        // only fires on fresh generations.
        if (streaming && hasPartial) {
            setConfirmOpen(false);
        }
    }, [streaming, hasPartial]);

    // The partial outlives the stream (kept until the refetched query has data)
    // so completion swaps content without a flash of emptiness.
    const partial = hasPartial ? toPartialLongSummary(partialLong) : null;
    const idleSummary = long ?? partial;

    if (summary.isPending && !partial) {
        return <PanelLoading label="Loading summary" />;
    }

    async function runGenerate({ provider, model }: { provider?: string; model?: string }) {
        await generate.mutateAsync({
            mode: "long",
            // The dialog path is always a REAL generation: force past a locked
            // shared artifact so the server regenerates instead of unlocking.
            force: long !== null || lockedInfo !== null,
            provider,
            model,
            tone: controls.tone,
            length: controls.length,
            presetId: presetId ?? undefined,
            lang,
        });
        setConfirmOpen(false);
    }

    async function unlockSummary() {
        // Teaser IS the confirm — straight to the flat-price charge; the
        // server returns the stored artifact instantly (no job, no LLM).
        await generate.mutateAsync({ mode: "long" });
    }

    async function prepareAudio(): Promise<string> {
        if (!generateAudio || !buildAudioSrc) {
            throw new Error("audio playback is not available");
        }

        const result = await generateAudio.mutateAsync();
        return buildAudioSrc(result.url);
    }

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
                <h3 className="min-w-0 truncate text-base font-semibold">Whole-video summary</h3>
                <div className="flex shrink-0 items-center gap-1">
                    {createShare && long !== null ? (
                        <ShareButton
                            onShare={() => createShare.mutateAsync({ kind: "summary", videoId, mode: "long" })}
                            onRequireLogin={onRequireLogin}
                            onCopied={() => {
                                setLinkCopied(true);
                                setTimeout(() => setLinkCopied(false), 2000);
                            }}
                        />
                    ) : null}
                    {lockedInfo === null ? (
                        <Button
                            size="sm"
                            data-testid="summary-generate"
                            onClick={openConfirm}
                            disabled={generate.isPending || streaming}
                        >
                            {long === null ? "Generate summary…" : "Re-generate…"}
                        </Button>
                    ) : null}
                </div>
            </div>
            {linkCopied ? <p className="text-sm text-primary">Link copied</p> : null}
            {streaming ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin text-primary" />
                    Writing…
                </div>
            ) : null}
            {streaming && partial !== null ? (
                // Generating state: streamed partials render through the normal
                // view (skeletons for pending sections) — never on the teaser.
                <LongSummaryView summary={partial} streaming onSeek={onSeek} playerTime={playerTime} />
            ) : streaming ? (
                // Streaming started but no partial has arrived yet — show the
                // writing skeleton, never the stale previous summary.
                <div className="space-y-2">
                    <div className="h-4 rounded-md bg-muted/50 animate-pulse" />
                    <div className="h-4 rounded-md bg-muted/50 animate-pulse" />
                    <div className="h-4 rounded-md bg-muted/50 animate-pulse" />
                </div>
            ) : lockedInfo !== null ? (
                <div
                    data-testid="summary-locked"
                    className="space-y-3 rounded-2xl border border-border/50 bg-muted/30 p-3"
                >
                    <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-secondary">summary</p>
                    <p className="line-clamp-3 text-sm text-muted-foreground [mask-image:linear-gradient(to_bottom,black_40%,transparent)]">
                        {lockedInfo.preview.tldr}
                    </p>
                    {generate.error ? (
                        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
                            <p className="break-words text-destructive/90">{generate.error.message}</p>
                        </div>
                    ) : null}
                    <div className="flex flex-col items-start gap-1.5">
                        <Button
                            size="sm"
                            data-testid="summary-unlock"
                            onClick={unlockSummary}
                            disabled={generate.isPending || streaming}
                        >
                            {generate.isPending ? (
                                <>
                                    <Loader2 className="size-4 animate-spin" /> Unlocking…
                                </>
                            ) : (
                                `Unlock · ${lockedInfo.price} 💎`
                            )}
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground"
                            onClick={openConfirm}
                            disabled={generate.isPending || streaming}
                        >
                            Regenerate fresh…
                        </Button>
                    </div>
                </div>
            ) : idleSummary === null ? (
                <p
                    data-testid="summary-empty"
                    className="rounded-xl border border-dashed border-primary/25 p-4 text-sm text-muted-foreground"
                >
                    No summary yet. Click <span className="font-semibold text-foreground/95">Generate summary</span> to
                    get a quick TL;DR, the key points, lessons worth keeping, chapters, and a verdict — all from what's
                    said in the video.
                </p>
            ) : (
                <>
                    {long !== null && generateAudio && buildAudioSrc ? (
                        <SummaryAudioPlayer
                            key={videoId}
                            priceLabel={`${CREDIT_COSTS["tts:summary"]} 💎`}
                            onPrepare={prepareAudio}
                            onPlayVideo={onPlayVideo}
                            playerTime={playerTime}
                        />
                    ) : null}
                    {/* `long ?? partial`: a just-completed stream keeps rendering the
                        retained partial until the refetched query lands (no flash). */}
                    <LongSummaryView summary={idleSummary} onSeek={onSeek} playerTime={playerTime} />
                </>
            )}
            <LlmConfirmDialog
                open={confirmOpen}
                title="Generate long-form summary?"
                description={`You'll get a TL;DR, the key points, lessons worth keeping, and clickable chapters — written with ${TONE_PHRASES[controls.tone]}, ${LENGTH_PHRASES[controls.length]}.`}
                payloadSummary="We read this video's transcript and turn it into a structured summary. It's generated once and saved — next time you open the video it loads instantly."
                controlsSlot={
                    <div className="space-y-3">
                        <SummaryControlsBar
                            value={controls}
                            onChange={setControls}
                            disabled={generate.isPending}
                            hideFormat
                        />
                        {userPresets && createPreset ? (
                            <StyleSelect
                                kind="summary"
                                presets={userPresets.data ?? []}
                                selectedId={presetId}
                                onSelect={setPresetId}
                                onCreate={createPreset.mutateAsync}
                                creating={createPreset.isPending}
                            />
                        ) : null}
                    </div>
                }
                busy={generate.isPending || streaming}
                confirmLabel={long === null ? "Generate" : "Re-generate"}
                error={generate.error ? (generate.error as Error).message : null}
                errorCode={errorCodeOf(generate.error)}
                onUpgrade={onUpgrade}
                showAdvanced={devMode}
                modelPresets={modelPresets}
                defaultProvider={modelDefault?.provider}
                defaultModel={modelDefault?.model}
                estimate={dialogEstimate}
                estimatePending={estimate.isPending && confirmOpen}
                onSelectionChange={setModelSel}
                progress={pipelineProgress}
                langs={OUTPUT_LANGS}
                lang={lang}
                onLangChange={setLang}
                currentLang={currentLang}
                onRequireLogin={onRequireLogin}
                onCancel={() => setConfirmOpen(false)}
                onConfirm={runGenerate}
            />
        </div>
    );
}
