import { useState } from "react";
import { Badge } from "@app/utils/ui/components/badge";
import { Button } from "@app/utils/ui/components/button";
import { LlmConfirmDialog } from "@app/utils/ui/components/youtube/llm-confirm-dialog";
import { Loading } from "@app/utils/ui/components/youtube/loading";
import type { TimestampedSummaryEntry, VideoId } from "@app/youtube/lib/types";

const fallbackIcons = ["🎯", "💰", "🏆"];

export interface InsightsTabProps {
    videoId: VideoId;
    useSummary: (id: VideoId | null, mode: "short" | "timestamped") => { data: { short?: string; timestamped?: TimestampedSummaryEntry[] } | undefined; isPending: boolean };
    useGenerateSummary: (id: VideoId) => {
        mutateAsync: (opts: { mode: "short" | "timestamped"; force?: boolean; provider?: string; model?: string }) => Promise<{ short?: string; cached: boolean }>;
        isPending: boolean;
    };
}

export function InsightsTab({ videoId, useSummary, useGenerateSummary }: InsightsTabProps) {
    const summary = useSummary(videoId, "short");
    const generate = useGenerateSummary(videoId);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const shortSummary = summary.data?.short ?? "";
    const bullets = parseInsights(shortSummary);

    if (summary.isPending) {
        return <Loading label="Loading insights" />;
    }

    async function runGenerate({ provider, model }: { provider?: string; model?: string }) {
        await generate.mutateAsync({ mode: "short", force: shortSummary.length > 0, provider, model });
        setConfirmOpen(false);
    }

    return (
        <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <Badge variant="cyber-secondary">AI signal</Badge>
                    <h3 className="mt-3 text-2xl font-bold">Key insights</h3>
                </div>
                <Button data-testid="insights-generate" onClick={() => setConfirmOpen(true)} disabled={generate.isPending}>
                    {shortSummary.length === 0 ? "Generate insights…" : "Re-generate…"}
                </Button>
            </div>
            <div className="space-y-3">
                {bullets.map((bullet, index) => (
                    <div key={`${bullet.text}-${index}`} className="rounded-2xl border border-primary/20 bg-primary/5 p-4 transition hover:border-primary/40 hover:bg-primary/10">
                        <div className="flex gap-3">
                            <span className="text-2xl leading-none">{bullet.icon}</span>
                            <p className="leading-7 text-foreground/90">{bullet.text}</p>
                        </div>
                    </div>
                ))}
            </div>
            <LlmConfirmDialog
                open={confirmOpen}
                title="Generate AI insights?"
                description="This will send the full transcript to your configured LLM and ask for a short summary."
                payloadSummary="Full transcript text; expected response ≤ ~1 KB."
                defaultProvider="(server-configured)"
                defaultModel="(server-configured)"
                billingNote="Configure the default in server.json under provider.summarize. Override here if needed."
                busy={generate.isPending}
                confirmLabel={shortSummary.length === 0 ? "Generate" : "Re-generate"}
                onCancel={() => setConfirmOpen(false)}
                onConfirm={runGenerate}
            />
        </div>
    );
}

function parseInsights(value: string): Array<{ icon: string; text: string }> {
    if (!value) {
        return [{ icon: "🎯", text: "No insights yet. Click \"Generate insights\" to ask the LLM for a short summary of this transcript." }];
    }

    const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
    const parsed = lines
        .map((line, index) => {
            const match = line.match(/^([🎯💰🏆💸⭐🔥🚀✅•\-])\s*(.+)$/u);
            return { icon: match?.[1] && match[1] !== "-" && match[1] !== "•" ? match[1] : fallbackIcons[index % fallbackIcons.length], text: match?.[2] ?? line };
        })
        .slice(0, 8);

    if (parsed.length > 0) {
        return parsed;
    }

    return [{ icon: "🎯", text: value.slice(0, 280) }];
}
