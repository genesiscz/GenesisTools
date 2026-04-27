import { Button } from "@app/utils/ui/components/button";
import { formatTimecode } from "@app/utils/ui/components/youtube/time";
import type { TimestampedSummaryEntry } from "@app/youtube/lib/types";

export function InsightsSectionCard({
    entry,
    onSeek,
}: {
    entry: TimestampedSummaryEntry;
    onSeek: (sec: number) => void;
}) {
    return (
        <article className="rounded-2xl border border-secondary/20 bg-secondary/5 p-4 transition hover:-translate-y-0.5 hover:border-secondary/45 hover:bg-secondary/10">
            <div className="mb-2 flex flex-wrap items-center gap-3">
                <span className="text-2xl leading-none">{entry.icon ?? "🎯"}</span>
                <Button
                    variant="ghost"
                    size="sm"
                    className="yt-timecode h-8 px-3"
                    onClick={() => onSeek(entry.startSec)}
                >
                    {formatTimecode(entry.startSec)}–{formatTimecode(entry.endSec)}
                </Button>
                {entry.title ? <h4 className="font-semibold text-foreground/95">{entry.title}</h4> : null}
            </div>
            {entry.question ? <p className="mt-1 text-sm font-medium text-cyan-200">{entry.question}</p> : null}
            <p className="mt-1 leading-7 text-foreground/90">{entry.text}</p>
        </article>
    );
}
