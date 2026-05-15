import type { RunSummary } from "@app/daemon/lib/types";

interface Props {
    runs: RunSummary[];
    onSelect: (logFile: string) => void;
}

function exitDisplay(exitCode: number | null): { text: string; color: string } {
    if (exitCode === null) {
        return { text: "killed", color: "#fbbf24" };
    }

    if (exitCode === 0) {
        return { text: "0", color: "var(--dd-accent-from)" };
    }

    return { text: String(exitCode), color: "#f87171" };
}

function formatDuration(ms: number | null): string {
    if (ms === null) {
        return "—";
    }

    if (ms < 1000) {
        return `${ms}ms`;
    }

    return `${(ms / 1000).toFixed(1)}s`;
}

export function RunsTimeline({ runs, onSelect }: Props) {
    if (runs.length === 0) {
        return (
            <div className="dd-panel p-4 text-sm text-[var(--dd-text-muted)]">
                No recent runs.
            </div>
        );
    }

    return (
        <div className="dd-panel p-4">
            <h2 className="dd-accent-text mb-3 text-sm font-semibold">Recent Runs</h2>
            <div className="flex flex-col gap-1">
                {runs.map((run) => {
                    const exit = exitDisplay(run.exitCode);

                    return (
                        <button
                            type="button"
                            key={`${run.taskName}-${run.runId}-${run.attempt}`}
                            onClick={() => onSelect(run.logFile)}
                            className="flex items-center justify-between rounded border border-[var(--dd-border)] px-3 py-2 text-left text-sm transition-colors hover:border-[var(--dd-accent-from)]"
                        >
                            <span className="text-[var(--dd-text-primary)]">{run.taskName}</span>
                            <span className="text-xs text-[var(--dd-text-muted)]">
                                {run.startedAt}
                            </span>
                            <span className="text-xs text-[var(--dd-text-secondary)]">
                                {formatDuration(run.duration_ms)}
                            </span>
                            <span className="text-xs font-mono" style={{ color: exit.color }}>
                                {exit.text}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
