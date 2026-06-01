import type { IndexedLogEntry, LogLevel } from "@app/debugging-master/types";

export interface FilterState {
    levels: Set<LogLevel>;
    hypothesis: string | "all";
}

export function defaultFilterState(): FilterState {
    return {
        levels: new Set<LogLevel>([
            "dump",
            "info",
            "warn",
            "error",
            "timer-start",
            "timer-end",
            "checkpoint",
            "assert",
            "snapshot",
            "trace",
            "raw",
        ]),
        hypothesis: "all",
    };
}

export function applyFilter(entries: IndexedLogEntry[], state: FilterState): IndexedLogEntry[] {
    return entries.filter((e) => {
        if (!state.levels.has(e.level)) {
            return false;
        }

        if (state.hypothesis !== "all" && e.h !== state.hypothesis) {
            return false;
        }

        return true;
    });
}

/** Collect distinct hypothesis tags from a set of entries. */
export function collectHypotheses(entries: IndexedLogEntry[]): string[] {
    const set = new Set<string>();
    for (const e of entries) {
        if (e.h) {
            set.add(e.h);
        }
    }
    return [...set].sort();
}
