import {
    flattenMosaicLeaves,
    pruneMosaicLeaves,
    reconcileMosaicLayout,
} from "@genesiscz/utils/ui/helpers/mosaic-layout";
import { useCallback, useMemo } from "react";
import type { MosaicNode } from "react-mosaic-component";
import { parseStringArray, usePersistedState } from "@/lib/persisted-state";

interface StoredMosaic {
    node: MosaicNode<string> | null;
    hidden: string[];
}

function isMosaicNode(raw: unknown): raw is MosaicNode<string> {
    if (typeof raw === "string") {
        return true;
    }

    if (typeof raw !== "object" || raw === null) {
        return false;
    }

    const record = raw as Record<string, unknown>;
    return record.type === "split" && Array.isArray(record.children) && record.children.every(isMosaicNode);
}

function parseStored(raw: unknown): StoredMosaic | null {
    if (typeof raw !== "object" || raw === null) {
        return null;
    }

    const record = raw as Record<string, unknown>;
    const hidden = parseStringArray(record.hidden);

    if (!hidden) {
        return null;
    }

    if (record.node !== null && !isMosaicNode(record.node)) {
        return null;
    }

    return { node: (record.node as MosaicNode<string> | null) ?? null, hidden };
}

const EMPTY: StoredMosaic = { node: null, hidden: [] };

/**
 * A react-mosaic tiling layout for one page section, persisted per browser, the same
 * mechanism the ttyd and cmux pages use for their panes. `ids` is the canonical block list;
 * blocks added later appear in the layout, removed ones are pruned, hidden ones wait in
 * `hidden` until shown again.
 */
export function useMosaicLayout(storageKey: string, ids: readonly string[], maxColumns = 2) {
    const [stored, setStored, reset] = usePersistedState<StoredMosaic>(storageKey, parseStored, EMPTY);
    const hiddenSet = useMemo(() => new Set(stored.hidden), [stored.hidden]);
    const visibleIds = useMemo(() => ids.filter((id) => !hiddenSet.has(id)), [ids, hiddenSet]);
    const node = useMemo(
        () => reconcileMosaicLayout(pruneMosaicLeaves(stored.node, hiddenSet), visibleIds, { maxColumns }),
        [stored.node, hiddenSet, visibleIds, maxColumns]
    );

    const setNode = useCallback(
        (next: MosaicNode<string> | null) => setStored((prev) => ({ ...prev, node: next })),
        [setStored]
    );
    const hide = useCallback(
        (id: string) =>
            setStored((prev) => ({
                node: pruneMosaicLeaves(prev.node, new Set([id])),
                hidden: prev.hidden.includes(id) ? prev.hidden : [...prev.hidden, id],
            })),
        [setStored]
    );
    const show = useCallback(
        (id: string) => setStored((prev) => ({ ...prev, hidden: prev.hidden.filter((x) => x !== id) })),
        [setStored]
    );

    const hidden = useMemo(() => ids.filter((id) => hiddenSet.has(id)), [ids, hiddenSet]);
    const order = useMemo(() => flattenMosaicLeaves(node), [node]);

    return { node, setNode, hide, show, hidden, order, reset };
}
