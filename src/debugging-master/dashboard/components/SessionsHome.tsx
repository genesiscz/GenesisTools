import type { IndexedLogEntry } from "@app/debugging-master/types";
import type { DashboardSession, LogSourceId } from "@app/utils/log-viewer/log-source";
import { sessionKey } from "@app/utils/log-viewer/session-key";
import { buildBalancedMosaicLayout, reconcileMosaicLayout } from "@app/utils/ui/helpers/mosaic-layout";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mosaic, type MosaicNode, MosaicWindow } from "react-mosaic-component";
import { formatRelativeTime } from "@/lib/format";
import { api } from "@/lib/api";
import type { ConnectionStatus, MultiplexLogEntry } from "@/lib/sse";
import { connectActiveStream } from "@/lib/sse";
import { StatusPill } from "./StatusPill";
import { SessionStatusLabel } from "./SessionStatusLabel";
import { ActiveSessionMosaicToolbar } from "./ActiveSessionMosaicToolbar";
import { DisplaySettingsButton } from "./DisplaySettingsButton";
import { formatSessionHeaderParts } from "@/lib/session-run-context";
import { SessionHeaderLine } from "./SessionHeaderLine";
import { LogLineText } from "./LogLineText";

const ACTIVE_PREVIEW_LINES = 2000;
const ARCHIVE_PREVIEW_LIMIT = 40;
const MAX_ACTIVE_TILES = 6;
const MOSAIC_MAX_COLUMNS = 3;

function toMultiplexEntry(session: DashboardSession, entry: IndexedLogEntry): MultiplexLogEntry {
    return {
        ...entry,
        source: session.source,
        session: session.name,
    };
}

function mergePreviewLines(
    existing: MultiplexLogEntry[],
    incoming: MultiplexLogEntry[],
    maxLines: number
): MultiplexLogEntry[] {
    const byIndex = new Map<number, MultiplexLogEntry>();

    for (const entry of existing) {
        byIndex.set(entry.index, entry);
    }

    for (const entry of incoming) {
        byIndex.set(entry.index, entry);
    }

    return [...byIndex.values()].sort((a, b) => a.index - b.index).slice(-maxLines);
}

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

function latestLineTimestamp(lines: MultiplexLogEntry[]): number | undefined {
    if (lines.length === 0) {
        return undefined;
    }

    return lines[lines.length - 1].ts;
}

type MosaicVisibility = "visible" | "hidden" | "overflow";

function resolveMosaicVisibility({
    key,
    allActiveKeys,
    userHiddenKeys,
    maxTiles,
}: {
    key: string;
    allActiveKeys: string[];
    userHiddenKeys: ReadonlySet<string>;
    maxTiles: number;
}): MosaicVisibility {
    if (userHiddenKeys.has(key)) {
        return "hidden";
    }

    const eligible = allActiveKeys.filter((candidate) => !userHiddenKeys.has(candidate));
    const index = eligible.indexOf(key);

    if (index === -1) {
        return "hidden";
    }

    if (index < maxTiles) {
        return "visible";
    }

    return "overflow";
}

function mosaicToggleTitle(visibility: MosaicVisibility, session: DashboardSession): string {
    const header = formatSessionHeaderParts(session);
    const label = header.cwd ? `${header.name} · ${header.cwd}` : header.name;

    if (visibility === "visible") {
        return `Hide "${label}" from mosaic`;
    }

    if (visibility === "overflow") {
        return `Show "${label}" in mosaic (replaces another tile)`;
    }

    return `Show "${label}" in mosaic`;
}

function mosaicToggleClass(visibility: MosaicVisibility, badge: string): string {
    const base =
        "inline-flex items-center gap-1.5 max-w-[420px] px-2 py-1 rounded-md border text-[10px] transition-colors";

    if (visibility === "visible") {
        return `${base} ${badgeClass(badge)} border-emerald-400/50 bg-emerald-500/10 text-white/90 hover:bg-emerald-500/20`;
    }

    if (visibility === "overflow") {
        return `${base} ${badgeClass(badge)} border-amber-400/35 bg-amber-500/5 text-white/70 hover:bg-amber-500/15`;
    }

    return `${base} border-white/10 bg-white/5 text-white/40 hover:text-white/70 hover:border-white/20`;
}

function previewText(entry: IndexedLogEntry | MultiplexLogEntry): string {
    return entry.msg ?? "";
}

function ActiveSessionTile({
    lines,
    autoScroll,
}: {
    lines: MultiplexLogEntry[];
    autoScroll: boolean;
}): React.ReactElement {
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const el = scrollRef.current;

        if (!el || !autoScroll) {
            return;
        }

        el.scrollTop = Number.MAX_SAFE_INTEGER;
    }, [lines, autoScroll]);

    return (
        <div className="h-full flex flex-col bg-black/30">
            <div
                ref={scrollRef}
                className="flex-1 min-h-0 overflow-y-auto font-mono dbg-log-text leading-relaxed"
            >
                {lines.length === 0 ? (
                    <p className="px-2 py-2 text-white/25 italic">waiting for lines…</p>
                ) : (
                    lines.map((line) => (
                        <div
                            key={`${line.index}-${line.ts}`}
                            className="px-2 py-0.5 border-b border-white/4 text-white/70 min-w-0"
                            title={previewText(line)}
                        >
                            {line.msgAnsi ? (
                                <LogLineText entry={line} />
                            ) : (
                                <>
                                    <span className="text-white/30 mr-1.5">[{line.level}]</span>
                                    <span className="truncate-mono">{previewText(line)}</span>
                                </>
                            )}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}

interface ActiveSessionMosaicPaneProps {
    session: DashboardSession;
    path: string[];
    lines: MultiplexLogEntry[];
    onOpenSession: (source: LogSourceId, name: string) => void;
    onDelete: (session: DashboardSession) => void;
}

function ActiveSessionMosaicPane({
    session,
    path,
    lines,
    onOpenSession,
    onDelete,
}: ActiveSessionMosaicPaneProps): React.ReactElement {
    const [paused, setPaused] = useState(false);

    const togglePause = useCallback(() => {
        setPaused((current) => !current);
    }, []);

    return (
        <MosaicWindow<string>
            path={path}
            title=""
            toolbarControls={<span />}
            renderToolbar={() => (
                <ActiveSessionMosaicToolbar
                    session={session}
                    lines={lines}
                    paused={paused}
                    onTogglePause={togglePause}
                    onOpen={() => {
                        onOpenSession(session.source, session.name);
                    }}
                    onDelete={() => {
                        onDelete(session);
                    }}
                />
            )}
        >
            <ActiveSessionTile lines={lines} autoScroll={!paused} />
        </MosaicWindow>
    );
}

export function SessionsHome({ sessions, status, onRefresh, onOpenSession, onStatus }: Props): React.ReactElement {
    const [liveLines, setLiveLines] = useState<Map<string, MultiplexLogEntry[]>>(new Map());
    const [archiveOpen, setArchiveOpen] = useState(false);
    const [expandedArchive, setExpandedArchive] = useState<Set<string>>(new Set());
    const [archiveEntries, setArchiveEntries] = useState<Map<string, IndexedLogEntry[]>>(new Map());
    const [loadingArchive, setLoadingArchive] = useState<Set<string>>(new Set());
    const [layout, setLayout] = useState<MosaicNode<string> | null>(null);
    const [userHiddenKeys, setUserHiddenKeys] = useState<Set<string>>(() => new Set());

    const allActiveSessions = useMemo(() => sessions.filter((s) => s.state === "active"), [sessions]);
    const allActiveKeys = useMemo(
        () => allActiveSessions.map((s) => sessionKey(s.source, s.name)),
        [allActiveSessions]
    );
    const mosaicActiveKeys = useMemo(() => {
        return allActiveKeys.filter((key) => !userHiddenKeys.has(key)).slice(0, MAX_ACTIVE_TILES);
    }, [allActiveKeys, userHiddenKeys]);
    const mosaicActiveSessions = useMemo(() => {
        const visible = new Set(mosaicActiveKeys);

        return allActiveSessions.filter((session) => visible.has(sessionKey(session.source, session.name)));
    }, [allActiveSessions, mosaicActiveKeys]);
    const archiveSessions = useMemo(() => sessions.filter((s) => s.state !== "active"), [sessions]);
    const hiddenActiveCount = allActiveSessions.length - mosaicActiveKeys.length;

    const sessionByKey = useMemo(() => {
        const map = new Map<string, DashboardSession>();
        for (const session of sessions) {
            map.set(sessionKey(session.source, session.name), session);
        }
        return map;
    }, [sessions]);

    const activeKeys = mosaicActiveKeys;

    useEffect(() => {
        setUserHiddenKeys((prev) => {
            const activeSet = new Set(allActiveKeys);
            const next = new Set([...prev].filter((key) => activeSet.has(key)));

            if (next.size === prev.size) {
                return prev;
            }

            return next;
        });
    }, [allActiveKeys]);

    useEffect(() => {
        setLayout((current) => reconcileMosaicLayout(current, activeKeys, { maxColumns: MOSAIC_MAX_COLUMNS }));
    }, [activeKeys]);

    const mosaicLayout =
        layout ?? buildBalancedMosaicLayout(activeKeys, { maxColumns: MOSAIC_MAX_COLUMNS });

    useEffect(() => {
        if (mosaicActiveSessions.length === 0) {
            return;
        }

        let cancelled = false;

        const prefetchActiveTails = async (): Promise<void> => {
            const results = await Promise.all(
                mosaicActiveSessions.map(async (session) => {
                    const key = sessionKey(session.source, session.name);

                    try {
                        const res = await api.getRecentEntries(
                            session.source,
                            session.name,
                            ACTIVE_PREVIEW_LINES
                        );
                        const tail = res.entries.map((entry) => toMultiplexEntry(session, entry));

                        return { key, tail };
                    } catch {
                        return { key, tail: [] as MultiplexLogEntry[] };
                    }
                })
            );

            if (cancelled) {
                return;
            }

            setLiveLines((prev) => {
                const next = new Map(prev);

                for (const { key, tail } of results) {
                    const existing = next.get(key) ?? [];
                    next.set(key, mergePreviewLines(existing, tail, ACTIVE_PREVIEW_LINES));
                }

                return next;
            });
        };

        void prefetchActiveTails();

        return () => {
            cancelled = true;
        };
    }, [mosaicActiveSessions]);

    const toggleSessionInMosaic = useCallback(
        (key: string) => {
            setUserHiddenKeys((prev) => {
                const next = new Set(prev);
                const currentlyVisible = allActiveKeys
                    .filter((candidate) => !next.has(candidate))
                    .slice(0, MAX_ACTIVE_TILES);
                const isVisible = currentlyVisible.includes(key);

                if (isVisible) {
                    next.add(key);
                    return next;
                }

                next.delete(key);

                const wouldBeVisible = allActiveKeys.filter((candidate) => !next.has(candidate));

                if (wouldBeVisible.length > MAX_ACTIVE_TILES) {
                    for (let index = currentlyVisible.length - 1; index >= 0; index--) {
                        const displaced = currentlyVisible[index];

                        if (displaced !== key) {
                            next.add(displaced);
                            break;
                        }
                    }
                }

                return next;
            });
        },
        [allActiveKeys]
    );

    useEffect(() => {
        const dispose = connectActiveStream({
            onStatus: onStatus,
            onEntry: (entry) => {
                const key = sessionKey(entry.source, entry.session);
                setLiveLines((prev) => {
                    const next = new Map(prev);
                    const bucket = next.get(key) ?? [];
                    next.set(key, mergePreviewLines(bucket, [entry], ACTIVE_PREVIEW_LINES));
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

    const toggleArchiveRow = useCallback(async (session: DashboardSession) => {
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
            setUserHiddenKeys((prev) => {
                if (!prev.has(key)) {
                    return prev;
                }

                const next = new Set(prev);
                next.delete(key);
                return next;
            });
            await onRefresh();
        },
        [onRefresh]
    );

    return (
        <div className="h-full min-h-0 flex flex-col">
            <header className="sticky top-0 z-20 glass-card border-b border-white/8 shrink-0">
                <div className="px-3 sm:px-5 py-2.5 flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-3 mr-auto">
                        <span className="brand-title text-[13px] sm:text-[15px]">▓▓▓ SESSIONS</span>
                        <StatusPill status={status} />
                        <span className="text-[10px] text-emerald-400/70">
                            {allActiveSessions.length} active
                            {hiddenActiveCount > 0 ? ` · ${mosaicActiveKeys.length} in mosaic` : ""}
                            {hiddenActiveCount > 0 ? ` · ${hiddenActiveCount} hidden` : ""}
                        </span>
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
                    <DisplaySettingsButton />
                </div>

                {allActiveSessions.length > 0 ? (
                    <div className="px-3 sm:px-5 pb-2.5 flex flex-wrap items-center gap-1.5 border-t border-white/5 pt-2">
                        <span className="text-[9px] uppercase tracking-widest text-white/30 mr-1 shrink-0">Mosaic</span>
                        {allActiveSessions.map((session) => {
                            const key = sessionKey(session.source, session.name);
                            const visibility = resolveMosaicVisibility({
                                key,
                                allActiveKeys,
                                userHiddenKeys,
                                maxTiles: MAX_ACTIVE_TILES,
                            });

                            return (
                                <button
                                    key={key}
                                    type="button"
                                    onClick={() => {
                                        toggleSessionInMosaic(key);
                                    }}
                                    className={mosaicToggleClass(visibility, session.badge)}
                                    title={mosaicToggleTitle(visibility, session)}
                                    aria-pressed={visibility === "visible"}
                                >
                                    <SessionHeaderLine session={session} showCommand={false} className="text-[10px]" />
                                    <span className="text-[9px] shrink-0 opacity-70 ml-1">
                                        {visibility === "visible" ? "●" : visibility === "overflow" ? "◐" : "○"}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                ) : null}
            </header>

            <div className="flex-1 min-h-0 flex flex-col px-2 py-2">
                {allActiveSessions.length === 0 ? (
                    <p className="text-xs text-white/35 py-6 text-center border border-dashed border-white/10 rounded-lg mx-1">
                        No active sessions — start one with{" "}
                        <code className="text-cyan-300/80">tools task run --session &lt;name&gt; -- &lt;cmd&gt;</code>
                    </p>
                ) : mosaicActiveSessions.length === 0 ? (
                    <p className="text-xs text-white/35 py-6 text-center border border-dashed border-white/10 rounded-lg mx-1">
                        All active sessions hidden — click a pill above to show one in the mosaic
                    </p>
                ) : mosaicLayout ? (
                    <Mosaic<string>
                        value={mosaicLayout}
                        onChange={(next) => setLayout(next)}
                        className="dbg-mosaic flex-1 min-h-0"
                        renderTile={(id, path) => {
                            const session = sessionByKey.get(id);
                            if (!session) {
                                return (
                                    <MosaicWindow<string> path={path} title={id} toolbarControls={<span />}>
                                        <div className="p-2 text-white/40 text-xs">session gone</div>
                                    </MosaicWindow>
                                );
                            }

                            const lines = liveLines.get(id) ?? [];

                            return (
                                <ActiveSessionMosaicPane
                                    session={session}
                                    path={path}
                                    lines={lines}
                                    onOpenSession={onOpenSession}
                                    onDelete={(s) => {
                                        void handleDelete(s);
                                    }}
                                />
                            );
                        }}
                    />
                ) : null}
            </div>

            <div
                className={`shrink-0 border-t border-white/10 bg-black/40 flex flex-col transition-[height] duration-200 ease-out ${
                    archiveOpen ? "h-[min(42vh,360px)]" : "h-9"
                }`}
            >
                <button
                    type="button"
                    onClick={() => {
                        setArchiveOpen((open) => !open);
                    }}
                    className="h-9 px-3 sm:px-5 flex items-center gap-2 text-[10px] uppercase tracking-widest text-white/50 hover:text-white/80 hover:bg-white/5 shrink-0"
                    aria-expanded={archiveOpen}
                >
                    <span className="text-white/35">{archiveOpen ? "▾" : "▴"}</span>
                    <span>Archive</span>
                    <span className="text-white/30 normal-case tracking-normal">({archiveSessions.length})</span>
                </button>

                {archiveOpen ? (
                    <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-1">
                        {archiveSessions.length === 0 ? (
                            <p className="text-xs text-white/30 px-2 py-1">No archived sessions.</p>
                        ) : (
                            archiveSessions.map((session) => {
                                const key = sessionKey(session.source, session.name);
                                const open = expandedArchive.has(key);
                                const entries = archiveEntries.get(key) ?? [];
                                const loading = loadingArchive.has(key);

                                return (
                                    <article
                                        key={key}
                                        className="glass-card border border-white/8 rounded-md overflow-hidden"
                                    >
                                        <div className="px-2 py-1.5 flex items-center gap-2">
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    void toggleArchiveRow(session);
                                                }}
                                                className="text-white/50 hover:text-white/80 w-4 text-center shrink-0"
                                                aria-expanded={open}
                                            >
                                                {open ? "▾" : "▸"}
                                            </button>
                                            <SessionHeaderLine
                                                session={session}
                                                onNameClick={() => {
                                                    onOpenSession(session.source, session.name);
                                                }}
                                                className="flex-1 text-[11px]"
                                            />
                                            <SessionStatusLabel
                                                session={session}
                                                className={`text-[10px] shrink-0 ${stateClass(session.state)}`}
                                            />
                                            <span className="text-[10px] text-white/30 shrink-0">
                                                {formatRelativeTime(session.lastActivityAt)}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    void handleDelete(session);
                                                }}
                                                className="text-[10px] uppercase tracking-wider text-rose-400/70 hover:text-rose-300 px-1 py-0.5 border border-rose-500/20 hover:border-rose-500/60 rounded shrink-0"
                                            >
                                                delete
                                            </button>
                                        </div>

                                        {open ? (
                                            <div className="border-t border-white/6 bg-black/25 max-h-40 overflow-y-auto font-mono dbg-log-text">
                                                {loading ? (
                                                    <p className="px-2 py-1 text-white/30 italic">loading…</p>
                                                ) : entries.length === 0 ? (
                                                    <p className="px-2 py-1 text-white/30 italic">no log lines</p>
                                                ) : (
                                                    entries.map((entry) => (
                                                        <div
                                                            key={entry.index}
                                                            className="px-2 py-0.5 border-b border-white/4 text-white/65 min-w-0"
                                                            title={previewText(entry)}
                                                        >
                                                            {entry.msgAnsi ? (
                                                                <LogLineText entry={entry} />
                                                            ) : (
                                                                <>
                                                                    <span className="text-white/30 mr-1.5">
                                                                        [{entry.level}]
                                                                    </span>
                                                                    <span className="truncate-mono">{previewText(entry)}</span>
                                                                </>
                                                            )}
                                                        </div>
                                                    ))
                                                )}
                                            </div>
                                        ) : null}
                                    </article>
                                );
                            })
                        )}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
