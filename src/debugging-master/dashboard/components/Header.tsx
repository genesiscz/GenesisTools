import type { DashboardSession } from "@app/utils/log-viewer/log-source";
import { isLogSourceId, parseSessionKey, sessionKey } from "@app/utils/log-viewer/session-key";
import { sessionRecencyTs, sortSessionsByRecency } from "@app/utils/log-viewer/session-recency";
import { shortenPathWithPrefix } from "@app/utils/paths.client";
import { useDirPathPrefix } from "@ui/components/DirPath";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { useMemo } from "react";
import { formatRelativeTime } from "@/lib/format";
import { formatSessionHeaderParts } from "@/lib/session-run-context";
import type { ConnectionStatus } from "@/lib/sse";
import { useSessionDeleteConfirm } from "@/lib/ui/SessionDeleteConfirm";
import { DisplaySettingsButton } from "./DisplaySettingsButton";
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
    onBack: () => void;
}

function formatSessionSelectLabel(session: DashboardSession, pathPrefix: string): string {
    const header = formatSessionHeaderParts(session);
    const cwd = header.cwd ? shortenPathWithPrefix(header.cwd, pathPrefix) : undefined;
    const base = cwd ? `[${header.badge}] ${header.name} · ${cwd}` : `[${header.badge}] ${header.name}`;
    const recencyTs = sessionRecencyTs(session);

    if (recencyTs <= 0) {
        return base;
    }

    return `${base} · ${formatRelativeTime(recencyTs)}`;
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
    onBack,
}: Props): React.ReactElement {
    const { requestDelete } = useSessionDeleteConfirm();
    const pathPrefix = useDirPathPrefix();
    const meta = sessions.find((s) => s.source === activeSource && s.name === activeSession);
    const selectValue =
        activeSource && activeSession && isLogSourceId(activeSource) ? sessionKey(activeSource, activeSession) : "";
    const sortedSessions = useMemo(() => sortSessionsByRecency(sessions), [sessions]);
    const sessionOptions = useMemo(
        () =>
            sortedSessions.map((session) => ({
                value: sessionKey(session.source, session.name),
                label: formatSessionSelectLabel(session, pathPrefix),
            })),
        [sortedSessions, pathPrefix]
    );

    return (
        <header className="sticky top-0 z-20 glass-card border-b border-white/8">
            <div className="px-3 sm:px-5 py-2.5 flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-3 shrink-0">
                    <button
                        type="button"
                        onClick={onBack}
                        className="dbg-ui-btn uppercase tracking-wider text-white/50 hover:text-white/90 px-2 py-1 border border-white/10 rounded-md hover:border-cyan-500/40 transition-colors"
                        title="Back to sessions home"
                    >
                        ← sessions
                    </button>
                    <span className="brand-title">▓▓▓ LOG VIEWER</span>
                    <StatusPill status={status} />
                </div>

                <div className="flex flex-1 min-w-0 items-center gap-3">
                    <div className="min-w-0 flex-1">
                        <Select
                            value={selectValue || undefined}
                            onValueChange={(value) => {
                                const parsed = parseSessionKey(value);
                                if (parsed) {
                                    onSelectSession(parsed.source, parsed.name);
                                }
                            }}
                            disabled={sessionOptions.length === 0}
                        >
                            <SelectTrigger
                                aria-label="active session"
                                className="dbg-ui-text h-auto min-h-9 w-full max-w-none border-white/10 bg-black/40 py-1.5 text-white/90 shadow-none focus-visible:border-purple-500/50 focus-visible:ring-purple-500/30 [&_[data-slot=select-value]]:truncate"
                            >
                                <SelectValue placeholder="no sessions" />
                            </SelectTrigger>
                            <SelectContent className="dbg-ui-text max-h-80 border-white/10 bg-[#0d0d18] text-white/90">
                                {sessionOptions.map((option) => (
                                    <SelectItem
                                        key={option.value}
                                        value={option.value}
                                        className="font-mono text-white/85 focus:bg-white/10 focus:text-white"
                                    >
                                        {option.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                        <button
                            type="button"
                            onClick={onRefresh}
                            className="dbg-ui-btn uppercase tracking-wider text-white/50 hover:text-white/90 px-2 py-1 border border-white/10 rounded-md hover:border-cyan-500/40 transition-colors"
                            title="refetch session list"
                        >
                            ↻
                        </button>

                        <button
                            type="button"
                            onClick={onClear}
                            disabled={!activeSession || entryCount === 0}
                            className="dbg-ui-btn uppercase tracking-wider text-amber-400/70 hover:text-amber-300 px-2 py-1 border border-amber-500/20 hover:border-amber-500/60 rounded-md disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                            clear logs
                        </button>

                        <button
                            type="button"
                            onClick={() => {
                                if (!activeSource || !activeSession || !isLogSourceId(activeSource)) {
                                    return;
                                }

                                requestDelete({
                                    source: activeSource,
                                    name: activeSession,
                                    badge: meta?.badge,
                                    onAfterDelete: onBack,
                                });
                            }}
                            disabled={!activeSession}
                            className="dbg-ui-btn uppercase tracking-wider text-rose-400/70 hover:text-rose-300 px-2 py-1 border border-rose-500/20 hover:border-rose-500/60 rounded-md disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                            delete session
                        </button>

                        <DisplaySettingsButton />
                    </div>
                </div>
            </div>
        </header>
    );
}
