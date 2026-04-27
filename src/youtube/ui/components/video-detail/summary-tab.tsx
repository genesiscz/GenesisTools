import { Button } from "@app/utils/ui/components/button";
import { Loading } from "@yt/components/shared/loading";
import { formatTimecode } from "@yt/lib/time";
import { useSummary } from "@yt/api.hooks";
import type { VideoId } from "@app/youtube/lib/types";

export function SummaryTab({ videoId, onSeek }: { videoId: VideoId; onSeek: (seconds: number) => void }) {
    const summary = useSummary(videoId, "timestamped");
    const entries = summary.data?.timestamped ?? [];

    if (summary.isPending) {
        return <Loading label="Loading summary" />;
    }

    return (
        <div className="space-y-5">
            <div>
                <p className="font-mono text-xs uppercase tracking-[0.28em] text-primary">Timestamped Summary</p>
                <h3 className="mt-2 text-3xl font-bold leading-tight">Money moments and key beats</h3>
            </div>
            {entries.length === 0 ? <p className="rounded-2xl border border-dashed border-primary/25 p-5 text-muted-foreground">No timestamped summary has been generated for this video yet.</p> : null}
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
        </div>
    );
}
