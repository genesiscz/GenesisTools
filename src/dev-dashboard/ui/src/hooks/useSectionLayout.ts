import { useCallback, useMemo } from "react";
import { type BlockEntry, moveById, parseBlockEntries, reconcileLayout, setVisible } from "@/lib/block-layout";
import { usePersistedState } from "@/lib/persisted-state";

/**
 * Ordered, hideable blocks inside one page section. `defaults` is the canonical
 * block list; the stored layout is reconciled against it on every read.
 */
export function useSectionLayout(storageKey: string, defaults: readonly string[]) {
    const fallback = useMemo(() => defaults.map((id) => ({ id, visible: true })), [defaults]);
    const [stored, setStored, reset] = usePersistedState<BlockEntry[]>(storageKey, parseBlockEntries, fallback);
    const layout = useMemo(() => reconcileLayout(stored, defaults), [stored, defaults]);

    const move = useCallback(
        (id: string, direction: -1 | 1) => setStored(moveById(layout, id, direction)),
        [layout, setStored]
    );
    const hide = useCallback((id: string) => setStored(setVisible(layout, id, false)), [layout, setStored]);
    const show = useCallback((id: string) => setStored(setVisible(layout, id, true)), [layout, setStored]);
    const setOrder = useCallback(
        (ids: readonly string[]) => {
            const visibility = new Map(layout.map((b) => [b.id, b.visible] as const));
            setStored(
                reconcileLayout(
                    ids.map((id) => ({ id, visible: visibility.get(id) ?? true })),
                    defaults
                )
            );
        },
        [layout, setStored, defaults]
    );

    return { layout, move, hide, show, setOrder, reset };
}
