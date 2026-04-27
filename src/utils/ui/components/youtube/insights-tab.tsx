import { Badge } from "@app/utils/ui/components/badge";
import { Button } from "@app/utils/ui/components/button";
import { LlmConfirmDialog } from "@app/utils/ui/components/youtube/llm-confirm-dialog";
import { Loading } from "@app/utils/ui/components/youtube/loading";
import {
    DEFAULT_SUMMARY_CONTROLS,
    SummaryControlsBar,
    type SummaryControlsState,
} from "@app/utils/ui/components/youtube/summary-controls";
import { TimestampedSummaryView } from "@app/utils/ui/components/youtube/timestamped-summary-view";
import type { TimestampedSummaryEntry, VideoId, VideoLongSummary } from "@app/youtube/lib/types";
import { useState } from "react";

export interface InsightsTabProps {
    videoId: VideoId;
    onSeek: (seconds: number) => void;
    useSummary: (
        id: VideoId | null,
        mode: "short" | "timestamped" | "long"
    ) => {
        data: { timestamped?: TimestampedSummaryEntry[]; long?: VideoLongSummary | null; cached?: boolean } | undefined;
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
}

export function InsightsTab({ videoId, onSeek, useSummary, useGenerateSummary }: InsightsTabProps) {
    const timestamped = useSummary(videoId, "timestamped");
    const long = useSummary(videoId, "long");
    const generate = useGenerateSummary(videoId);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [controls, setControls] = useState<SummaryControlsState>(DEFAULT_SUMMARY_CONTROLS);
    const entries = timestamped.data?.timestamped ?? [];
    const tldr = long.data?.long?.tldr ?? null;

    if (timestamped.isPending) {
        return <Loading label="Loading insights" />;
    }

    async function runGenerate({ provider, model }: { provider?: string; model?: string }) {
        await generate.mutateAsync({
            mode: "timestamped",
            force: entries.length > 0,
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
            {entries.length === 0 ? (
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
                billingNote="LLM cost depends on the provider you select."
                busy={generate.isPending}
                confirmLabel={entries.length === 0 ? "Generate" : "Re-generate"}
                error={generate.error ? (generate.error as Error).message : null}
                onCancel={() => setConfirmOpen(false)}
                onConfirm={runGenerate}
            />
        </div>
    );
}
