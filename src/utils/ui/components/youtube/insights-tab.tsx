import { Badge } from "@app/utils/ui/components/badge";
import { Button } from "@app/utils/ui/components/button";
import { LlmConfirmDialog, type ModelPreset } from "@app/utils/ui/components/youtube/llm-confirm-dialog";
import { Loading } from "@app/utils/ui/components/youtube/loading";
import {
    DEFAULT_SUMMARY_CONTROLS,
    SummaryControlsBar,
    type SummaryControlsState,
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
        }) => Promise<{ timestamped?: TimestampedSummaryEntry[]; cached: boolean; jobId?: number }>;
        isPending: boolean;
        error?: Error | null;
    };
    useEstimate?: (
        id: VideoId | null,
        opts: { mode: "short" | "timestamped" | "long"; provider?: string; model?: string; enabled?: boolean }
    ) => { data: LlmEstimate | undefined; isPending: boolean };
    /** Streaming `summary:partial` payload for the timestamped mode, if a generation is running. */
    partialTimestamped?: unknown;
    /** True while timestamped partials are streaming in. */
    streaming?: boolean;
}

export function InsightsTab({
    videoId,
    onSeek,
    useSummary,
    useGenerateSummary,
    useEstimate,
    devMode,
    modelPresets,
    pipelineProgress,
    partialTimestamped,
    streaming,
}: InsightsTabProps & { devMode?: boolean; modelPresets?: ModelPreset[]; pipelineProgress?: PipelineProgress | null }) {
    const timestamped = useSummary(videoId, "timestamped");
    const long = useSummary(videoId, "long");
    const generate = useGenerateSummary(videoId);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [controls, setControls] = useState<SummaryControlsState>(DEFAULT_SUMMARY_CONTROLS);
    const [modelSel, setModelSel] = useState<{ provider?: string; model?: string }>({});
    const estimate = useEstimate?.(videoId, { mode: "timestamped", ...modelSel, enabled: confirmOpen }) ?? NO_ESTIMATE;
    const hasPartial = partialTimestamped !== undefined;

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
    // With entries visible the generate button forces a fresh run at full
    // price — quote that, not the reuse/owned price the estimate reports.
    const dialogEstimate: LlmEstimate | null = estimate.data
        ? entries.length > 0
            ? { ...estimate.data, reused: false, creditCost: CREDIT_COSTS["summary:timestamped"] }
            : estimate.data
        : null;

    if (timestamped.isPending && !partial) {
        return <Loading label="Loading insights" />;
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
        });
        setConfirmOpen(false);
    }

    return (
        <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <Badge variant="cyber-secondary">AI signal · timestamped</Badge>
                    <h3 className="mt-3 text-2xl font-bold">Key insights</h3>
                </div>
                <Button
                    data-testid="insights-generate"
                    onClick={() => setConfirmOpen(true)}
                    disabled={generate.isPending}
                >
                    {entries.length === 0 ? "Generate insights…" : "Re-generate…"}
                </Button>
            </div>
            <SummaryControlsBar value={controls} onChange={setControls} disabled={generate.isPending} />
            {streaming ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin text-primary" />
                    Writing…
                </div>
            ) : null}
            {entries.length === 0 && streaming ? (
                <div className="space-y-2">
                    <div className="h-4 rounded-md bg-white/5 animate-pulse" />
                    <div className="h-4 rounded-md bg-white/5 animate-pulse" />
                    <div className="h-4 rounded-md bg-white/5 animate-pulse" />
                </div>
            ) : entries.length === 0 ? (
                <p
                    data-testid="insights-empty"
                    className="rounded-2xl border border-dashed border-primary/25 p-5 text-muted-foreground"
                >
                    No timestamped insights yet. Click{" "}
                    <span className="font-semibold text-foreground/95">Generate insights</span> to send the transcript
                    to your configured LLM and get back per-section highlights with icons + timestamps.
                </p>
            ) : (
                <TimestampedSummaryView entries={entries} tldr={tldr} onSeek={onSeek} />
            )}
            <LlmConfirmDialog
                open={confirmOpen}
                title="Generate timestamped insights?"
                description={`Sends the compacted transcript to your LLM and asks for ~${entries.length === 0 ? "12" : "12"} sections with icon + title + 1-2 sentence body each. Tone: ${controls.tone}. Format: ${controls.format}. Length: ${controls.length}.`}
                payloadSummary="Compacted transcript with timestamps; structured-output JSON response."
                busy={generate.isPending}
                confirmLabel={entries.length === 0 ? "Generate" : "Re-generate"}
                error={generate.error ? (generate.error as Error).message : null}
                showAdvanced={devMode}
                modelPresets={modelPresets}
                estimate={dialogEstimate}
                estimatePending={estimate.isPending && confirmOpen}
                onSelectionChange={setModelSel}
                progress={pipelineProgress}
                onCancel={() => setConfirmOpen(false)}
                onConfirm={runGenerate}
            />
        </div>
    );
}
