import type { IndexedLogEntry, LogLevel } from "@app/debugging-master/types";
import { SafeJSON } from "@app/utils/json";

export interface FilterState {
    levels: Set<LogLevel>;
    hypothesis: string | "all";
    search: string;
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
        search: "",
    };
}

export function applyFilter(entries: IndexedLogEntry[], state: FilterState): IndexedLogEntry[] {
    const search = state.search.trim().toLowerCase();
    return entries.filter((e) => {
        if (!state.levels.has(e.level)) {
            return false;
        }
        if (state.hypothesis !== "all" && e.h !== state.hypothesis) {
            return false;
        }
        if (search.length > 0) {
            const haystack = entryHaystack(e);
            if (!haystack.includes(search)) {
                return false;
            }
        }
        return true;
    });
}

function entryHaystack(e: IndexedLogEntry): string {
    const parts: string[] = [e.level];
    if (e.label) {
        parts.push(e.label);
    }
    if (e.msg) {
        parts.push(e.msg);
    }
    if (e.h) {
        parts.push(e.h);
    }
    if (e.file) {
        parts.push(e.file);
    }
    if (e.data !== undefined) {
        try {
            parts.push(SafeJSON.stringify(e.data));
        } catch {
            // unstringifiable — skip
        }
    }
    if (e.vars) {
        try {
            parts.push(SafeJSON.stringify(e.vars));
        } catch {
            // unstringifiable — skip
        }
    }
    if (e.stack) {
        parts.push(e.stack);
    }
    return parts.join(" ").toLowerCase();
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
