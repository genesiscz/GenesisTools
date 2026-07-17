import { Button } from "@app/utils/ui/components/button";
import { LlmConfirmDialog, type ModelPreset } from "@app/utils/ui/components/youtube/llm-confirm-dialog";
import { PanelLoading } from "@app/utils/ui/components/youtube/loading";
import { OUTPUT_LANGS } from "@app/utils/ui/components/youtube/output-langs";
import {
    DEFAULT_SUMMARY_CONTROLS,
    LENGTH_PHRASES,
    SummaryControlsBar,
    type SummaryControlsState,
    TONE_PHRASES,
} from "@app/utils/ui/components/youtube/summary-controls";
import { toPartialTimestampedEntries } from "@app/utils/ui/components/youtube/summary-partials";
import type { PipelineProgress } from "@app/utils/ui/components/youtube/tabs";
import { TimestampedSummaryView } from "@app/utils/ui/components/youtube/timestamped-summary-view";
import type {
    LlmEstimate,
    LockedArtifact,
    TimestampedSummaryEntry,
    VideoId,
    VideoLongSummary,
} from "@app/youtube/lib/types";
import { CREDIT_COSTS } from "@app/youtube/lib/types";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

const NO_ESTIMATE = { data: undefined, isPending: false } as const;

export interface InsightsTabProps {
    videoId: VideoId;
    onSeek: (seconds: number) => void;
    useSummary: (
        id: VideoId | null,
        mode: "short" | "timestamped" | "long"
    ) => {
        data:
            | {
                  timestamped?: TimestampedSummaryEntry[];
                  long?: VideoLongSummary | null;
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
            tone?: SummaryControlsState["tone"];
            format?: SummaryControlsState["format"];
            length?: SummaryControlsState["length"];
            lang?: string;
        }) => Promise<{ timestamped?: TimestampedSummaryEntry[]; lang?: string; cached: boolean; jobId?: number }>;
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
    /** Streaming `summary:partial` payload for the timestamped mode, if a generation is running. */
    partialTimestamped?: unknown;
    /** True while timestamped partials are streaming in. */
    streaming?: boolean;
    /** Signed-in user's output-language preference (2-letter ISO). Default "en". */
    outputLang?: string;
}

export function InsightsTab({
    videoId,
    onSeek,
    useSummary,
    useGenerateSummary,
    useEstimate,
    devMode,
    modelPresets,
    modelDefault,
    onRequireLogin,
    pipelineProgress,
    partialTimestamped,
    streaming,
    outputLang,
}: InsightsTabProps & {
    devMode?: boolean;
    modelPresets?: ModelPreset[];
    modelDefault?: { provider: string; model: string } | null;
    onRequireLogin?: (retry?: () => void) => void;
    pipelineProgress?: PipelineProgress | null;
}) {
    const timestamped = useSummary(videoId, "timestamped");
    const long = useSummary(videoId, "long");
    const generate = useGenerateSummary(videoId);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [controls, setControls] = useState<SummaryControlsState>(DEFAULT_SUMMARY_CONTROLS);
    const [modelSel, setModelSel] = useState<{ provider?: string; model?: string }>({});
    const [lang, setLang] = useState(outputLang ?? "en");
    const estimate =
        useEstimate?.(videoId, { mode: "timestamped", ...modelSel, lang, enabled: confirmOpen }) ?? NO_ESTIMATE;
    const hasPartial = partialTimestamped !== undefined;

    function openConfirm() {
        setLang(outputLang ?? "en");
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
    const partial = hasPartial ? toPartialTimestampedEntries(partialTimestamped) : null;
    const finalEntries = (timestamped.data && !timestamped.data.locked && timestamped.data.timestamped) || [];
    const partialEntries = partial?.entries ?? [];
    const entries = streaming
        ? partialEntries.length > 0
            ? partialEntries
            : finalEntries
        : finalEntries.length > 0
          ? finalEntries
          : partialEntries;
    const finalTldr = (long.data && !long.data.locked && long.data.long?.tldr) || null;
    const tldr = (streaming ? partial?.tldr : null) ?? finalTldr ?? partial?.tldr ?? null;
    const currentLang =
        timestamped.data && !timestamped.data.locked && finalEntries.length > 0
            ? (timestamped.data.lang ?? "en")
            : null;
    // With entries visible the generate button forces a fresh run at full
    // price — quote that, not the reuse/owned price the estimate reports.
    const dialogEstimate: LlmEstimate | null = estimate.data
        ? entries.length > 0
            ? { ...estimate.data, reused: false, creditCost: CREDIT_COSTS["summary:timestamped"] }
            : estimate.data
        : null;

    if (timestamped.isPending && !partial) {
        return <PanelLoading label="Loading insights" />;
    }

    async function runGenerate({ provider, model }: { provider?: string; model?: string }) {
        await generate.mutateAsync({
            mode: "timestamped",
            force: finalEntries.length > 0,
            provider,
            model,
            tone: controls.tone,
            format: controls.format,
            length: controls.length,
            lang,
        });
        setConfirmOpen(false);
    }

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
                <h3 className="min-w-0 truncate text-base font-semibold">Key insights</h3>
                <Button
                    size="sm"
                    className="shrink-0"
                    data-testid="insights-generate"
                    onClick={openConfirm}
                    disabled={generate.isPending}
                >
                    {entries.length === 0 ? "Generate insights…" : "Re-generate…"}
                </Button>
            </div>
            {streaming ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin text-primary" />
                    Writing…
                </div>
            ) : null}
            {entries.length === 0 && streaming ? (
                <div className="space-y-2">
                    <div className="h-4 rounded-md bg-muted/50 animate-pulse" />
                    <div className="h-4 rounded-md bg-muted/50 animate-pulse" />
                    <div className="h-4 rounded-md bg-muted/50 animate-pulse" />
                </div>
            ) : entries.length === 0 ? (
                <p
                    data-testid="insights-empty"
                    className="rounded-xl border border-dashed border-primary/25 p-4 text-sm text-muted-foreground"
                >
                    No insights yet. Click <span className="font-semibold text-foreground/95">Generate insights</span>{" "}
                    to get the video's highlights as a clickable timeline — jump straight to any moment that matters.
                </p>
            ) : (
                <TimestampedSummaryView entries={entries} tldr={tldr} onSeek={onSeek} />
            )}
            <LlmConfirmDialog
                open={confirmOpen}
                title="Generate timestamped insights?"
                description={`You'll get the video's highlights as a timeline — click any timestamp to jump straight to that moment. Written with ${TONE_PHRASES[controls.tone]}, ${LENGTH_PHRASES[controls.length]}${controls.format === "qa" ? ", framed as questions and answers" : ""}.`}
                payloadSummary="We read this video's transcript and pick out the moments worth jumping to. Generated once and saved — reopening the video loads it instantly."
                controlsSlot={
                    <SummaryControlsBar value={controls} onChange={setControls} disabled={generate.isPending} />
                }
                busy={generate.isPending}
                confirmLabel={entries.length === 0 ? "Generate" : "Re-generate"}
                error={generate.error ? (generate.error as Error).message : null}
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
