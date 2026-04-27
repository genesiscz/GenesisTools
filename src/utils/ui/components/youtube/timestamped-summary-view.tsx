import { InsightsSectionCard } from "@app/utils/ui/components/youtube/insights-section-card";
import type { TimestampedSummaryEntry } from "@app/youtube/lib/types";

export interface TimestampedSummaryViewProps {
    entries: TimestampedSummaryEntry[];
    /** Optional TLDR sourced from `summaryLong.tldr` so Insights leads with a 2-3 sentence overview. */
    tldr?: string | null;
    onSeek: (sec: number) => void;
}

export function TimestampedSummaryView({ entries, tldr, onSeek }: TimestampedSummaryViewProps) {
    return (
        <div className="space-y-4">
            {tldr ? (
                <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
                    <p className="font-mono text-[0.65rem] uppercase tracking-[0.28em] text-primary">TL;DR</p>
                    <p className="mt-2 leading-7 text-foreground/95">{tldr}</p>
                </div>
            ) : null}
            <div className="space-y-3">
                {entries.map((entry, index) => (
                    <InsightsSectionCard key={`${entry.startSec}-${index}`} entry={entry} onSeek={onSeek} />
                ))}
            </div>
        </div>
    );
}
