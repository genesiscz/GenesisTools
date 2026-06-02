import type { RunSummary } from "@app/dev-dashboard/contract/dto";

interface Props {
    runs: RunSummary[];
    selectedLogFile: string | null;
    onSelect: (run: RunSummary) => void;
}

function exitDisplay(exitCode: number | null): { text: string; color: string } {
    if (exitCode === null) {
        return { text: "running", color: "var(--dd-accent-from)" };
    }

    if (exitCode === 0) {
        return { text: "exit 0", color: "var(--dd-text-muted)" };
    }

    return { text: `exit ${exitCode}`, color: "#f87171" };
}

/**
 * Run selector for the live build-log tail. One tappable row per recent daemon run (reuses
 * `GET /api/daemon/runs`); selecting one seeds the backlog + opens the SSE tail. Mirrors the daemon
 * `RunsTimeline` look (dd-panel + accent border on hover); the selected run is accent-bordered.
 */
export function RunPicker({ runs, selectedLogFile, onSelect }: Props) {
    if (runs.length === 0) {
        return (
            <div data-testid="build-log-tail-run-empty" className="dd-panel p-4 text-sm text-[var(--dd-text-muted)]">
                No recorded runs to tail.
            </div>
        );
    }

    return (
        <div data-testid="build-log-tail-run-picker" className="dd-panel p-4">
            <h2 className="dd-accent-text mb-3 text-sm font-semibold">Recent Runs</h2>
            <div className="flex flex-col gap-1">
                {runs.map((run) => {
                    const exit = exitDisplay(run.exitCode);
                    const selected = run.logFile === selectedLogFile;

                    return (
                        <button
                            type="button"
                            data-testid={`build-log-tail-run-${run.runId}`}
                            key={`${run.taskName}-${run.runId}-${run.attempt}`}
                            onClick={() => onSelect(run)}
                            className="flex items-center justify-between rounded border px-3 py-2 text-left text-sm transition-colors hover:border-[var(--dd-accent-from)]"
                            style={{
                                borderColor: selected ? "var(--dd-accent-from)" : "var(--dd-border)",
                                background: selected ? "var(--dd-accent-muted, transparent)" : "transparent",
                            }}
                        >
                            <span className="text-[var(--dd-text-primary)]">{run.taskName}</span>
                            <span className="text-xs text-[var(--dd-text-muted)]">{run.startedAt}</span>
                            <span className="font-mono text-xs" style={{ color: exit.color }}>
                                {exit.text}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
