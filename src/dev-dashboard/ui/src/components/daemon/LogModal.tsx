import type { LogEntry } from "@app/daemon/lib/types";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";

interface Props {
    logFile: string | null;
    onClose: () => void;
}

function LogLineRow({ entry }: { entry: LogEntry }) {
    if (entry.type === "meta") {
        return (
            <div className="dd-accent-text border-b border-[var(--dd-border)] pb-2 text-xs">
                {entry.taskName} · {entry.command} · run {entry.runId} · attempt {entry.attempt} · {entry.startedAt}
            </div>
        );
    }

    if (entry.type === "exit") {
        const color = entry.code === 0 ? "var(--dd-accent-from)" : "#f87171";

        return (
            <div className="text-xs" style={{ color }}>
                [exit] code={entry.code === null ? "killed" : entry.code} ({entry.duration_ms}ms)
            </div>
        );
    }

    const color = entry.type === "stderr" ? "#fbbf24" : "var(--dd-text-primary)";

    return (
        <div className="whitespace-pre-wrap font-mono text-xs" style={{ color }}>
            {entry.data}
        </div>
    );
}

export function LogModal({ logFile, onClose }: Props) {
    const { data, isLoading, isError, error } = useQuery({
        queryKey: ["daemon", "runs", "log", logFile],
        queryFn: (): Promise<LogEntry[]> =>
            fetchJson<LogEntry[]>(`/api/daemon/runs/log?logFile=${encodeURIComponent(logFile ?? "")}`),
        enabled: logFile !== null,
    });

    if (logFile === null) {
        return null;
    }

    return (
        // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="daemon-run-log-title"
                className="dd-panel flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden p-4"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="mb-3 flex items-center justify-between">
                    <h2 id="daemon-run-log-title" className="dd-accent-text text-sm font-semibold">
                        Run Log
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-sm text-[var(--dd-text-muted)] hover:text-[var(--dd-text-primary)]"
                    >
                        Close
                    </button>
                </div>
                <div className="flex flex-col gap-1 overflow-y-auto">
                    {isLoading ? (
                        <div className="text-sm text-[var(--dd-text-muted)]">Loading log...</div>
                    ) : isError ? (
                        <div className="text-sm text-[#f87171]">
                            Failed to load log: {error instanceof Error ? error.message : String(error)}
                        </div>
                    ) : (data ?? []).length === 0 ? (
                        <div className="text-sm text-[var(--dd-text-muted)]">Empty log.</div>
                    ) : (
                        (data ?? []).map((entry, i) => <LogLineRow key={`${entry.type}-${i}`} entry={entry} />)
                    )}
                </div>
            </div>
        </div>
    );
}
