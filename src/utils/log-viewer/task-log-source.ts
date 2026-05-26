import type { LogEntry } from "@app/debugging-master/types";
import { jsonlPath, metaPath } from "@app/task/lib/paths";
import { TaskSessionStore } from "@app/task/lib/session-store";
import { filterLineRecords, readJsonlFile } from "@app/utils/log-session/jsonl-reader";
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
            const meta = await this.store.getSessionMeta(name);
            const records = await readJsonlFile(jsonlPath(name));
            const lines = filterLineRecords(records);
            sessions.push({
                source: this.id,
                name,
                badge: this.badge,
                jsonlPath: jsonlPath(name),
                metaPath: metaPath(name),
                entryCount: lines.length,
                command: meta?.command,
                createdAt: meta?.createdAt,
                lastActivityAt: meta?.lastActivityAt,
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

    async deleteSession(sessionName: string): Promise<void> {
        await this.store.deleteSession(sessionName);
    }
}
