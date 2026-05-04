import type { IndexedLogEntry } from "@app/debugging-master/types";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef } from "react";
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

const ESTIMATED_ROW_PX = 44;
const OVERSCAN = 12;

export function EntryList({
    entries,
    expandedIds,
    freshIds,
    autoScroll,
    sortDir,
    onToggle,
    onFilterHypothesis,
}: Props): React.ReactElement {
    const ref = useRef<HTMLDivElement>(null);

    const virtualizer = useVirtualizer({
        count: entries.length,
        getScrollElement: () => ref.current,
        estimateSize: () => ESTIMATED_ROW_PX,
        overscan: OVERSCAN,
        getItemKey: (index) => entries[index]?.index ?? index,
    });

    // When sort direction flips, snap to the new active edge.
    useEffect(() => {
        const el = ref.current;
        if (!el) {
            return;
        }
        if (sortDir === "desc") {
            el.scrollTop = 0;
        } else {
            el.scrollTop = el.scrollHeight;
        }
    }, [sortDir]);

    // While autoscroll is on, snap to the active edge on every entry change —
    // synchronously before paint, so the user never sees a flash of the wrong
    // scroll position. When autoscroll is off, the browser's `overflow-anchor`
    // keeps the user's visible content stable as new rows prepend/append.
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || !autoScroll) {
            return;
        }
        if (sortDir === "desc") {
            el.scrollTop = 0;
        } else {
            el.scrollTop = el.scrollHeight;
        }
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

    const totalSize = virtualizer.getTotalSize();
    const items = virtualizer.getVirtualItems();

    return (
        <div ref={ref} className="flex-1 overflow-y-auto overflow-x-hidden">
            <div style={{ height: totalSize, position: "relative", width: "100%" }}>
                {items.map((vi) => {
                    const entry = entries[vi.index];
                    if (!entry) {
                        return null;
                    }
                    return (
                        <div
                            key={vi.key}
                            data-index={vi.index}
                            ref={virtualizer.measureElement}
                            style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                width: "100%",
                                transform: `translateY(${vi.start}px)`,
                            }}
                            className="border-b border-white/4"
                        >
                            <EntryRow
                                entry={entry}
                                expanded={expandedIds.has(entry.index)}
                                fresh={freshIds.has(entry.index)}
                                onToggle={onToggle}
                                onFilterHypothesis={onFilterHypothesis}
                            />
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
