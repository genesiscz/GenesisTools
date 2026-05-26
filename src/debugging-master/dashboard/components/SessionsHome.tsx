import type { IndexedLogEntry } from "@app/debugging-master/types";
import type { DashboardSession, LogSourceId } from "@app/utils/log-viewer/log-source";
import { sessionKey } from "@app/utils/log-viewer/session-key";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatRelativeTime } from "@/lib/format";
import { api } from "@/lib/api";
import type { ConnectionStatus, MultiplexLogEntry } from "@/lib/sse";
import { connectActiveStream } from "@/lib/sse";
import { StatusPill } from "./StatusPill";

const PREVIEW_LINES = 8;
const ARCHIVE_PREVIEW_LIMIT = 40;

interface Props {
    sessions: DashboardSession[];
    status: ConnectionStatus;
    onRefresh: () => Promise<void>;
    onOpenSession: (source: LogSourceId, name: string) => void;
    onStatus: (status: ConnectionStatus) => void;
}

function badgeClass(badge: string): string {
    if (badge === "task") {
        return "bg-cyan-500/20 text-cyan-300 border-cyan-500/30";
    }

    return "bg-purple-500/20 text-purple-300 border-purple-500/30";
}

function stateClass(state: DashboardSession["state"]): string {
    if (state === "active") {
        return "text-emerald-400/90";
    }

    if (state === "exited") {
        return "text-white/45";
    }

    return "text-amber-400/80";
}

function previewText(entry: IndexedLogEntry | MultiplexLogEntry): string {
    return entry.msg ?? "";
}

export function SessionsHome({ sessions, status, onRefresh, onOpenSession, onStatus }: Props): React.ReactElement {
    const [liveLines, setLiveLines] = useState<Map<string, MultiplexLogEntry[]>>(new Map());
    const [expandedArchive, setExpandedArchive] = useState<Set<string>>(new Set());
    const [archiveEntries, setArchiveEntries] = useState<Map<string, IndexedLogEntry[]>>(new Map());
    const [loadingArchive, setLoadingArchive] = useState<Set<string>>(new Set());

    const activeSessions = useMemo(() => sessions.filter((s) => s.state === "active"), [sessions]);
    const archiveSessions = useMemo(() => sessions.filter((s) => s.state !== "active"), [sessions]);

    useEffect(() => {
        const dispose = connectActiveStream({
            onStatus: onStatus,
            onEntry: (entry) => {
                const key = sessionKey(entry.source, entry.session);
                setLiveLines((prev) => {
                    const next = new Map(prev);
                    const bucket = [...(next.get(key) ?? []), entry];
                    next.set(key, bucket.slice(-PREVIEW_LINES));
                    return next;
                });
            },
            onRemoved: (source, session) => {
                const key = sessionKey(source, session);
                setLiveLines((prev) => {
                    const next = new Map(prev);
                    next.delete(key);
                    return next;
                });
            },
        });

        return dispose;
    }, [onStatus]);

    const toggleArchive = useCallback(async (session: DashboardSession) => {
        const key = sessionKey(session.source, session.name);
        setExpandedArchive((prev) => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
                return next;
            }
            next.add(key);
            return next;
        });

        if (archiveEntries.has(key) || loadingArchive.has(key)) {
            return;
        }

        setLoadingArchive((prev) => new Set(prev).add(key));
        try {
            const res = await api.getEntries(session.source, session.name, 0, ARCHIVE_PREVIEW_LIMIT);
            setArchiveEntries((prev) => new Map(prev).set(key, res.entries.slice(-ARCHIVE_PREVIEW_LIMIT)));
        } catch {
            setArchiveEntries((prev) => new Map(prev).set(key, []));
        } finally {
            setLoadingArchive((prev) => {
                const next = new Set(prev);
                next.delete(key);
                return next;
            });
        }
    }, [archiveEntries, loadingArchive]);

    const handleDelete = useCallback(
        async (session: DashboardSession) => {
            const ok = confirm(`Delete session [${session.badge}] "${session.name}" and all log files?`);
            if (!ok) {
                return;
            }

            await api.deleteSession(session.source, session.name);
            const key = sessionKey(session.source, session.name);
            setLiveLines((prev) => {
                const next = new Map(prev);
                next.delete(key);
                return next;
            });
            setExpandedArchive((prev) => {
                const next = new Set(prev);
                next.delete(key);
                return next;
            });
            setArchiveEntries((prev) => {
                const next = new Map(prev);
                next.delete(key);
                return next;
            });
            await onRefresh();
        },
        [onRefresh]
    );

    return (
        <div className="h-full flex flex-col">
            <header className="sticky top-0 z-20 glass-card border-b border-white/8">
                <div className="px-3 sm:px-5 py-2.5 flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-3 mr-auto">
                        <span className="brand-title text-[13px] sm:text-[15px]">▓▓▓ SESSIONS</span>
                        <StatusPill status={status} />
                    </div>
                    <button
                        type="button"
                        onClick={() => {
                            void onRefresh();
                        }}
                        className="text-[10px] uppercase tracking-wider text-white/50 hover:text-white/90 px-2 py-1 border border-white/10 rounded-md hover:border-cyan-500/40 transition-colors"
                    >
                        ↻ refresh
                    </button>
                </div>
            </header>

            <main className="flex-1 overflow-y-auto px-3 sm:px-5 py-4 space-y-6">
                <section>
                    <div className="flex items-baseline gap-2 mb-3">
                        <h2 className="section-label text-[11px] uppercase tracking-widest text-white/50">Active</h2>
                        <span className="text-[10px] text-emerald-400/70">{activeSessions.length} streaming</span>
                    </div>

                    {activeSessions.length === 0 ? (
                        <p className="text-xs text-white/35 py-6 text-center border border-dashed border-white/10 rounded-lg">
                            No active sessions — start one with{" "}
                            <code className="text-cyan-300/80">tools task run --session &lt;name&gt; -- &lt;cmd&gt;</code>
                        </p>
                    ) : (
                        <div className="grid gap-3 lg:grid-cols-2">
                            {activeSessions.map((session) => {
                                const key = sessionKey(session.source, session.name);
                                const lines = liveLines.get(key) ?? [];

                                return (
                                    <article
                                        key={key}
                                        className="glass-card border border-white/8 rounded-lg overflow-hidden"
                                    >
                                        <div className="px-3 py-2 flex items-start gap-2 border-b border-white/6 bg-black/20">
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span
                                                        className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${badgeClass(session.badge)}`}
                                                    >
                                                        {session.badge}
                                                    </span>
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            onOpenSession(session.source, session.name);
                                                        }}
                                                        className="text-xs text-white/90 hover:text-cyan-300 truncate-mono text-left"
                                                        title="Open full log viewer"
                                                    >
                                                        {session.name}
                                                    </button>
                                                    <span className={`text-[10px] ${stateClass(session.state)}`}>
                                                        {session.stateLabel}
                                                    </span>
                                                </div>
                                                {session.command || session.projectPath ? (
                                                    <p
                                                        className="text-[10px] text-white/35 truncate-mono mt-1"
                                                        title={session.command ?? session.projectPath}
                                                    >
                                                        {session.command ?? session.projectPath}
                                                    </p>
                                                ) : null}
                                            </div>
                                            <div className="flex items-center gap-1 shrink-0">
                                                <span className="text-[10px] text-white/30">
                                                    {session.entryCount ?? 0} lines
                                                </span>
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        void handleDelete(session);
                                                    }}
                                                    className="text-[10px] uppercase tracking-wider text-rose-400/70 hover:text-rose-300 px-1.5 py-0.5 border border-rose-500/20 hover:border-rose-500/60 rounded transition-colors"
                                                >
                                                    delete
                                                </button>
                                            </div>
                                        </div>
                                        <div className="max-h-40 overflow-y-auto font-mono text-[11px] leading-relaxed">
                                            {lines.length === 0 ? (
                                                <p className="px-3 py-2 text-white/25 italic">waiting for lines…</p>
                                            ) : (
                                                lines.map((line) => (
                                                    <div
                                                        key={`${line.index}-${line.ts}`}
                                                        className="px-3 py-0.5 border-b border-white/4 text-white/70 truncate-mono"
                                                        title={previewText(line)}
                                                    >
                                                        <span className="text-white/30 mr-2">[{line.level}]</span>
                                                        {previewText(line)}
                                                    </div>
                                                ))
                                            )}
                                        </div>
                                    </article>
                                );
                            })}
                        </div>
                    )}
                </section>

                <section>
                    <div className="flex items-baseline gap-2 mb-3">
                        <h2 className="section-label text-[11px] uppercase tracking-widest text-white/50">Archive</h2>
                        <span className="text-[10px] text-white/35">{archiveSessions.length} sessions</span>
                    </div>

                    {archiveSessions.length === 0 ? (
                        <p className="text-xs text-white/30 py-4">No archived sessions yet.</p>
                    ) : (
                        <div className="space-y-2">
                            {archiveSessions.map((session) => {
                                const key = sessionKey(session.source, session.name);
                                const open = expandedArchive.has(key);
                                const entries = archiveEntries.get(key) ?? [];
                                const loading = loadingArchive.has(key);

                                return (
                                    <article
                                        key={key}
                                        className="glass-card border border-white/8 rounded-lg overflow-hidden"
                                    >
                                        <div className="px-3 py-2 flex items-center gap-2">
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    void toggleArchive(session);
                                                }}
                                                className="text-white/50 hover:text-white/80 w-5 text-center shrink-0"
                                                aria-expanded={open}
                                            >
                                                {open ? "▾" : "▸"}
                                            </button>
                                            <span
                                                className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${badgeClass(session.badge)}`}
                                            >
                                                {session.badge}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    onOpenSession(session.source, session.name);
                                                }}
                                                className="text-xs text-white/85 hover:text-cyan-300 truncate-mono flex-1 text-left min-w-0"
                                            >
                                                {session.name}
                                            </button>
                                            <span className={`text-[10px] shrink-0 ${stateClass(session.state)}`}>
                                                {session.stateLabel}
                                            </span>
                                            <span className="text-[10px] text-white/30 shrink-0">
                                                {formatRelativeTime(session.lastActivityAt)}
                                            </span>
                                            <span className="text-[10px] text-white/30 shrink-0">
                                                {session.entryCount ?? 0} lines
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    void handleDelete(session);
                                                }}
                                                className="text-[10px] uppercase tracking-wider text-rose-400/70 hover:text-rose-300 px-1.5 py-0.5 border border-rose-500/20 hover:border-rose-500/60 rounded shrink-0 transition-colors"
                                            >
                                                delete
                                            </button>
                                        </div>

                                        {open ? (
                                            <div className="border-t border-white/6 bg-black/25 max-h-56 overflow-y-auto font-mono text-[11px]">
                                                {loading ? (
                                                    <p className="px-3 py-2 text-white/30 italic">loading…</p>
                                                ) : entries.length === 0 ? (
                                                    <p className="px-3 py-2 text-white/30 italic">no log lines</p>
                                                ) : (
                                                    entries.map((entry) => (
                                                        <div
                                                            key={entry.index}
                                                            className="px-3 py-0.5 border-b border-white/4 text-white/65 truncate-mono"
                                                            title={previewText(entry)}
                                                        >
                                                            <span className="text-white/30 mr-2">[{entry.level}]</span>
                                                            {previewText(entry)}
                                                        </div>
                                                    ))
                                                )}
                                                <div className="px-3 py-2 border-t border-white/6">
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            onOpenSession(session.source, session.name);
                                                        }}
                                                        className="text-[10px] uppercase tracking-wider text-cyan-400/80 hover:text-cyan-300"
                                                    >
                                                        open full viewer →
                                                    </button>
                                                </div>
                                            </div>
                                        ) : null}
                                    </article>
                                );
                            })}
                        </div>
                    )}
                </section>
            </main>

            <footer className="px-3 sm:px-5 py-1.5 border-t border-white/8 bg-black/30 text-[10px] text-white/40 flex items-center justify-between">
                <span>{sessions.length} sessions total</span>
                <span className="text-white/25">dbg + task · live multiplex</span>
            </footer>
        </div>
    );
}
