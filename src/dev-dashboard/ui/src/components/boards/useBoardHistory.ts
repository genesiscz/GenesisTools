import { useCallback, useRef } from "react";

export interface HistoryEntry {
    label: string;
    undo: () => Promise<void>;
    redo: () => Promise<void>;
}

export interface BoardHistory {
    push: (entry: HistoryEntry) => void;
    undo: () => void;
    redo: () => void;
}

const MAX_ENTRIES = 200;

/** Client-side undo/redo stack. Vitrinka keeps this server-side (per-actor op log, X-Gesture
 *  grouping); we run a single-operator dashboard, so a client stack over the same optimistic
 *  mutations is enough — deletes stay undoable with STABLE ids because the server soft-deletes
 *  (`POST /cards/:id/restore`). Steps serialize through a promise queue so rapid ⌘Z/⇧⌘Z run
 *  in order even while the previous step's request is in flight (vitrinka board-1.mjs:6401-6411). */
export function useBoardHistory(): BoardHistory {
    const undoStack = useRef<HistoryEntry[]>([]);
    const redoStack = useRef<HistoryEntry[]>([]);
    const queue = useRef<Promise<void>>(Promise.resolve());

    const push = useCallback((entry: HistoryEntry) => {
        undoStack.current.push(entry);

        if (undoStack.current.length > MAX_ENTRIES) {
            undoStack.current.shift();
        }

        redoStack.current = [];
    }, []);

    const undo = useCallback(() => {
        const entry = undoStack.current.pop();

        if (!entry) {
            return;
        }

        redoStack.current.push(entry);
        queue.current = queue.current.then(() =>
            entry.undo().catch((err) => {
                console.error(`[boards] undo failed: ${entry.label}`, err);
            })
        );
    }, []);

    const redo = useCallback(() => {
        const entry = redoStack.current.pop();

        if (!entry) {
            return;
        }

        undoStack.current.push(entry);
        queue.current = queue.current.then(() =>
            entry.redo().catch((err) => {
                console.error(`[boards] redo failed: ${entry.label}`, err);
            })
        );
    }, []);

    return { push, undo, redo };
}
