import type { SessionMeta } from "@app/debugging-master/types";
import { formatRelativeTime } from "@/lib/format";
import type { ConnectionStatus } from "@/lib/sse";
import { StatusPill } from "./StatusPill";

interface Props {
    sessions: SessionMeta[];
    activeSession: string | null;
    onSelectSession: (name: string) => void;
    status: ConnectionStatus;
    entryCount: number;
    onClear: () => void;
    onRefresh: () => void;
}

export function Header({
    sessions,
    activeSession,
    onSelectSession,
    status,
    entryCount,
    onClear,
    onRefresh,
}: Props): React.ReactElement {
    const meta = sessions.find((s) => s.name === activeSession);

    return (
        <header className="sticky top-0 z-20 glass-card border-b border-white/8">
            <div className="px-3 sm:px-5 py-2.5 flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-3 mr-auto">
                    <span className="brand-title text-[13px] sm:text-[15px]">▓▓▓ DBG-MASTER</span>
                    <StatusPill status={status} />
                </div>

                <select
                    aria-label="active session"
                    value={activeSession ?? ""}
                    onChange={(e) => onSelectSession(e.target.value)}
                    className="bg-black/40 border border-white/10 text-white/90 text-xs px-2.5 py-1.5 rounded-md focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 max-w-[16rem]"
                >
                    {sessions.length === 0 ? <option value="">no sessions</option> : null}
                    {sessions.map((s) => (
                        <option key={s.name} value={s.name}>
                            {s.name}
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
