import type { IndexedLogEntry } from "@app/debugging-master/types";
import { createContext, useContext } from "react";

/**
 * Holds the full chronological entries array for a session. Read by views
 * that need historical context (snapshot diffs, timer aggregations) — they
 * shouldn't have to receive `entries` as a prop drilled through every row.
 *
 * Default is `null` (not `[]`) so a missing provider throws instead of
 * silently rendering an "empty session" view — that bug class would be
 * invisible in production but trivially loud here.
 */
export const EntriesContext = createContext<IndexedLogEntry[] | null>(null);

export function useEntries(): IndexedLogEntry[] {
    const entries = useContext(EntriesContext);
    if (!entries) {
        throw new Error("useEntries must be used within EntriesContext.Provider");
    }
    return entries;
}
