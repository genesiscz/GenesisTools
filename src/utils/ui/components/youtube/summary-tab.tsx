import { Badge } from "@app/utils/ui/components/badge";
import { Button } from "@app/utils/ui/components/button";
import { LlmConfirmDialog, type ModelPreset } from "@app/utils/ui/components/youtube/llm-confirm-dialog";
import { Loading } from "@app/utils/ui/components/youtube/loading";
import { LongSummaryView } from "@app/utils/ui/components/youtube/long-summary-view";
import { ShareButton } from "@app/utils/ui/components/youtube/share-button";
import { StyleSelect } from "@app/utils/ui/components/youtube/style-select";
import {
    DEFAULT_SUMMARY_CONTROLS,
    SummaryControlsBar,
    type SummaryControlsState,
} from "@app/utils/ui/components/youtube/summary-controls";
import type { PipelineProgress, VideoDetailDataSource } from "@app/utils/ui/components/youtube/tabs";
import type { LlmEstimate, LockedArtifact, VideoId, VideoLongSummary } from "@app/youtube/lib/types";
import { CREDIT_COSTS } from "@app/youtube/lib/types";
import { Loader2 } from "lucide-react";
import { useState } from "react";

const NO_ESTIMATE = { data: undefined, isPending: false } as const;

export interface SummaryTabProps {
    videoId: VideoId;
    useSummary: (
        id: VideoId | null,
        mode: "short" | "timestamped" | "long"
    ) => {
        data: { long?: VideoLongSummary | null; cached?: boolean; locked?: undefined } | LockedArtifact | undefined;
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
        }) => Promise<{ long?: VideoLongSummary | null; cached: boolean; jobId?: number }>;
        isPending: boolean;
        error?: Error | null;
    };
    useEstimate?: (
        id: VideoId | null,
        opts: { mode: "short" | "timestamped" | "long"; provider?: string; model?: string; enabled?: boolean }
    ) => { data: LlmEstimate | undefined; isPending: boolean };
    useCreateShare?: VideoDetailDataSource["useCreateShare"];
    useListPresets?: VideoDetailDataSource["useListPresets"];
    useCreatePreset?: VideoDetailDataSource["useCreatePreset"];
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
    pipelineProgress,
}: SummaryTabProps & { devMode?: boolean; modelPresets?: ModelPreset[]; pipelineProgress?: PipelineProgress | null }) {
    const summary = useSummary(videoId, "long");
    const generate = useGenerateSummary(videoId);
    const createShare = useCreateShare?.();
    const userPresets = useListPresets?.("summary");
    const createPreset = useCreatePreset?.();
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [controls, setControls] = useState<SummaryControlsState>(DEFAULT_SUMMARY_CONTROLS);
    const [modelSel, setModelSel] = useState<{ provider?: string; model?: string }>({});
    const [linkCopied, setLinkCopied] = useState(false);
    const [presetId, setPresetId] = useState<number | null>(null);
    const estimate = useEstimate?.(videoId, { mode: "long", ...modelSel, enabled: confirmOpen }) ?? NO_ESTIMATE;
    // The dialog only ever fronts a fresh (re)generation — unlocking happens
    // on the teaser card — so quote the full generation price, not the
    // reuse/owned price the estimate endpoint reports for existing artifacts.
    const dialogEstimate: LlmEstimate | null = estimate.data
        ? { ...estimate.data, reused: false, creditCost: CREDIT_COSTS["summary:long"] }
        : null;
    const lockedInfo = summary.data?.locked ? summary.data : null;
    const long = (summary.data && !summary.data.locked && summary.data.long) || null;

    if (summary.isPending) {
        return <Loading label="Loading summary" />;
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
        });
        setConfirmOpen(false);
    }

    async function unlockSummary() {
        // Teaser IS the confirm — straight to the flat-price charge; the
        // server returns the stored artifact instantly (no job, no LLM).
        await generate.mutateAsync({ mode: "long" });
    }

    return (
        <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <Badge variant="cyber-secondary">AI signal · long-form</Badge>
                    <h3 className="mt-3 text-2xl font-bold">Whole-video summary</h3>
                </div>
                <div className="flex items-center gap-1">
                    {createShare && long !== null ? (
                        <ShareButton
                            onShare={() => createShare.mutateAsync({ kind: "summary", videoId, mode: "long" })}
                            onCopied={() => {
                                setLinkCopied(true);
                                setTimeout(() => setLinkCopied(false), 2000);
                            }}
                        />
                    ) : null}
                    {lockedInfo === null ? (
                        <Button
                            data-testid="summary-generate"
                            onClick={() => setConfirmOpen(true)}
                            disabled={generate.isPending}
                        >
                            {long === null ? "Generate summary…" : "Re-generate…"}
                        </Button>
                    ) : null}
                </div>
            </div>
            {linkCopied ? <p className="text-sm text-primary">Link copied</p> : null}
            <SummaryControlsBar value={controls} onChange={setControls} disabled={generate.isPending} hideFormat />
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
            {lockedInfo !== null ? (
                <div data-testid="summary-locked" className="space-y-3 rounded-2xl border border-white/8 bg-black/20 p-3">
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
                            disabled={generate.isPending}
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
                            onClick={() => setConfirmOpen(true)}
                            disabled={generate.isPending}
                        >
                            Regenerate fresh…
                        </Button>
                    </div>
                </div>
            ) : long === null ? (
                <p
                    data-testid="summary-empty"
                    className="rounded-2xl border border-dashed border-primary/25 p-5 text-muted-foreground"
                >
                    No long-form summary yet. Click{" "}
                    <span className="font-semibold text-foreground/95">Generate summary</span> to send the compacted
                    transcript to your LLM and get back a structured TL;DR + key points + learnings + chapters +
                    verdict.
                </p>
            ) : (
                <LongSummaryView summary={long} />
            )}
            <LlmConfirmDialog
                open={confirmOpen}
                title="Generate long-form summary?"
                description={`Sends the compacted transcript to your LLM and asks for a TL;DR + 3-10 key points + 2-8 learnings + 1-12 chapters + an optional verdict. Tone: ${controls.tone}. Length: ${controls.length}.`}
                payloadSummary="Compacted transcript text; structured-output JSON response."
                busy={generate.isPending}
                confirmLabel={long === null ? "Generate" : "Re-generate"}
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
