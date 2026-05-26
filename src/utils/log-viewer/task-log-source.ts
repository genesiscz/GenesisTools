import type { LogEntry } from "@app/debugging-master/types";
import { jsonlPath, metaPath, uiJsonlPath } from "@app/task/lib/paths";
import { TaskSessionStore } from "@app/task/lib/session-store";
import { filterLineRecords, readJsonlFile } from "@app/utils/log-session/jsonl-reader";
import { readUiLineMap } from "@app/utils/log-session/ui-jsonl";
import { resolveTaskSessionListingMeta } from "@app/utils/log-viewer/task-session-listing-meta";
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
            const path = jsonlPath(name);
            const records = await readJsonlFile(path);
            const listing = await resolveTaskSessionListingMeta({
                store: this.store,
                name,
                jsonlPath: path,
                records,
            });
            const lines = filterLineRecords(records);
            sessions.push({
                source: this.id,
                name,
                badge: this.badge,
                jsonlPath: path,
                metaPath: metaPath(name),
                entryCount: lines.length,
                projectPath: listing.cwd,
                command: listing.command,
                createdAt: listing.createdAt,
                lastActivityAt: listing.lastActivityAt,
            });
        }

        return sessions;
    }

    async readEntries(sessionName: string): Promise<LogEntry[]> {
        const records = await readJsonlFile(jsonlPath(sessionName));
        const uiMap = await readUiLineMap(uiJsonlPath(sessionName));

        return filterLineRecords(records).map((record) => taskRecordToLogEntry(record, uiMap.get(record.seq)));
    }

    getUiJsonlPath(sessionName: string): string {
        return uiJsonlPath(sessionName);
    }

    getJsonlPath(sessionName: string): string {
        return jsonlPath(sessionName);
    }

    async deleteSession(sessionName: string): Promise<void> {
        await this.store.deleteSession(sessionName);
    }
}
