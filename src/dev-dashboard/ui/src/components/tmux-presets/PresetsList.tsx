import type { TmuxPresetSummary } from "@app/dev-dashboard/contract/dto";
import { Button } from "@ui/components/button";
import { RefreshCw, Trash2 } from "lucide-react";

interface PresetsListProps {
    presets: TmuxPresetSummary[];
    onRestore: (name: string) => void;
    onDelete: (name: string) => void;
    restoringName: string | null;
    deletingName: string | null;
}

/** "3 sessions · 7 windows · 12 panes" (singular-aware). */
function summaryLine(s: Pick<TmuxPresetSummary, "sessions" | "windows" | "panes">): string {
    const part = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;
    return `${part(s.sessions, "session")} · ${part(s.windows, "window")} · ${part(s.panes, "pane")}`;
}

/** Human file size for the on-disk preset (KB/MB), em-dash on 0/negative. */
function formatBytes(bytes: number): string {
    if (!bytes || bytes < 0) {
        return "—";
    }

    if (bytes < 1024) {
        return `${bytes} B`;
    }

    const kb = bytes / 1024;
    if (kb < 1024) {
        return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
    }

    return `${(kb / 1024).toFixed(1)} MB`;
}

/** ISO → short local date-time; em-dash on unparseable. */
function formatCapturedAt(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
        return "—";
    }

    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function PresetsList({ presets, onRestore, onDelete, restoringName, deletingName }: PresetsListProps) {
    if (presets.length === 0) {
        return (
            <div className="dd-panel flex h-full items-center justify-center p-8 text-center text-[var(--dd-text-muted)]">
                No presets — capture the current tmux layout to save your first preset.
            </div>
        );
    }

    return (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {presets.map((preset) => (
                <div
                    key={preset.name}
                    data-testid={`tmux-presets-row-${preset.name}`}
                    className="dd-panel flex flex-col gap-3 p-4"
                >
                    <div className="flex items-center justify-between gap-2">
                        <h3 className="dd-accent-text truncate font-mono text-base font-semibold">{preset.name}</h3>
                        <span className="dd-dot shrink-0 rounded-full border border-[var(--dd-border)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-[var(--dd-accent-from)]">
                            {preset.panes} panes
                        </span>
                    </div>

                    <dl className="flex flex-col gap-1 text-sm">
                        <div className="flex items-center justify-between">
                            <dt className="text-[var(--dd-text-muted)]">Layout</dt>
                            <dd
                                data-testid={`tmux-presets-summary-${preset.name}`}
                                className="font-mono text-[var(--dd-text-primary)]"
                            >
                                {summaryLine(preset)}
                            </dd>
                        </div>
                        <div className="flex items-center justify-between">
                            <dt className="text-[var(--dd-text-muted)]">Captured</dt>
                            <dd className="font-mono text-[var(--dd-text-secondary)]">
                                {formatCapturedAt(preset.capturedAt)}
                            </dd>
                        </div>
                        <div className="flex items-center justify-between">
                            <dt className="text-[var(--dd-text-muted)]">Size</dt>
                            <dd className="font-mono text-[var(--dd-text-secondary)]">{formatBytes(preset.bytes)}</dd>
                        </div>
                    </dl>

                    {preset.note ? (
                        <p className="font-mono text-xs text-[var(--dd-text-muted)]">{preset.note}</p>
                    ) : null}

                    <div className="mt-1 flex gap-2">
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            data-testid={`tmux-presets-restore-${preset.name}`}
                            disabled={restoringName === preset.name}
                            onClick={() => onRestore(preset.name)}
                            className="dd-btn-accent flex-1 hover:bg-transparent"
                        >
                            <RefreshCw size={14} />
                            {restoringName === preset.name ? "Restoring..." : "Restore"}
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            data-testid={`tmux-presets-delete-${preset.name}`}
                            disabled={deletingName === preset.name}
                            onClick={() => onDelete(preset.name)}
                            className="shrink-0 border border-[var(--dd-border)] text-[var(--dd-danger)] hover:bg-transparent"
                        >
                            <Trash2 size={14} />
                            {deletingName === preset.name ? "Deleting..." : "Delete"}
                        </Button>
                    </div>
                </div>
            ))}
        </div>
    );
}
