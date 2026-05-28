import type { IndexedLogEntry, LogLevel } from "@app/debugging-master/types";
import type { DashboardSession, LogSourceId } from "@app/utils/log-viewer/log-source";
import { isLogSourceId } from "@app/utils/log-viewer/session-key";
import { sortSessionsByRecency } from "@app/utils/log-viewer/session-recency";
import { TooltipProvider } from "@ui/components/tooltip";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EntryList, type EntryListHandle } from "@/components/EntryList";
import { FilterBar, type SortDir } from "@/components/FilterBar";
import { Header } from "@/components/Header";
import { SessionsHome } from "@/components/SessionsHome";
import { DisplaySettingsProvider } from "@/components/DisplaySettingsProvider";
import { SessionDeleteConfirmProvider } from "@/lib/ui/SessionDeleteConfirm";
import { collectSessionCwds } from "@/lib/session-run-context";
import { DirPathPrefixProvider } from "@ui/components/DirPath";
import { api } from "@/lib/api";
import { EntriesContext } from "@/lib/entries-context";
import { applyFilter, collectHypotheses, defaultFilterState, type FilterState } from "@/lib/filters";
import { FILTER_ORDER } from "@/lib/levels";
import { mergeIndexedLogEntries } from "@/lib/merge-indexed-entries";
import { type ConnectionStatus, connectStream } from "@/lib/sse";

const FRESH_TTL_MS = 1500;
const SESSIONS_REFRESH_MS = 5_000;

type AppView = "home" | "detail";

function readFromUrl(): { view: AppView; source: LogSourceId | null; session: string | null } {
    if (typeof window === "undefined") {
        return { view: "home", source: null, session: null };
    }

    const params = new URLSearchParams(window.location.search);
    const sourceParam = params.get("source");
    const session = params.get("session");
    const source = sourceParam && isLogSourceId(sourceParam) ? sourceParam : null;

    if (source && session) {
        return { view: "detail", source, session };
    }

    return { view: "home", source: null, session: null };
}

function applyUrl(view: AppView, source: LogSourceId | null, name: string | null, mode: "push" | "replace"): void {
    if (typeof window === "undefined") {
        return;
    }

    const url = new URL(window.location.href);

    if (view === "detail" && source && name) {
        url.searchParams.set("source", source);
        url.searchParams.set("session", name);
    } else {
        url.searchParams.delete("source");
        url.searchParams.delete("session");
    }

    const state = { view, source, session: name };
    const href = `${url.pathname}${url.search}${url.hash}`;

    if (mode === "push") {
        window.history.pushState(state, "", href);
        return;
    }

    window.history.replaceState(state, "", href);
}

export function App(): React.ReactElement {
    const initial = readFromUrl();
    const [view, setView] = useState<AppView>(initial.view);
    const [sessions, setSessions] = useState<DashboardSession[]>([]);
    const [activeSource, setActiveSource] = useState<LogSourceId | null>(initial.source);
    const [activeSession, setActiveSession] = useState<string | null>(initial.session);
    const [entries, setEntries] = useState<IndexedLogEntry[]>([]);
    const [status, setStatus] = useState<ConnectionStatus>("connecting");
    const [filterState, setFilterState] = useState<FilterState>(defaultFilterState);
    const [paused, setPaused] = useState(false);
    const [sortDir, setSortDir] = useState<SortDir>(() => {
        if (typeof window === "undefined") {
            return "asc";
        }
        try {
            return window.localStorage.getItem("dbg.sortDir") === "desc" ? "desc" : "asc";
        } catch {
            return "asc";
        }
    });
    const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
    const [freshIds, setFreshIds] = useState<Set<number>>(new Set());
    const entryListResumeRef = useRef<EntryListHandle | null>(null);

    const pendingEntriesRef = useRef<IndexedLogEntry[]>([]);
    const pendingFreshRef = useRef<number[]>([]);
    const flushRafRef = useRef<number | null>(null);
    const freshSweepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const activeRef = useRef({ view: initial.view, source: initial.source, session: initial.session });
    const refreshInFlightRef = useRef<Promise<void> | null>(null);
    const entriesLoadGenerationRef = useRef(0);

    const invalidateEntriesLoad = useCallback((): void => {
        entriesLoadGenerationRef.current += 1;
    }, []);

    activeRef.current = { view, source: activeSource, session: activeSession };

    const goHome = useCallback(() => {
        setView("home");
        setActiveSource(null);
        setActiveSession(null);
        applyUrl("home", null, null, "replace");
    }, []);

    const openSession = useCallback((source: LogSourceId, name: string) => {
        const fromHome = activeRef.current.view === "home";
        setView("detail");
        setActiveSource(source);
        setActiveSession(name);
        applyUrl("detail", source, name, fromHome ? "push" : "replace");
    }, []);

    const refreshSessions = useCallback(async () => {
        if (refreshInFlightRef.current) {
            return refreshInFlightRef.current;
        }

        const run = async (): Promise<void> => {
            try {
                const { sessions: list } = await api.listSessions();
                setSessions(sortSessionsByRecency(list));

                const { view: currentView, source, session } = activeRef.current;

                if (currentView !== "detail") {
                    return;
                }

                const stillValid = source && session && list.some((s) => s.source === source && s.name === session);

                if (stillValid) {
                    return;
                }

                const first = list[0];
                if (first) {
                    setActiveSource(first.source);
                    setActiveSession(first.name);
                    applyUrl("detail", first.source, first.name, "replace");
                    return;
                }

                goHome();
            } catch {
                setStatus("down");
            } finally {
                refreshInFlightRef.current = null;
            }
        };

        refreshInFlightRef.current = run();
        return refreshInFlightRef.current;
    }, [goHome]);

    useEffect(() => {
        refreshSessions();
        const interval = setInterval(refreshSessions, SESSIONS_REFRESH_MS);
        return () => clearInterval(interval);
    }, [refreshSessions]);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }
        const onPop = (): void => {
            const next = readFromUrl();
            setView(next.view);
            setActiveSource(next.source);
            setActiveSession(next.session);
        };
        window.addEventListener("popstate", onPop);
        return () => window.removeEventListener("popstate", onPop);
    }, []);

    useEffect(() => {
        if (view !== "detail" || !activeSource || !activeSession) {
            setEntries([]);
            return;
        }

        let cancelled = false;
        const loadGeneration = ++entriesLoadGenerationRef.current;
        const abortController = new AbortController();
        setEntries([]);
        setExpandedIds(new Set());
        setFreshIds(new Set());

        api.getEntries(activeSource, activeSession, 0, 5000, abortController.signal)
            .then((res) => {
                if (cancelled || loadGeneration !== entriesLoadGenerationRef.current) {
                    return;
                }
                startTransition(() => {
                    setEntries(res.entries);
                });
            })
            .catch(() => {
                /* ignore — SSE will catch up */
            });

        const dispose = connectStream(activeSource, activeSession, {
            onStatus: setStatus,
            onEntry: (entry) => {
                pendingEntriesRef.current.push(entry);
                pendingFreshRef.current.push(entry.index);
                scheduleFlush();
            },
            onCleared: () => {
                invalidateEntriesLoad();
                pendingEntriesRef.current = [];
                pendingFreshRef.current = [];
                if (flushRafRef.current !== null) {
                    cancelAnimationFrame(flushRafRef.current);
                    flushRafRef.current = null;
                }
                setEntries([]);
                setExpandedIds(new Set());
                setFreshIds(new Set());
            },
        });

        return () => {
            cancelled = true;
            abortController.abort();
            dispose();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [view, activeSource, activeSession]);

    const scheduleFlush = useCallback(() => {
        if (flushRafRef.current !== null) {
            return;
        }
        flushRafRef.current = requestAnimationFrame(() => {
            flushRafRef.current = null;
            const incoming = pendingEntriesRef.current;
            const freshAdds = pendingFreshRef.current;
            pendingEntriesRef.current = [];
            pendingFreshRef.current = [];
            if (incoming.length === 0) {
                return;
            }

            setEntries((prev) => mergeIndexedLogEntries(prev, incoming));

            if (freshAdds.length > 0) {
                setFreshIds((prev) => {
                    const next = new Set(prev);
                    for (const i of freshAdds) {
                        next.add(i);
                    }
                    return next;
                });
                if (freshSweepTimerRef.current === null) {
                    freshSweepTimerRef.current = setTimeout(() => {
                        freshSweepTimerRef.current = null;
                        setFreshIds(new Set());
                    }, FRESH_TTL_MS);
                }
            }
        });
    }, []);

    useEffect(() => {
        return () => {
            if (flushRafRef.current !== null) {
                cancelAnimationFrame(flushRafRef.current);
            }
            if (freshSweepTimerRef.current !== null) {
                clearTimeout(freshSweepTimerRef.current);
            }
        };
    }, []);

    const hypotheses = useMemo(() => collectHypotheses(entries), [entries]);
    const filtered = useMemo(() => applyFilter(entries, filterState), [entries, filterState]);
    const displayed = useMemo(() => (sortDir === "desc" ? [...filtered].reverse() : filtered), [filtered, sortDir]);

    const activeSessionMeta = useMemo(() => {
        if (!activeSource || !activeSession) {
            return undefined;
        }

        return sessions.find((s) => s.source === activeSource && s.name === activeSession);
    }, [sessions, activeSource, activeSession]);

    const latestLineTs = useMemo(() => {
        if (entries.length === 0) {
            return undefined;
        }

        return entries[entries.length - 1]?.ts;
    }, [entries]);

    const onToggleLevel = useCallback((lvl: LogLevel) => {
        setFilterState((prev) => {
            const next = new Set(prev.levels);
            if (next.has(lvl)) {
                next.delete(lvl);
            } else {
                next.add(lvl);
            }
            return { ...prev, levels: next };
        });
    }, []);

    const onToggleAll = useCallback(() => {
        setFilterState((prev) => {
            const all = new Set<LogLevel>(FILTER_ORDER);
            const isAllOn = prev.levels.size === FILTER_ORDER.length;
            return { ...prev, levels: isAllOn ? new Set<LogLevel>() : all };
        });
    }, []);

    const onChangeHypothesis = useCallback((h: string | "all") => {
        setFilterState((prev) => ({ ...prev, hypothesis: h }));
    }, []);

    const onChangeSearch = useCallback((s: string) => {
        setFilterState((prev) => ({ ...prev, search: s }));
    }, []);

    const onTogglePause = useCallback(() => {
        if (paused) {
            entryListResumeRef.current?.resume();
            return;
        }

        setPaused(true);
    }, [paused]);

    const onAutoScrollChange = useCallback((enabled: boolean) => {
        setPaused(!enabled);
    }, []);

    const onToggleSort = useCallback(() => {
        setSortDir((prev) => {
            const next: SortDir = prev === "asc" ? "desc" : "asc";
            try {
                window.localStorage.setItem("dbg.sortDir", next);
            } catch {
                // localStorage unavailable
            }
            return next;
        });
    }, []);

    const onToggleExpand = useCallback((index: number) => {
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (next.has(index)) {
                next.delete(index);
            } else {
                next.add(index);
            }
            return next;
        });
    }, []);

    const onClear = useCallback(async () => {
        if (!activeSource || !activeSession) {
            return;
        }
        const ok = confirm(`Clear all logs in [${activeSource}] "${activeSession}"?`);
        if (!ok) {
            return;
        }
        invalidateEntriesLoad();
        setEntries([]);
        setExpandedIds(new Set());
        setFreshIds(new Set());
        await api.clearSession(activeSource, activeSession);
    }, [activeSource, activeSession, invalidateEntriesLoad]);

    const onDeleteSession = useCallback(
        async (source: LogSourceId, name: string) => {
            setSessions((prev) => prev.filter((session) => !(session.source === source && session.name === name)));

            try {
                await api.deleteSession(source, name);
            } catch {
                await refreshSessions();
            }
        },
        [refreshSessions]
    );

    const sessionDirSources = useMemo(() => collectSessionCwds(sessions), [sessions]);

    return (
        <DisplaySettingsProvider>
            <SessionDeleteConfirmProvider onDeleteSession={onDeleteSession}>
                <DirPathPrefixProvider paths={sessionDirSources}>
                <TooltipProvider>
                {view === "home" ? (
                    <div className="h-full min-h-0 flex flex-col">
                        <SessionsHome
                            sessions={sessions}
                            status={status}
                            onRefresh={refreshSessions}
                            onOpenSession={openSession}
                            onStatus={setStatus}
                        />
                    </div>
                ) : (
                    <EntriesContext.Provider value={entries}>
                        <div className="h-full flex flex-col relative">
                            <Header
                                sessions={sessions}
                                activeSource={activeSource}
                                activeSession={activeSession}
                                onSelectSession={(source, name) => {
                                    if (isLogSourceId(source)) {
                                        openSession(source, name);
                                    }
                                }}
                                status={status}
                                entryCount={entries.length}
                                onClear={onClear}
                                onRefresh={() => {
                                    void refreshSessions();
                                }}
                                onBack={goHome}
                            />

                            <FilterBar
                                state={filterState}
                                hypotheses={hypotheses}
                                paused={paused}
                                sortDir={sortDir}
                                session={activeSessionMeta}
                                latestLineTs={latestLineTs}
                                onToggleLevel={onToggleLevel}
                                onToggleAll={onToggleAll}
                                onChangeHypothesis={onChangeHypothesis}
                                onChangeSearch={onChangeSearch}
                                onTogglePause={onTogglePause}
                                onToggleSort={onToggleSort}
                            />

                            <EntryList
                                entries={displayed}
                                expandedIds={expandedIds}
                                freshIds={freshIds}
                                autoScroll={!paused}
                                sortDir={sortDir}
                                onToggle={onToggleExpand}
                                onFilterHypothesis={onChangeHypothesis}
                                onAutoScrollChange={onAutoScrollChange}
                                resumeRef={entryListResumeRef}
                            />

                            <footer className="px-3 sm:px-5 py-1.5 border-t border-white/8 bg-black/30 text-[10px] text-white/40 flex items-center justify-between">
                                <span>
                                    {filtered.length} / {entries.length}
                                </span>
                                <span className="text-white/25">dbg + task · live</span>
                            </footer>
                        </div>
                    </EntriesContext.Provider>
                )}
            </TooltipProvider>
                </DirPathPrefixProvider>
            </SessionDeleteConfirmProvider>
        </DisplaySettingsProvider>
    );
}
