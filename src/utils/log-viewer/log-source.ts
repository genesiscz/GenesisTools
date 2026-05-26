import type { LogEntry } from "@app/debugging-master/types";
import { inferLineLevel } from "@app/utils/log-session/infer-line-level";
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

export type DashboardSessionState = "active" | "exited" | "unknown";

export interface DashboardSession {
    source: LogSourceId;
    name: string;
    badge: string;
    projectPath: string;
    command?: string;
    createdAt: number;
    lastActivityAt: number;
    entryCount?: number;
    state: DashboardSessionState;
    stateLabel: string;
    exitCode?: number;
    exitedAt?: number;
}

export interface LogSource {
    id: LogSourceId;
    badge: string;
    listSessions(): Promise<LogSourceSession[]>;
    readEntries(sessionName: string): Promise<LogEntry[]>;
    getJsonlPath(sessionName: string): string;
    deleteSession(sessionName: string): Promise<void>;
}

export function taskRecordToLogEntry(r: JsonlLineRecord, uiText?: string): LogEntry {
    const level = r.level ?? inferLineLevel(r.out, r.text);

    return {
        level,
        label: r.out,
        msg: r.text,
        msgAnsi: uiText ?? r.raw,
        ts: r.ts,
    };
}
