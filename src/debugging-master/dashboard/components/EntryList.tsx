import type { IndexedLogEntry } from "@app/debugging-master/types";
import { useAutoScroll } from "@app/utils/ui/hooks/useAutoScroll";
import { memo, useEffect, useImperativeHandle, useMemo } from "react";
import { DEFAULT_LOG_SEARCH, type LogSearchState } from "@/components/LogSearchPopover";
import { filterDisplayLogLines, shouldShowLogTimestamp } from "@/lib/log-line-display";
import { useScrollToFirstLogMatch } from "@/lib/use-scroll-to-first-log-match";
import { useDisplaySettings } from "./DisplaySettingsProvider";
import { EntryRow } from "./EntryRow";
import type { SortDir } from "./FilterBar";

export interface EntryListHandle {
    resume: () => void;
}

interface Props {
    entries: IndexedLogEntry[];
    expandedIds: Set<number>;
    freshIds: Set<number>;
    autoScroll: boolean;
    sortDir: SortDir;
    highlightTokens?: string[];
    hitByIndex?: Map<number, { isMatch: boolean; isContext: boolean }>;
    logSearch?: LogSearchState;
    matchCount?: number;
    isSearchActive?: boolean;
    onToggle: (index: number) => void;
    onFilterHypothesis: (h: string) => void;
    onAutoScrollChange: (enabled: boolean) => void;
    resumeRef?: React.RefObject<EntryListHandle | null>;
}

function EntryListImpl({
    entries,
    expandedIds,
    freshIds,
    autoScroll,
    sortDir,
    highlightTokens = [],
    hitByIndex,
    logSearch = DEFAULT_LOG_SEARCH,
    matchCount = 0,
    isSearchActive = false,
    onToggle,
    onFilterHypothesis,
    onAutoScrollChange,
    resumeRef,
}: Props): React.ReactElement {
    const { settings } = useDisplaySettings();
    const edge = sortDir === "desc" ? "top" : "bottom";
    const visibleEntries = useMemo(() => filterDisplayLogLines(entries), [entries]);
    const { ref, onScroll, resume } = useAutoScroll({
        enabled: autoScroll,
        onEnabledChange: onAutoScrollChange,
        edge,
        snapDeps: [visibleEntries, sortDir],
    });

    useImperativeHandle(resumeRef, () => ({ resume }), [resume]);

    // When sort direction flips, snap to the new active edge immediately.
    useEffect(() => {
        resume();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sortDir]);

    useScrollToFirstLogMatch(ref, logSearch, matchCount, isSearchActive);

    if (visibleEntries.length === 0) {
        return (
            <div className="flex-1 grid place-items-center text-white/30 text-[13px] tracking-wider uppercase">
                <div className="flex flex-col items-center gap-2">
                    <span className="status-dot status-warn" />
                    {highlightTokens.length > 0 ? "no matches" : "waiting for logs…"}
                </div>
            </div>
        );
    }

    return (
        <div ref={ref} onScroll={onScroll} className="flex-1 overflow-y-auto overflow-x-auto dbg-log-text font-mono">
            {visibleEntries.map((e, index) => {
                const previousTs = index > 0 ? visibleEntries[index - 1]?.ts : undefined;
                const showTimestamp = shouldShowLogTimestamp({
                    mode: settings.timestampMode,
                    ts: e.ts,
                    previousTs,
                });

                const hit = hitByIndex?.get(e.index);

                return (
                    <EntryRow
                        key={e.index}
                        entry={e}
                        expanded={expandedIds.has(e.index)}
                        fresh={freshIds.has(e.index)}
                        showTimestamp={showTimestamp}
                        highlightTokens={highlightTokens}
                        isMatch={hit?.isMatch}
                        isContext={hit?.isContext}
                        onToggle={onToggle}
                        onFilterHypothesis={onFilterHypothesis}
                    />
                );
            })}
        </div>
    );
}

/**
 * Memoized so unrelated App-level state churn (sessions polling every 5s,
 * fresh-marker timers expiring every 1.5s) doesn't walk the 4k+ row tree.
 * Without this, those polls trigger an `entries.map` + 4k React.memo
 * prop-equality checks on every tick, even with no data change.
 */
export const EntryList = memo(EntryListImpl);
