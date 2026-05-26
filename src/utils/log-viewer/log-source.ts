import type { LogEntry } from "@app/debugging-master/types";
import type { JsonlLineRecord } from "@app/utils/log-session/types";

export type LogSourceId = "debugging-master" | "task";

export interface LogSourceSession {
    source: LogSourceId;
    name: string;
    badge: string;
    jsonlPath: string;
    metaPath?: string;
    entryCount?: number;
    projectPath?: string;
    command?: string;
    createdAt?: number;
    lastActivityAt?: number;
}

export interface DashboardSession {
    source: LogSourceId;
    name: string;
    badge: string;
    projectPath: string;
    command?: string;
    createdAt: number;
    lastActivityAt: number;
    entryCount?: number;
}

export interface LogSource {
    id: LogSourceId;
    badge: string;
    listSessions(): Promise<LogSourceSession[]>;
    readEntries(sessionName: string): Promise<LogEntry[]>;
    getJsonlPath(sessionName: string): string;
}

export function taskRecordToLogEntry(r: JsonlLineRecord): LogEntry {
    const level = r.level ?? (r.out === "stderr" ? "error" : "info");

    return {
        level,
        label: r.out,
        msg: r.text,
        ts: r.ts,
    };
}
