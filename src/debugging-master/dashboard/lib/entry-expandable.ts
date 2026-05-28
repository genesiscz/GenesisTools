import type { LogEntry } from "@app/debugging-master/types";

function hasPayload(value: unknown): boolean {
    if (value === undefined || value === null) {
        return false;
    }

    if (typeof value === "object") {
        if (Array.isArray(value)) {
            return value.length > 0;
        }

        return Object.keys(value).length > 0;
    }

    return true;
}

export function entryHasExpandableContent(entry: LogEntry): boolean {
    if (hasPayload(entry.vars)) {
        return true;
    }

    if (hasPayload(entry.data)) {
        return true;
    }

    if (entry.stack?.trim()) {
        return true;
    }

    if (hasPayload(entry.ctx)) {
        return true;
    }

    if (entry.h) {
        return true;
    }

    if (entry.file) {
        return true;
    }

    if (entry.level === "timer-end" && entry.label) {
        return true;
    }

    return false;
}
