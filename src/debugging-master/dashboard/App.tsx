import type { IndexedLogEntry, LogLevel, SessionMeta } from "@app/debugging-master/types";
import { TooltipProvider } from "@ui/components/tooltip";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EntryList } from "@/components/EntryList";
import { FilterBar, type SortDir } from "@/components/FilterBar";
import { Header } from "@/components/Header";
import { api } from "@/lib/api";
import { EntriesContext } from "@/lib/entries-context";
import { applyFilter, collectHypotheses, defaultFilterState, type FilterState } from "@/lib/filters";
import { FILTER_ORDER } from "@/lib/levels";
import { type ConnectionStatus, connectStream } from "@/lib/sse";

const FRESH_TTL_MS = 1500;
const SESSIONS_REFRESH_MS = 5000;

function readSessionFromUrl(): string | null {
    if (typeof window === "undefined") {
        return null;
    }
    return new URLSearchParams(window.location.search).get("session");
}

function writeSessionToUrl(name: string | null): void {
    if (typeof window === "undefined") {
        return;
    }
    const url = new URL(window.location.href);
    const current = url.searchParams.get("session");
    if (name === current) {
        return;
    }
    if (name) {
        url.searchParams.set("session", name);
    } else {
        url.searchParams.delete("session");
    }
    window.history.replaceState(window.history.state, "", url);
}

export function App(): React.ReactElement {
    const [sessions, setSessions] = useState<SessionMeta[]>([]);
    const [activeSession, setActiveSession] = useState<string | null>(readSessionFromUrl);
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

    // Batched SSE delivery — accumulate incoming entries in a ref and flush
    // once per animation frame. EventSource fires `message` events as separate
    // tasks (React 18 doesn't auto-batch them), so a 300-entry backlog catch-up
    // would otherwise trigger 300 setEntries spreads (O(N²) allocations) and
    // 300 reconciliations, freezing the main thread.
    const pendingEntriesRef = useRef<IndexedLogEntry[]>([]);
    const pendingFreshRef = useRef<number[]>([]);
    const flushRafRef = useRef<number | null>(null);
    const freshSweepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const refreshSessions = useCallback(async () => {
        try {
            const { sessions: list } = await api.listSessions();
            setSessions(list);
            setActiveSession((current) => {
                if (current && list.some((s) => s.name === current)) {
                    return current;
                }
                return list[0]?.name ?? null;
            });
        } catch {
            setStatus("down");
        }
    }, []);

    useEffect(() => {
        refreshSessions();
        const interval = setInterval(refreshSessions, SESSIONS_REFRESH_MS);
        return () => clearInterval(interval);
    }, [refreshSessions]);

    // Sync activeSession ↔ URL: write on change, read on browser back/forward.
    useEffect(() => {
        writeSessionToUrl(activeSession);
    }, [activeSession]);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }
        const onPop = (): void => {
            const name = readSessionFromUrl();
            setActiveSession((current) => {
                if (name && name !== current) {
                    return name;
                }
                return current;
            });
        };
        window.addEventListener("popstate", onPop);
        return () => window.removeEventListener("popstate", onPop);
    }, []);

    useEffect(() => {
        if (!activeSession) {
            setEntries([]);
            return;
        }

        let cancelled = false;
        setEntries([]);
        setExpandedIds(new Set());
        setFreshIds(new Set());

        api.getEntries(activeSession)
            .then((res) => {
                if (cancelled) {
                    return;
                }
                // Mark the backlog hydration as a low-priority transition so React
                // can yield to user input (clicks, scrolls) while reconciling — keeps
                // the UI responsive even when the session has hundreds of entries.
                startTransition(() => {
                    setEntries(res.entries);
                });
            })
            .catch(() => {
                /* ignore — SSE will catch up */
            });

        const dispose = connectStream(activeSession, {
            onStatus: setStatus,
            onEntry: (entry) => {
                pendingEntriesRef.current.push(entry);
                pendingFreshRef.current.push(entry.index);
                scheduleFlush();
            },
            onCleared: () => {
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
            dispose();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeSession]);

    // One-shot flush: dedup against current state, append novel entries, mark
    // them fresh, schedule a single TTL sweep. Replaces the per-entry timer
    // map that was firing N independent setState calls.
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

            setEntries((prev) => {
                const lastIndex = prev.length > 0 ? prev[prev.length - 1].index : -1;
                const novel: IndexedLogEntry[] = [];
                for (const e of incoming) {
                    if (e.index > lastIndex) {
                        novel.push(e);
                    }
                }
                if (novel.length === 0) {
                    return prev;
                }
                return prev.concat(novel);
            });

            if (freshAdds.length > 0) {
                setFreshIds((prev) => {
                    const next = new Set(prev);
                    for (const i of freshAdds) {
                        next.add(i);
                    }
                    return next;
                });
                // Single TTL sweep that drains freshIds. Avoids the previous
                // map-of-N-timers that was the second-largest perf cliff.
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
        setPaused((p) => !p);
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
        if (!activeSession) {
            return;
        }
        const ok = confirm(`Clear all logs in "${activeSession}"?`);
        if (!ok) {
            return;
        }
        await api.clearSession(activeSession);
        setEntries([]);
        setExpandedIds(new Set());
        setFreshIds(new Set());
    }, [activeSession]);

    return (
        <TooltipProvider>
            <EntriesContext.Provider value={entries}>
                <div className="h-full flex flex-col relative">
                    <Header
                        sessions={sessions}
                        activeSession={activeSession}
                        onSelectSession={setActiveSession}
                        status={status}
                        entryCount={entries.length}
                        onClear={onClear}
                        onRefresh={refreshSessions}
                    />

                    <FilterBar
                        state={filterState}
                        hypotheses={hypotheses}
                        paused={paused}
                        sortDir={sortDir}
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
                    />

                    <footer className="px-3 sm:px-5 py-1.5 border-t border-white/8 bg-black/30 text-[10px] text-white/40 flex items-center justify-between">
                        <span>
                            {filtered.length} / {entries.length}
                        </span>
                        <span className="text-white/25">debugging-master · live</span>
                    </footer>
                </div>
            </EntriesContext.Provider>
        </TooltipProvider>
    );
}
