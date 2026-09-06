import { useCallback, useMemo } from "react";
import {
    type BlockEntry,
    moveItem,
    moveVisible,
    parseBlockEntries,
    reconcileLayout,
    setVisible,
} from "@/lib/block-layout";
import { usePersistedState } from "@/lib/persisted-state";

/**
 * Ordered, hideable blocks inside one page section. `defaults` is the canonical
 * block list; the stored layout is reconciled against it on every read.
 */
export function useSectionLayout(storageKey: string, defaults: readonly string[]) {
    const fallback = useMemo(() => defaults.map((id) => ({ id, visible: true })), [defaults]);
    const [stored, setStored, reset] = usePersistedState<BlockEntry[]>(storageKey, parseBlockEntries, fallback);
    const layout = useMemo(() => reconcileLayout(stored, defaults), [stored, defaults]);

    // The arrow buttons index the VISIBLE blocks, so one click must land on the
    // next visible neighbour rather than on whatever sits next in storage.
    const move = useCallback(
        (id: string, direction: -1 | 1) => setStored(moveVisible(layout, id, direction)),
        [layout, setStored]
    );
    // A drag lands one block on another, which is a move to an arbitrary index rather
    // than the single step `move` takes. Both ids are addressed in the FULL layout, so
    // hidden blocks keep their place in the stored order.
    const reorder = useCallback(
        (activeId: string, overId: string) => {
            const from = layout.findIndex((b) => b.id === activeId);
            const to = layout.findIndex((b) => b.id === overId);

            if (from === -1 || to === -1) {
                return;
            }

            setStored(moveItem(layout, from, to));
        },
        [layout, setStored]
    );
    const hide = useCallback((id: string) => setStored(setVisible(layout, id, false)), [layout, setStored]);
    const show = useCallback((id: string) => setStored(setVisible(layout, id, true)), [layout, setStored]);

    return { layout, move, reorder, hide, show, reset };
}
