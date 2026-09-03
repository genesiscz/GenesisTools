import type { RecentPoint, WatcherStatus } from "@app/monitor/lib/types";
import { cn } from "@genesiscz/utils/ui/lib/utils";

// allow-palette: categorical status colors are semantic
const BAR_COLOR: Record<WatcherStatus, string> = {
    up: "bg-emerald-400/70 group-hover:bg-emerald-400",
    degraded: "bg-amber-400/80 group-hover:bg-amber-400",
    down: "bg-red-500/80 group-hover:bg-red-500",
    unknown: "bg-muted-foreground/30",
};

/**
 * Tiny bar sparkline: one bar per recent check, height = latency relative to
 * the max in the window, color = status. Pure DOM, no chart library, so 20
 * cards on the overview stay cheap.
 */
export function LatencySparkline({
    points,
    slots = 40,
    className,
}: {
    points: RecentPoint[];
    slots?: number;
    className?: string;
}) {
    const window = points.slice(-slots);
    const max = Math.max(1, ...window.map((point) => point.latencyMs ?? 0));
    const padding = Math.max(0, slots - window.length);

    return (
        <div className={cn("flex h-10 items-end gap-[2px]", className)} aria-hidden>
            {Array.from({ length: padding }).map((_, index) => (
                <span key={`pad-${index}`} className="flex-1 rounded-sm bg-muted-foreground/10" style={{ height: 2 }} />
            ))}
            {window.map((point, index) => {
                const height = point.latencyMs === null ? 100 : Math.max(8, (point.latencyMs / max) * 100);

                return (
                    <span
                        key={`${point.t}-${index}`}
                        title={`${point.status} · ${point.latencyMs ?? "—"} ms`}
                        className={cn("flex-1 rounded-sm transition-colors", BAR_COLOR[point.status])}
                        style={{ height: `${height}%` }}
                    />
                );
            })}
        </div>
    );
}
