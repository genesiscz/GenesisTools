import type { IndexedLogEntry } from "@app/debugging-master/types";
import { createContext, useContext } from "react";

/**
 * Holds the full chronological entries array for a session. Read by views
 * that need historical context (snapshot diffs, timer aggregations) — they
 * shouldn't have to receive `entries` as a prop drilled through every row.
 */
export const EntriesContext = createContext<IndexedLogEntry[]>([]);

export function useEntries(): IndexedLogEntry[] {
    return useContext(EntriesContext);
}
