import { formatBucketLabel } from "./bucket-label";

interface BucketBarProps {
    bucket: string;
    scopeModel?: string | null;
    utilization: number;
    resetsAt: string | null;
}

function barColor(utilization: number): string {
    if (utilization > 85) {
        return "#f87171";
    }

    if (utilization >= 60) {
        return "#fbbf24";
    }

    return "var(--dd-accent-from)";
}

function formatResetsIn(resetsAt: string | null): string | null {
    if (!resetsAt) {
        return null;
    }

    const diffMs = new Date(resetsAt).getTime() - Date.now();
    if (Number.isNaN(diffMs) || diffMs <= 0) {
        return null;
    }

    const totalMinutes = Math.floor(diffMs / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `resets in ${hours}h ${minutes}m`;
}

export function BucketBar({ bucket, scopeModel, utilization, resetsAt }: BucketBarProps) {
    const label = formatBucketLabel(bucket, scopeModel);
    const pct = Math.max(0, Math.min(100, utilization));
    const color = barColor(utilization);
    const resetsIn = formatResetsIn(resetsAt);
    const notUsed = !resetsAt && utilization === 0;

    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between text-sm">
                <span className="text-[var(--dd-text-secondary)]">{label}</span>
                <span className="font-mono text-[var(--dd-text-primary)]">{pct.toFixed(0)}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--dd-border)]">
                <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${pct}%`, backgroundColor: color }}
                />
            </div>
            {notUsed ? (
                <span className="text-xs text-[var(--dd-text-muted)]">Not used</span>
            ) : resetsIn ? (
                <span className="text-xs text-[var(--dd-text-muted)]">{resetsIn}</span>
            ) : null}
        </div>
    );
}
