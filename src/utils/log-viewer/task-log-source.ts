import type { LogEntry } from "@app/debugging-master/types";
import { jsonlPath, metaPath } from "@app/task/lib/paths";
import { TaskSessionStore } from "@app/task/lib/session-store";
import { filterLineRecords, readJsonlFile } from "@app/utils/log-session/jsonl-reader";
import { DebuggingMasterLogSource } from "./debugging-master-log-source";
import type { LogSource, LogSourceSession } from "./log-source";
import { taskRecordToLogEntry } from "./log-source";

export class TaskLogSource implements LogSource {
    id = "task" as const;
    badge = "task";
    private store = new TaskSessionStore();

    async listSessions(): Promise<LogSourceSession[]> {
        const names = await this.store.listSessionNames();
        const sessions: LogSourceSession[] = [];

        for (const name of names) {
            const records = await readJsonlFile(jsonlPath(name));
            const lines = filterLineRecords(records);
            sessions.push({
                source: this.id,
                name,
                badge: this.badge,
                jsonlPath: jsonlPath(name),
                metaPath: metaPath(name),
                entryCount: lines.length,
            });
        }

        return sessions;
    }

    async readEntries(sessionName: string): Promise<LogEntry[]> {
        const records = await readJsonlFile(jsonlPath(sessionName));
        return filterLineRecords(records).map(taskRecordToLogEntry);
    }

    getJsonlPath(sessionName: string): string {
        return jsonlPath(sessionName);
    }
}

export function getAllLogSources(): LogSource[] {
    return [new DebuggingMasterLogSource(), new TaskLogSource()];
}
