import type { IndexedLogEntry } from "@app/debugging-master/types";
import { useAutoScroll } from "@app/utils/ui/hooks/useAutoScroll";
import { memo, useEffect, useImperativeHandle, useMemo } from "react";
import { filterDisplayLogLines, shouldShowLogTimestamp } from "@/lib/log-line-display";
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

    if (visibleEntries.length === 0) {
        return (
            <div className="flex-1 grid place-items-center text-white/30 text-[13px] tracking-wider uppercase">
                <div className="flex flex-col items-center gap-2">
                    <span className="status-dot status-warn" />
                    waiting for logs…
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

                return (
                    <EntryRow
                        key={e.index}
                        entry={e}
                        expanded={expandedIds.has(e.index)}
                        fresh={freshIds.has(e.index)}
                        showTimestamp={showTimestamp}
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
