import type { IndexedLogEntry } from "@app/debugging-master/types";
import type { DashboardSession, LogSourceId } from "@app/utils/log-viewer/log-source";
import { sessionKey } from "@app/utils/log-viewer/session-key";
import { sortSessionsByRecency } from "@app/utils/log-viewer/session-recency";
import { shortenPathWithPrefix } from "@app/utils/paths.client";
import { buildBalancedMosaicLayout, reconcileMosaicLayout } from "@app/utils/ui/helpers/mosaic-layout";
import { useAutoScroll } from "@app/utils/ui/hooks/useAutoScroll";
import { useNowTick } from "@app/utils/ui/hooks/useNowTick";
import { useDirPathPrefix } from "@ui/components/DirPath";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mosaic, type MosaicNode, MosaicWindow } from "react-mosaic-component";
import { freezeLogSearch } from "@/components/LogSearchPopover";
import { api } from "@/lib/api";
import type { TimestampMode } from "@/lib/display-settings";
import { filterDisplayLogLines, shouldShowLogTimestamp, visibleLogText } from "@/lib/log-line-display";
import { isSessionInActivePool } from "@/lib/session-active-pool";
import { activeSessionRetentionMs } from "@/lib/session-pool-settings";
import { formatSessionHeaderParts } from "@/lib/session-run-context";
import type { ConnectionStatus, MultiplexLogEntry } from "@/lib/sse";
import { connectActiveStream } from "@/lib/sse";
import { useLogSearchDisplay } from "@/lib/use-log-search-display";
import { useScrollToFirstLogMatch } from "@/lib/use-scroll-to-first-log-match";
import { ActiveSessionMosaicToolbar } from "./ActiveSessionMosaicToolbar";
import { DisplaySettingsButton } from "./DisplaySettingsButton";
import { useDisplaySettings } from "./DisplaySettingsProvider";
import { LogLineJumpProvider, useLogLineJump } from "./LogLineJumpProvider";
import { LogPreviewLine } from "./LogPreviewLine";
import { SessionHeaderLine } from "./SessionHeaderLine";
import { SessionPoolSettingsButton } from "./SessionPoolSettingsButton";
import { useSessionPoolSettings } from "./SessionPoolSettingsProvider";
import { SessionDeleteButton, SessionRowBar } from "./SessionRowBar";
import { StatusPill } from "./StatusPill";

const ACTIVE_PREVIEW_LINES = 2000;
const ARCHIVE_PREVIEW_LIMIT = 40;
const MAX_ACTIVE_TILES = 6;
const MOSAIC_MAX_COLUMNS = 3;

/** Membership signature stable across recency re-sorts (poll / now tick). */
function stableSessionKeysSig(keys: string[]): string {
    if (keys.length === 0) {
        return "";
    }

    return [...keys].sort().join("\n");
}

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
    refreshing?: boolean;
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

function mosaicToggleTitle(visibility: MosaicVisibility, session: DashboardSession, pathPrefix: string): string {
    const header = formatSessionHeaderParts(session);
    const cwd = header.cwd ? shortenPathWithPrefix(header.cwd, pathPrefix) : undefined;
    const label = cwd ? `${header.name} · ${cwd}` : header.name;

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
        "dbg-ui-text-xs inline-flex items-center gap-1.5 min-w-0 max-w-[min(100%,36rem)] px-2 py-1 rounded-md border transition-colors";

    if (visibility === "visible") {
        return `${base} ${badgeClass(badge)} border-emerald-400/50 bg-emerald-500/10 text-white/90 hover:bg-emerald-500/20`;
    }

    if (visibility === "overflow") {
        return `${base} ${badgeClass(badge)} border-amber-400/35 bg-amber-500/5 text-white/70 hover:bg-amber-500/15`;
    }

    return `${base} border-white/10 bg-white/5 text-white/40 hover:text-white/70 hover:border-white/20`;
}

function previewText(entry: IndexedLogEntry | MultiplexLogEntry): string {
    return visibleLogText(entry);
}

function ActiveSessionTile({
    lineHits,
    highlightTokens,
    scrollRef,
    onScroll,
    timestampMode,
    jumpEnabled,
}: {
    lineHits: Array<{ line: MultiplexLogEntry; isMatch: boolean; isContext: boolean }>;
    highlightTokens: string[];
    scrollRef: React.RefObject<HTMLDivElement | null>;
    onScroll: () => void;
    timestampMode: TimestampMode;
    jumpEnabled: boolean;
}): React.ReactElement {
    const { registerScrollContainer } = useLogLineJump();

    useEffect(() => {
        registerScrollContainer(scrollRef);
    }, [registerScrollContainer, scrollRef]);
    return (
        <div className="h-full flex flex-col bg-black/30">
            <div
                ref={scrollRef}
                onScroll={onScroll}
                className="flex-1 min-h-0 overflow-y-auto overflow-x-auto font-mono dbg-log-text"
            >
                {lineHits.length === 0 ? (
                    <p className="px-2 py-2 text-white/25 italic">
                        {highlightTokens.length > 0 ? "no matches" : "waiting for lines…"}
                    </p>
                ) : (
                    lineHits.map(({ line, isMatch, isContext }, index) => {
                        const previousTs = index > 0 ? lineHits[index - 1]?.line.ts : undefined;
                        const showTimestamp = shouldShowLogTimestamp({
                            mode: timestampMode,
                            ts: line.ts,
                            previousTs,
                        });

                        return (
                            <LogPreviewLine
                                key={`${line.index}-${line.ts}`}
                                entry={line}
                                previewText={previewText(line)}
                                showTimestamp={showTimestamp}
                                lineIdPresentation="hover-rail"
                                jumpEnabled={jumpEnabled}
                                highlightTokens={highlightTokens}
                                isMatch={isMatch}
                                isContext={isContext}
                            />
                        );
                    })
                )}
            </div>
        </div>
    );
}

interface ActiveSessionMosaicPaneProps {
    session: DashboardSession;
    path: string[];
    lines: MultiplexLogEntry[];
    timestampMode: TimestampMode;
    onOpenSession: (source: LogSourceId, name: string) => void;
    onDeleteConfirmed: (session: DashboardSession) => void;
}

function ActiveSessionMosaicPane({
    session,
    path,
    lines,
    timestampMode,
    onOpenSession,
    onDeleteConfirmed,
}: ActiveSessionMosaicPaneProps): React.ReactElement {
    const [paused, setPaused] = useState(false);

    const onAutoscrollChange = useCallback((enabled: boolean) => {
        setPaused(!enabled);
    }, []);

    const visibleLines = useMemo(() => filterDisplayLogLines(lines), [lines]);

    const logDisplay = useLogSearchDisplay(visibleLines);

    const lineHits = useMemo(() => {
        return logDisplay.hits.map((hit) => ({
            line: hit.item,
            isMatch: hit.isMatch,
            isContext: hit.isContext,
        }));
    }, [logDisplay.hits]);

    const { ref, onScroll, resume } = useAutoScroll({
        enabled: !paused && !logDisplay.isFilterActive,
        onEnabledChange: onAutoscrollChange,
        edge: "bottom",
        snapDeps: [lineHits],
    });

    useScrollToFirstLogMatch(ref, logDisplay.logSearch, logDisplay.matchCount, logDisplay.isFilterActive);

    const togglePause = useCallback(() => {
        if (paused) {
            resume();
            return;
        }

        setPaused(true);
    }, [paused, resume]);

    return (
        <LogLineJumpProvider
            onBeforeJump={() => {
                logDisplay.setLogSearch((prev) => freezeLogSearch(prev));
            }}
        >
            <MosaicWindow<string>
                path={path}
                title=""
                toolbarControls={<span />}
                renderToolbar={() => (
                    <div className="flex w-full min-w-0">
                        <ActiveSessionMosaicToolbar
                            session={session}
                            lines={lines}
                            logSearch={logDisplay.logSearch}
                            onLogSearchChange={logDisplay.setLogSearch}
                            logMatchCount={logDisplay.matchCount}
                            logLineCount={logDisplay.lineCount}
                            paused={paused}
                            onTogglePause={togglePause}
                            onOpen={() => {
                                onOpenSession(session.source, session.name);
                            }}
                            onDeleteConfirmed={() => {
                                onDeleteConfirmed(session);
                            }}
                        />
                    </div>
                )}
            >
                <ActiveSessionTile
                    lineHits={lineHits}
                    highlightTokens={logDisplay.highlightTokens}
                    scrollRef={ref}
                    onScroll={onScroll}
                    timestampMode={timestampMode}
                    jumpEnabled={logDisplay.isSearchActive}
                />
            </MosaicWindow>
        </LogLineJumpProvider>
    );
}

export function SessionsHome({
    sessions,
    status,
    refreshing = false,
    onRefresh,
    onOpenSession,
    onStatus,
}: Props): React.ReactElement {
    const { settings } = useDisplaySettings();
    const { settings: poolSettings } = useSessionPoolSettings();
    const pathPrefix = useDirPathPrefix();
    const now = useNowTick(1000);
    const activeRetentionMs = useMemo(
        () => activeSessionRetentionMs(poolSettings),
        [poolSettings.activeSessionLimitSeconds]
    );
    const maxMosaicTiles = poolSettings.keepAllAlive ? Number.MAX_SAFE_INTEGER : MAX_ACTIVE_TILES;
    const [liveLines, setLiveLines] = useState<Map<string, MultiplexLogEntry[]>>(new Map());
    const [archiveOpen, setArchiveOpen] = useState(false);
    const [expandedArchive, setExpandedArchive] = useState<Set<string>>(new Set());
    const [archiveEntries, setArchiveEntries] = useState<Map<string, IndexedLogEntry[]>>(new Map());
    const [loadingArchive, setLoadingArchive] = useState<Set<string>>(new Set());
    const [layout, setLayout] = useState<MosaicNode<string> | null>(null);
    const [userHiddenKeys, setUserHiddenKeys] = useState<Set<string>>(() => new Set());
    const prefetchGenerationRef = useRef(new Map<string, number>());
    const seenEntryCountRef = useRef(new Map<string, number>());
    const liveLinesRef = useRef(liveLines);
    liveLinesRef.current = liveLines;

    const bumpPrefetchGeneration = useCallback((key: string): number => {
        const next = (prefetchGenerationRef.current.get(key) ?? 0) + 1;
        prefetchGenerationRef.current.set(key, next);
        return next;
    }, []);

    const prefetchSessionTail = useCallback(async (session: DashboardSession): Promise<void> => {
        const key = sessionKey(session.source, session.name);
        const generation = prefetchGenerationRef.current.get(key) ?? 0;

        try {
            const res = await api.getRecentEntries(session.source, session.name, ACTIVE_PREVIEW_LINES);
            if (generation !== (prefetchGenerationRef.current.get(key) ?? 0)) {
                return;
            }

            const tail = res.entries.map((entry) => toMultiplexEntry(session, entry));
            setLiveLines((prev) => {
                const next = new Map(prev);
                const existing = next.get(key) ?? [];
                next.set(key, mergePreviewLines(existing, tail, ACTIVE_PREVIEW_LINES));
                return next;
            });
        } catch {
            // ignore — SSE will catch up
        }
    }, []);

    const allActiveSessions = useMemo(
        () =>
            sortSessionsByRecency(sessions.filter((session) => isSessionInActivePool(session, now, activeRetentionMs))),
        [sessions, now, activeRetentionMs]
    );
    const allActiveKeys = useMemo(
        () => allActiveSessions.map((s) => sessionKey(s.source, s.name)),
        [allActiveSessions]
    );
    const mosaicActiveKeys = useMemo(() => {
        return allActiveKeys.filter((key) => !userHiddenKeys.has(key)).slice(0, maxMosaicTiles);
    }, [allActiveKeys, userHiddenKeys, maxMosaicTiles]);
    const mosaicActiveSessions = useMemo(() => {
        const visible = new Set(mosaicActiveKeys);

        return allActiveSessions.filter((session) => visible.has(sessionKey(session.source, session.name)));
    }, [allActiveSessions, mosaicActiveKeys]);
    const archiveSessions = useMemo(
        () =>
            sortSessionsByRecency(
                sessions.filter((session) => !isSessionInActivePool(session, now, activeRetentionMs))
            ),
        [sessions, now, activeRetentionMs]
    );
    const hiddenActiveCount = allActiveSessions.length - mosaicActiveKeys.length;

    const sessionByKey = useMemo(() => {
        const map = new Map<string, DashboardSession>();
        for (const session of sessions) {
            map.set(sessionKey(session.source, session.name), session);
        }
        return map;
    }, [sessions]);
    const sessionByKeyRef = useRef(sessionByKey);
    sessionByKeyRef.current = sessionByKey;

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
        setLayout((current) =>
            reconcileMosaicLayout(current, activeKeys, {
                maxColumns: MOSAIC_MAX_COLUMNS,
                followNextItemOrder: true,
            })
        );
    }, [activeKeys]);

    const mosaicLayout = layout ?? buildBalancedMosaicLayout(activeKeys, { maxColumns: MOSAIC_MAX_COLUMNS });

    // Stable membership signature of the mosaic — recomputes only when the
    // SET of active session keys changes, not on every `now` tick. Without
    // this, `mosaicActiveSessions` (derived from useNowTick(1000)) gave a
    // new array reference every second, retriggering this effect and the
    // SSE subscription effect below — refetching ACTIVE_PREVIEW_LINES = 2000
    // entries per session per second, and tearing down + re-opening one
    // EventSource per second. That swamped the dashboard server (the
    // exact symptom that caused the dashboard hang during eval2).
    const mosaicActiveKeysSig = useMemo(() => stableSessionKeysSig(mosaicActiveKeys), [mosaicActiveKeys]);
    const allActiveKeysSig = useMemo(() => stableSessionKeysSig(allActiveKeys), [allActiveKeys]);
    const mosaicEntryCountsSig = useMemo(() => {
        const byKey = new Map(sessions.map((session) => [sessionKey(session.source, session.name), session]));

        return mosaicActiveKeys
            .map((key) => `${key}:${byKey.get(key)?.entryCount ?? 0}`)
            .sort()
            .join("\n");
    }, [mosaicActiveKeys, sessions]);

    useEffect(() => {
        if (mosaicActiveSessions.length === 0) {
            return;
        }

        const prefetchActiveTails = async (): Promise<void> => {
            await Promise.all(mosaicActiveSessions.map((session) => prefetchSessionTail(session)));
        };

        void prefetchActiveTails();
        // Depend on the stable membership signature, NOT mosaicActiveSessions
        // (which is a new array ref every second from useNowTick).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mosaicActiveKeysSig]);

    const toggleSessionInMosaic = useCallback(
        (key: string) => {
            setUserHiddenKeys((prev) => {
                const next = new Set(prev);
                const currentlyVisible = allActiveKeys
                    .filter((candidate) => !next.has(candidate))
                    .slice(0, maxMosaicTiles);
                const isVisible = currentlyVisible.includes(key);

                if (isVisible) {
                    next.add(key);
                    return next;
                }

                next.delete(key);

                const wouldBeVisible = allActiveKeys.filter((candidate) => !next.has(candidate));

                if (!poolSettings.keepAllAlive && wouldBeVisible.length > MAX_ACTIVE_TILES) {
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
        [allActiveKeys, maxMosaicTiles, poolSettings.keepAllAlive]
    );

    useEffect(() => {
        if (allActiveKeys.length === 0) {
            return;
        }

        for (const key of mosaicActiveKeys) {
            const session = sessionByKeyRef.current.get(key);
            if (!session) {
                continue;
            }

            const serverCount = session.entryCount ?? 0;
            const tracked = seenEntryCountRef.current.get(key) ?? 0;

            if (serverCount <= tracked) {
                continue;
            }

            seenEntryCountRef.current.set(key, serverCount);
            const localCount = liveLinesRef.current.get(key)?.length ?? 0;

            if (serverCount > localCount) {
                void prefetchSessionTail(session);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mosaicEntryCountsSig, prefetchSessionTail]);

    useEffect(() => {
        // Multiplex SSE for live tail — keep open even with zero active sessions so
        // the home view still shows "connected" when the server is reachable.
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
                seenEntryCountRef.current.delete(key);
                setLiveLines((prev) => {
                    const next = new Map(prev);
                    next.delete(key);
                    return next;
                });
            },
            onCleared: (source, session) => {
                const key = sessionKey(source, session);
                bumpPrefetchGeneration(key);
                seenEntryCountRef.current.set(key, 0);
                setLiveLines((prev) => {
                    const next = new Map(prev);
                    next.set(key, []);
                    return next;
                });

                const dashboardSession = sessionByKeyRef.current.get(key);
                if (dashboardSession) {
                    void prefetchSessionTail(dashboardSession);
                }
            },
        });

        return dispose;
    }, [onStatus, allActiveKeysSig]);

    const toggleArchiveRow = useCallback(
        async (session: DashboardSession) => {
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
            } catch (error) {
                console.debug("archive preview fetch failed", { error, key });
                setArchiveEntries((prev) => new Map(prev).set(key, []));
            } finally {
                setLoadingArchive((prev) => {
                    const next = new Set(prev);
                    next.delete(key);
                    return next;
                });
            }
        },
        [archiveEntries, loadingArchive]
    );

    const clearDeletedSessionLocalState = useCallback((session: DashboardSession) => {
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
    }, []);

    return (
        <div className="h-full min-h-0 flex flex-col">
            <header className="sticky top-0 z-20 glass-card border-b border-white/8 shrink-0">
                <div className="px-3 sm:px-5 py-2.5 flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-3 mr-auto">
                        <span className="brand-title">▓▓▓ SESSIONS</span>
                        <StatusPill status={status} refreshing={refreshing} />
                        <span className="dbg-ui-text-sm text-emerald-400/70">
                            {allActiveSessions.length} live
                            {hiddenActiveCount > 0 ? ` · ${mosaicActiveKeys.length} in mosaic` : ""}
                            {hiddenActiveCount > 0 ? ` · ${hiddenActiveCount} hidden` : ""}
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={() => {
                            void onRefresh();
                        }}
                        className="dbg-ui-btn uppercase tracking-wider text-white/50 hover:text-white/90 px-2 py-1 border border-white/10 rounded-md hover:border-cyan-500/40 transition-colors"
                    >
                        ↻ refresh
                    </button>
                    <DisplaySettingsButton />
                </div>

                {allActiveSessions.length > 0 ? (
                    <div className="px-3 sm:px-5 pb-2.5 flex flex-wrap items-center gap-1.5 border-t border-white/5 pt-2">
                        <SessionPoolSettingsButton />
                        {allActiveSessions.map((session) => {
                            const key = sessionKey(session.source, session.name);
                            const visibility = resolveMosaicVisibility({
                                key,
                                allActiveKeys,
                                userHiddenKeys,
                                maxTiles: maxMosaicTiles,
                            });

                            return (
                                <button
                                    key={key}
                                    type="button"
                                    onClick={() => {
                                        toggleSessionInMosaic(key);
                                    }}
                                    className={mosaicToggleClass(visibility, session.badge)}
                                    title={mosaicToggleTitle(visibility, session, pathPrefix)}
                                    aria-pressed={visibility === "visible"}
                                >
                                    <SessionHeaderLine
                                        session={session}
                                        showCommand={false}
                                        layout="inline"
                                        className="min-w-0 flex-1"
                                    />
                                    <span className="dbg-ui-text-xs shrink-0 opacity-70 ml-1">
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
                                    timestampMode={settings.timestampMode}
                                    onOpenSession={onOpenSession}
                                    onDeleteConfirmed={clearDeletedSessionLocalState}
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
                    className="h-9 px-3 sm:px-5 flex items-center gap-2 dbg-ui-btn uppercase tracking-widest text-white/50 hover:text-white/80 hover:bg-white/5 shrink-0"
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
                                        <div className="flex items-start gap-1">
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    void toggleArchiveRow(session);
                                                }}
                                                className="text-white/50 hover:text-white/80 w-4 text-center shrink-0 mt-2"
                                                aria-expanded={open}
                                            >
                                                {open ? "▾" : "▸"}
                                            </button>
                                            <SessionRowBar
                                                session={session}
                                                onNameClick={() => {
                                                    onOpenSession(session.source, session.name);
                                                }}
                                                className="dbg-session-row--archive flex-1 min-w-0"
                                                trailing={
                                                    <SessionDeleteButton
                                                        session={session}
                                                        onConfirmed={() => {
                                                            clearDeletedSessionLocalState(session);
                                                        }}
                                                    />
                                                }
                                            />
                                        </div>

                                        {open ? (
                                            <LogLineJumpProvider>
                                                <div className="border-t border-white/6 bg-black/25 max-h-40 overflow-y-auto font-mono dbg-log-text">
                                                    {loading ? (
                                                        <p className="px-2 py-1 text-white/30 italic">loading…</p>
                                                    ) : entries.length === 0 ? (
                                                        <p className="px-2 py-1 text-white/30 italic">no log lines</p>
                                                    ) : (
                                                        filterDisplayLogLines(entries).map((entry, index, visible) => {
                                                            const previousTs =
                                                                index > 0 ? visible[index - 1]?.ts : undefined;
                                                            const showTimestamp = shouldShowLogTimestamp({
                                                                mode: settings.timestampMode,
                                                                ts: entry.ts,
                                                                previousTs,
                                                            });

                                                            return (
                                                                <LogPreviewLine
                                                                    key={entry.index}
                                                                    entry={entry}
                                                                    previewText={previewText(entry)}
                                                                    showTimestamp={showTimestamp}
                                                                    showLineId={settings.showLineId}
                                                                />
                                                            );
                                                        })
                                                    )}
                                                </div>
                                            </LogLineJumpProvider>
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
