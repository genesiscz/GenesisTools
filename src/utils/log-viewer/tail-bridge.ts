import { statSync } from "node:fs";
import { FileTailer } from "@app/debugging-master/core/file-tailer";
import type { LogEntry } from "@app/debugging-master/types";
import type { JsonlLineRecord } from "@app/utils/log-session/types";
import type { LogSourceId } from "./log-source";
import { taskRecordToLogEntry } from "./log-source";
import { getLogSource } from "./resolve-log-source";
import { sessionKey } from "./session-key";

export function parseTailEntry(source: LogSourceId, raw: unknown, _fallbackIndex: number): LogEntry | null {
    if (source === "task") {
        const record = raw as { type?: string };
        if (record.type !== "line") {
            return null;
        }

        const line = record as JsonlLineRecord;
        return taskRecordToLogEntry(line);
    }

    return raw as LogEntry;
}

export function entryIndexForTail(source: LogSourceId, raw: unknown, fallbackIndex: number): number {
    if (source === "task") {
        const record = raw as { type?: string; seq?: number };
        if (record.type === "line" && typeof record.seq === "number") {
            return record.seq;
        }
    }

    return fallbackIndex;
}

export function createSourceTailer(
    source: LogSourceId,
    sessionName: string,
    onEntry: (entry: LogEntry, index: number) => void
): FileTailer {
    const path = getLogSource(source).getJsonlPath(sessionName);
    return new FileTailer(path, {
        onEntry: (raw, index) => {
            const entry = parseTailEntry(source, raw, index);
            if (!entry) {
                return;
            }

            const entryIndex = entryIndexForTail(source, raw, index);
            onEntry(entry, entryIndex);
        },
    });
}

export function enrichDashboardTimestamps(
    session: {
        name: string;
        createdAt?: number;
        lastActivityAt?: number;
    },
    jsonlPath: string
): { createdAt: number; lastActivityAt: number } {
    try {
        const st = statSync(jsonlPath);
        return {
            createdAt: session.createdAt && session.createdAt > 0 ? session.createdAt : st.birthtimeMs,
            lastActivityAt: session.lastActivityAt && session.lastActivityAt > 0 ? session.lastActivityAt : st.mtimeMs,
        };
    } catch {
        return {
            createdAt: session.createdAt ?? 0,
            lastActivityAt: session.lastActivityAt ?? 0,
        };
    }
}

export { sessionKey };
