import { Badge } from "@app/utils/ui/components/badge";
import { Loading } from "@yt/components/shared/loading";
import { useSummary } from "@yt/api.hooks";
import type { VideoId } from "@app/youtube/lib/types";

const fallbackIcons = ["🎯", "💰", "🏆"];

export function InsightsTab({ videoId }: { videoId: VideoId }) {
    const summary = useSummary(videoId, "short");
    const bullets = parseInsights(summary.data?.short ?? "");

    if (summary.isPending) {
        return <Loading label="Extracting insights" />;
    }

    return (
        <div className="space-y-4">
            <div>
                <Badge variant="cyber-secondary">AI signal</Badge>
                <h3 className="mt-3 text-2xl font-bold">Key insights</h3>
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
        </div>
    );
}

function parseInsights(value: string): Array<{ icon: string; text: string }> {
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

    return [{ icon: "🎯", text: "No insight bullets yet. Generate a short summary to populate this panel." }];
}
