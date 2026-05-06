import type { IndexedLogEntry } from "@app/debugging-master/types";
import { memo, useEffect, useRef } from "react";
import { EntryRow } from "./EntryRow";
import type { SortDir } from "./FilterBar";

interface Props {
    entries: IndexedLogEntry[];
    expandedIds: Set<number>;
    freshIds: Set<number>;
    autoScroll: boolean;
    sortDir: SortDir;
    onToggle: (index: number) => void;
    onFilterHypothesis: (h: string) => void;
}

function EntryListImpl({
    entries,
    expandedIds,
    freshIds,
    autoScroll,
    sortDir,
    onToggle,
    onFilterHypothesis,
}: Props): React.ReactElement {
    const ref = useRef<HTMLDivElement>(null);

    // When sort direction flips, snap to the new active edge.
    // `Number.MAX_SAFE_INTEGER` is the trick to scroll-to-bottom without
    // reading `scrollHeight` — the browser clamps internally. Reading
    // `scrollHeight` forces a sync layout pass, which is what was throttling
    // bursty ingest at 300+ rows.
    useEffect(() => {
        const el = ref.current;
        if (!el) {
            return;
        }
        el.scrollTop = sortDir === "desc" ? 0 : Number.MAX_SAFE_INTEGER;
    }, [sortDir]);

    // While autoscroll is on, snap to the active edge on every entry change.
    // `useEffect` (post-paint) instead of `useLayoutEffect` — the bottom-snap
    // doesn't need to be synchronous; `overflow-anchor` keeps the visible
    // content stable across the brief gap. Trading a single frame of "wrong"
    // scroll position for not blocking paint on every burst.
    useEffect(() => {
        const el = ref.current;
        if (!el || !autoScroll) {
            return;
        }
        el.scrollTop = sortDir === "desc" ? 0 : Number.MAX_SAFE_INTEGER;
    }, [entries, autoScroll, sortDir]);

    if (entries.length === 0) {
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
        <div ref={ref} className="flex-1 overflow-y-auto overflow-x-hidden divide-y divide-white/4">
            {entries.map((e) => (
                <EntryRow
                    key={e.index}
                    entry={e}
                    expanded={expandedIds.has(e.index)}
                    fresh={freshIds.has(e.index)}
                    onToggle={onToggle}
                    onFilterHypothesis={onFilterHypothesis}
                />
            ))}
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
