import { useState } from "react";
import { Button } from "@app/utils/ui/components/button";
import { LlmConfirmDialog } from "@app/utils/ui/components/youtube/llm-confirm-dialog";
import { Loading } from "@app/utils/ui/components/youtube/loading";
import { formatTimecode } from "@app/utils/ui/components/youtube/time";
import type { TimestampedSummaryEntry, VideoId } from "@app/youtube/lib/types";

export interface SummaryTabProps {
    videoId: VideoId;
    onSeek: (seconds: number) => void;
    useSummary: (id: VideoId | null, mode: "short" | "timestamped") => { data: { timestamped?: TimestampedSummaryEntry[]; cached?: boolean } | undefined; isPending: boolean };
    useGenerateSummary: (id: VideoId) => {
        mutateAsync: (opts: { mode: "short" | "timestamped"; force?: boolean; provider?: string; model?: string; targetBins?: number }) => Promise<{ timestamped?: TimestampedSummaryEntry[]; cached: boolean }>;
        isPending: boolean;
    };
}

export function SummaryTab({ videoId, onSeek, useSummary, useGenerateSummary }: SummaryTabProps) {
    const summary = useSummary(videoId, "timestamped");
    const generate = useGenerateSummary(videoId);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const entries = summary.data?.timestamped ?? [];

    if (summary.isPending) {
        return <Loading label="Loading summary" />;
    }

    async function runGenerate({ provider, model }: { provider?: string; model?: string }, force = false) {
        await generate.mutateAsync({ mode: "timestamped", force, provider, model, targetBins: 12 });
        setConfirmOpen(false);
    }

    return (
        <div className="space-y-5">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <p className="font-mono text-xs uppercase tracking-[0.28em] text-primary">Timestamped Summary</p>
                    <h3 className="mt-2 text-3xl font-bold leading-tight">Money moments and key beats</h3>
                </div>
                <div className="flex flex-col items-end gap-1">
                    <Button data-testid="summary-generate" onClick={() => setConfirmOpen(true)} disabled={generate.isPending}>
                        {entries.length === 0 ? "Generate summary…" : "Re-generate…"}
                    </Button>
                    {entries.length > 0 ? <span className="text-xs text-muted-foreground">cached · click to refresh</span> : null}
                </div>
            </div>
            {entries.length === 0 ? (
                <p data-testid="summary-empty" className="rounded-2xl border border-dashed border-primary/25 p-5 text-muted-foreground">
                    No timestamped summary yet. Generating will send the full transcript to the LLM in a single call (no per-bin loops).
                </p>
            ) : null}
            <div className="space-y-3">
                {entries.map((entry, index) => (
                    <article key={`${entry.startSec}-${index}`} className="rounded-2xl border border-secondary/20 bg-secondary/5 p-4">
                        <div className="mb-3 flex items-center gap-2">
                            <span className="text-xl">{index % 2 === 0 ? "💸" : "💰"}</span>
                            <Button variant="ghost" size="sm" className="yt-timecode h-8 px-3" onClick={() => onSeek(entry.startSec)}>
                                {formatTimecode(entry.startSec)}–{formatTimecode(entry.endSec)}
                            </Button>
                        </div>
                        <p className="leading-7 text-foreground/90">{entry.text}</p>
                    </article>
                ))}
            </div>
            <LlmConfirmDialog
                open={confirmOpen}
                title="Generate timestamped summary?"
                description="This will send the full transcript to your configured LLM in one request and ask for ~12 timestamped highlights as JSON."
                payloadSummary="Full transcript with timestamps; expected response ≤ ~3 KB JSON."
                defaultProvider="(server-configured)"
                defaultModel="(server-configured)"
                billingNote="Tip: leave provider/model blank to use the server's default (server.json → provider.summarize)."
                busy={generate.isPending}
                confirmLabel={entries.length === 0 ? "Generate" : "Re-generate"}
                onCancel={() => setConfirmOpen(false)}
                onConfirm={(overrides) => runGenerate(overrides, entries.length > 0)}
            />
        </div>
    );
}
