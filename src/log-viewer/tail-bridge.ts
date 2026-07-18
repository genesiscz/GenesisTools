import { statSync } from "node:fs";
import { FileTailer } from "@app/debugging-master/core/file-tailer";
import type { LogEntry } from "@app/debugging-master/types";
import type { JsonlLineRecord } from "@app/utils/log-session/types";
import type { LogSourceId } from "./log-source";
import { taskRecordToLogEntry } from "./log-source";
import { getLogSource } from "./resolve-log-source";
import { sessionKey } from "./session-key";
import { ensureTaskUiTailer, lookupTaskUiText, preloadTaskUiLineMap } from "./task-ui-lines";

export function parseTailEntry(
    source: LogSourceId,
    raw: unknown,
    _fallbackIndex: number,
    uiKey?: string
): LogEntry | null {
    if (source === "task") {
        const record = raw as { type?: string };
        if (record.type !== "line") {
            return null;
        }

        const line = record as JsonlLineRecord;
        const uiText = uiKey ? lookupTaskUiText(uiKey, line.seq) : undefined;

        return taskRecordToLogEntry(line, uiText);
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
    onEntry: (entry: LogEntry, index: number) => void,
    onTruncated?: () => void
): FileTailer {
    const path = getLogSource(source).getJsonlPath(sessionName);
    const key = sessionKey(source, sessionName);

    if (source === "task") {
        void preloadTaskUiLineMap(key, sessionName);
        ensureTaskUiTailer(sessionName, key);
    }

    return new FileTailer(path, {
        onEntry: (raw, index) => {
            const entry = parseTailEntry(source, raw, index, key);
            if (!entry) {
                return;
            }

            const entryIndex = entryIndexForTail(source, raw, index);
            onEntry(entry, entryIndex);
        },
        onTruncated,
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
            lastActivityAt: Math.max(
                session.lastActivityAt && session.lastActivityAt > 0 ? session.lastActivityAt : 0,
                st.mtimeMs
            ),
        };
    } catch {
        return {
            createdAt: session.createdAt ?? 0,
            lastActivityAt: session.lastActivityAt ?? 0,
        };
    }
}

export { sessionKey };
