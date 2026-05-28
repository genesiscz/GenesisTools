import type { IndexedLogEntry } from "@app/debugging-master/types";

export function mergeIndexedLogEntries(existing: IndexedLogEntry[], incoming: IndexedLogEntry[]): IndexedLogEntry[] {
    if (incoming.length === 0) {
        return existing;
    }

    const byIndex = new Map<number, IndexedLogEntry>();

    for (const entry of existing) {
        byIndex.set(entry.index, entry);
    }

    for (const entry of incoming) {
        byIndex.set(entry.index, entry);
    }

    return [...byIndex.values()].sort((a, b) => a.index - b.index);
}
