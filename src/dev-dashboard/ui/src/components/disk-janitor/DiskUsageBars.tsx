import type { DiskUsageEntry, DiskUsageResult } from "@app/dev-dashboard/lib/disk/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip";

interface DiskUsageBarsProps {
    result: DiskUsageResult;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const KB = 1024;

/** Bytes → one-decimal GB/MB/KB (matches the mobile `formatBytes`). Negative/NaN → em dash. */
function formatBytes(bytes: number): string {
    if (Number.isNaN(bytes) || bytes < 0) {
        return "—";
    }

    if (bytes >= GB) {
        return `${(bytes / GB).toFixed(1)} GB`;
    }

    if (bytes >= MB) {
        return `${(bytes / MB).toFixed(1)} MB`;
    }

    return `${(bytes / KB).toFixed(1)} KB`;
}

/** Annotate each entry with its percentage of the largest (bar width). Preserves input desc order. */
function withPercentOfMax(entries: DiskUsageEntry[]): Array<DiskUsageEntry & { pct: number }> {
    const max = entries.reduce((m, e) => Math.max(m, e.bytes), 0);

    return entries.map((entry) => ({
        ...entry,
        pct: max > 0 ? Math.round((entry.bytes / max) * 100) : 0,
    }));
}

export function DiskUsageBars({ result }: DiskUsageBarsProps) {
    if (!result.available || result.entries.length === 0) {
        return (
            <div className="dd-panel flex h-full items-center justify-center p-8 text-center text-[var(--dd-text-muted)]">
                No scannable dev directories found on this host.
            </div>
        );
    }

    const ranked = withPercentOfMax(result.entries);

    return (
        <div className="dd-panel flex flex-col gap-4 p-4">
            <h3 className="dd-accent-text text-lg font-semibold">Biggest dev directories</h3>
            <div className="flex flex-col gap-3">
                {ranked.map((entry) => (
                    <div key={entry.path} className="flex flex-col gap-1.5">
                        <div className="flex items-baseline justify-between gap-2">
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <span
                                        tabIndex={0}
                                        className="truncate font-mono text-sm text-[var(--dd-text-primary)]"
                                    >
                                        {entry.label}
                                    </span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-lg break-all">{entry.path}</TooltipContent>
                            </Tooltip>
                            <span className="shrink-0 font-mono text-sm font-semibold text-[var(--dd-text-primary)]">
                                {formatBytes(entry.bytes)}
                            </span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--dd-border)]">
                            <div
                                className="h-2 rounded-full"
                                style={{ width: `${entry.pct}%`, background: "var(--dd-accent-gradient)" }}
                                role="img"
                                aria-label={`${entry.pct}% — ${formatBytes(entry.bytes)}`}
                            />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
