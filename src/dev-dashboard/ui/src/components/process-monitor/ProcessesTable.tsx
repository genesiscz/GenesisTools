import type { ProcessInfo, ProcessSort } from "@app/dev-dashboard/lib/system/types";

interface ProcessesTableProps {
    processes: ProcessInfo[];
    sort: ProcessSort;
    onSortChange: (sort: ProcessSort) => void;
    onKill: (process: ProcessInfo) => void;
    killingPid: number | null;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;
const HIGH_CPU_PCT = 50;

function formatBytes(bytes: number): string {
    if (bytes >= GB) {
        return `${(bytes / GB).toFixed(1)} GB`;
    }

    return `${Math.round(bytes / MB)} MB`;
}

function formatUptime(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) {
        return "—";
    }

    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }

    if (minutes > 0) {
        return `${minutes}m`;
    }

    return `${totalSeconds}s`;
}

const SORTS: ReadonlyArray<{ value: ProcessSort; label: string }> = [
    { value: "rss", label: "RSS" },
    { value: "name", label: "Name" },
];

export function ProcessesTable({ processes, sort, onSortChange, onKill, killingPid }: ProcessesTableProps) {
    return (
        <div className="dd-panel flex flex-col gap-4 p-4">
            <div className="flex items-center justify-between gap-4">
                <h3 className="dd-accent-text text-lg font-semibold">Processes ({processes.length})</h3>
                <div className="flex rounded-full border border-[var(--dd-border)] p-0.5">
                    {SORTS.map((option) => {
                        const active = option.value === sort;

                        return (
                            <button
                                type="button"
                                key={option.value}
                                onClick={() => onSortChange(option.value)}
                                aria-pressed={active}
                                className="rounded-full px-3 py-1 text-xs font-semibold transition-colors"
                                style={{
                                    backgroundColor: active ? "var(--dd-accent-muted)" : "transparent",
                                    color: active ? "var(--dd-accent)" : "var(--dd-text-muted)",
                                }}
                            >
                                {option.label}
                            </button>
                        );
                    })}
                </div>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-left text-[var(--dd-text-secondary)]">
                            <th className="px-2 py-2 font-medium">Name</th>
                            <th className="px-2 py-2 font-medium">PID</th>
                            <th className="px-2 py-2 font-medium">Memory</th>
                            <th className="px-2 py-2 font-medium">CPU</th>
                            <th className="px-2 py-2 font-medium">Uptime</th>
                            <th className="px-2 py-2 font-medium" />
                        </tr>
                    </thead>
                    <tbody>
                        {processes.map((p) => {
                            const highCpu = p.cpuPct > HIGH_CPU_PCT;

                            return (
                                <tr
                                    key={p.pid}
                                    className="border-t border-[var(--dd-border)] text-[var(--dd-text-primary)]"
                                >
                                    <td className="px-2 py-2 font-medium">{p.name}</td>
                                    <td className="px-2 py-2 font-mono text-xs text-[var(--dd-text-muted)]">{p.pid}</td>
                                    <td className="px-2 py-2 text-[var(--dd-text-secondary)]">
                                        {formatBytes(p.rssBytes)}
                                    </td>
                                    <td
                                        className="px-2 py-2 font-mono text-xs"
                                        style={{ color: highCpu ? "#f87171" : "var(--dd-text-secondary)" }}
                                    >
                                        {Math.round(p.cpuPct)}%
                                    </td>
                                    <td className="px-2 py-2 text-[var(--dd-text-muted)]">{formatUptime(p.uptimeMs)}</td>
                                    <td className="px-2 py-2 text-right">
                                        <button
                                            type="button"
                                            onClick={() => onKill(p)}
                                            disabled={killingPid === p.pid}
                                            className="rounded-md border border-[var(--dd-border)] px-3 py-1 text-xs font-semibold transition-colors hover:border-[#f87171] disabled:opacity-50"
                                            style={{ color: "#f87171" }}
                                        >
                                            {killingPid === p.pid ? "Killing…" : "Kill"}
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
                {processes.length === 0 ? (
                    <p className="px-2 py-4 text-[var(--dd-text-muted)]">No processes.</p>
                ) : null}
            </div>
        </div>
    );
}
