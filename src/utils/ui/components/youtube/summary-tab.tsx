import { Badge } from "@app/utils/ui/components/badge";
import { Button } from "@app/utils/ui/components/button";
import { LlmConfirmDialog } from "@app/utils/ui/components/youtube/llm-confirm-dialog";
import { Loading } from "@app/utils/ui/components/youtube/loading";
import { LongSummaryView } from "@app/utils/ui/components/youtube/long-summary-view";
import {
    DEFAULT_SUMMARY_CONTROLS,
    SummaryControlsBar,
    type SummaryControlsState,
} from "@app/utils/ui/components/youtube/summary-controls";
import type { VideoId, VideoLongSummary } from "@app/youtube/lib/types";
import { useState } from "react";

export interface SummaryTabProps {
    videoId: VideoId;
    useSummary: (
        id: VideoId | null,
        mode: "short" | "timestamped" | "long"
    ) => { data: { long?: VideoLongSummary | null; cached?: boolean } | undefined; isPending: boolean };
    useGenerateSummary: (id: VideoId) => {
        mutateAsync: (opts: {
            mode: "short" | "timestamped" | "long";
            force?: boolean;
            provider?: string;
            model?: string;
            tone?: SummaryControlsState["tone"];
            length?: SummaryControlsState["length"];
        }) => Promise<{ long?: VideoLongSummary | null; cached: boolean; jobId?: number }>;
        isPending: boolean;
        error?: Error | null;
    };
}

export function SummaryTab({ videoId, useSummary, useGenerateSummary }: SummaryTabProps) {
    const summary = useSummary(videoId, "long");
    const generate = useGenerateSummary(videoId);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [controls, setControls] = useState<SummaryControlsState>(DEFAULT_SUMMARY_CONTROLS);
    const long = summary.data?.long ?? null;

    if (summary.isPending) {
        return <Loading label="Loading summary" />;
    }

    async function runGenerate({ provider, model }: { provider?: string; model?: string }) {
        await generate.mutateAsync({
            mode: "long",
            force: long !== null,
            provider,
            model,
            tone: controls.tone,
            length: controls.length,
        });
        setConfirmOpen(false);
    }

    return (
        <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <Badge variant="cyber-secondary">AI signal · long-form</Badge>
                    <h3 className="mt-3 text-2xl font-bold">Whole-video summary</h3>
                </div>
                <Button
                    data-testid="summary-generate"
                    onClick={() => setConfirmOpen(true)}
                    disabled={generate.isPending}
                >
                    {long === null ? "Generate summary…" : "Re-generate…"}
                </Button>
            </div>
            <SummaryControlsBar value={controls} onChange={setControls} disabled={generate.isPending} hideFormat />
            {long === null ? (
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
                billingNote="LLM cost depends on the provider you select."
                busy={generate.isPending}
                confirmLabel={long === null ? "Generate" : "Re-generate"}
                error={generate.error ? (generate.error as Error).message : null}
                onCancel={() => setConfirmOpen(false)}
                onConfirm={runGenerate}
            />
        </div>
    );
}
