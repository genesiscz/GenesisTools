import type { DashboardSession } from "@app/utils/log-viewer/log-source";
import { formatRelativeTime } from "@/lib/format";
import type { ConnectionStatus } from "@/lib/sse";
import { StatusPill } from "./StatusPill";

interface Props {
    sessions: DashboardSession[];
    activeSource: string | null;
    activeSession: string | null;
    onSelectSession: (source: string, name: string) => void;
    status: ConnectionStatus;
    entryCount: number;
    onClear: () => void;
    onRefresh: () => void;
}

function badgeClass(badge: string): string {
    if (badge === "task") {
        return "bg-cyan-500/20 text-cyan-300 border-cyan-500/30";
    }

    return "bg-purple-500/20 text-purple-300 border-purple-500/30";
}

export function Header({
    sessions,
    activeSource,
    activeSession,
    onSelectSession,
    status,
    entryCount,
    onClear,
    onRefresh,
}: Props): React.ReactElement {
    const meta = sessions.find((s) => s.source === activeSource && s.name === activeSession);
    const selectValue = activeSource && activeSession ? `${activeSource}:${activeSession}` : "";

    return (
        <header className="sticky top-0 z-20 glass-card border-b border-white/8">
            <div className="px-3 sm:px-5 py-2.5 flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-3 mr-auto">
                    <span className="brand-title text-[13px] sm:text-[15px]">▓▓▓ LOG VIEWER</span>
                    {meta ? (
                        <span
                            className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${badgeClass(meta.badge)}`}
                        >
                            {meta.badge}
                        </span>
                    ) : null}
                    <StatusPill status={status} />
                </div>

                <select
                    aria-label="active session"
                    value={selectValue}
                    onChange={(e) => {
                        const [source, name] = e.target.value.split(":");
                        if (source && name) {
                            onSelectSession(source, name);
                        }
                    }}
                    className="bg-black/40 border border-white/10 text-white/90 text-xs px-2.5 py-1.5 rounded-md focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 max-w-[20rem]"
                >
                    {sessions.length === 0 ? <option value="">no sessions</option> : null}
                    {sessions.map((s) => (
                        <option key={`${s.source}:${s.name}`} value={`${s.source}:${s.name}`}>
                            [{s.badge}] {s.name}
                            {s.lastActivityAt ? ` · ${formatRelativeTime(s.lastActivityAt)}` : ""}
                        </option>
                    ))}
                </select>

                <button
                    type="button"
                    onClick={onRefresh}
                    className="text-[10px] uppercase tracking-wider text-white/50 hover:text-white/90 px-2 py-1 border border-white/10 rounded-md hover:border-cyan-500/40 transition-colors"
                    title="refetch session list"
                >
                    ↻
                </button>

                <button
                    type="button"
                    onClick={onClear}
                    disabled={!activeSession || entryCount === 0}
                    className="text-[10px] uppercase tracking-wider text-rose-400/70 hover:text-rose-300 px-2 py-1 border border-rose-500/20 hover:border-rose-500/60 rounded-md disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                    clear
                </button>
            </div>

            {meta?.projectPath ? (
                <div className="px-3 sm:px-5 pb-2 text-[10px] text-white/40 truncate-mono" title={meta.projectPath}>
                    {meta.projectPath}
                </div>
            ) : null}
        </header>
    );
}
