import type { IndexedLogEntry, LogEntry } from "@app/debugging-master/types";
import { jsonlPath, metaPath, uiJsonlPath } from "@app/task/lib/paths";
import { TaskSessionStore } from "@app/task/lib/session-store";
import { countJsonlLineRecords } from "@app/utils/log-session/count-line-records";
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

        // Hot path: this runs on every dashboard sidebar refresh (~5s
        // polled). We deliberately AVOID readJsonlFile here — for a long-
        // running session whose jsonl is tens-to-hundreds of MB, parsing
        // every record per refresh per session was the dominant cost
        // (gemini-code-assist on PR #184 thread t9). entryCount uses a
        // fast indexOf scan of `"type":"line"`; listing meta resolves from
        // the persisted .meta.json (no jsonl read needed in the common
        // case). The detail view still parses records via readEntries().
        for (const name of names) {
            const path = jsonlPath(name);
            const listing = await resolveTaskSessionListingMeta({
                store: this.store,
                name,
                jsonlPath: path,
            });
            const entryCount = await countJsonlLineRecords(path);
            sessions.push({
                source: this.id,
                name,
                badge: this.badge,
                jsonlPath: path,
                metaPath: metaPath(name),
                entryCount,
                projectPath: listing.cwd,
                command: listing.command,
                createdAt: listing.createdAt,
                lastActivityAt: listing.lastActivityAt,
            });
        }

        return sessions;
    }

    async readEntries(sessionName: string): Promise<LogEntry[]> {
        const indexed = await this.readIndexedEntries(sessionName);

        return indexed.map(({ index: _index, ...entry }) => entry);
    }

    async readIndexedEntries(sessionName: string): Promise<IndexedLogEntry[]> {
        const records = await readJsonlFile(jsonlPath(sessionName));
        const uiMap = await readUiLineMap(uiJsonlPath(sessionName));

        return filterLineRecords(records).map((record) => ({
            ...taskRecordToLogEntry(record, uiMap.get(record.seq)),
            index: record.seq,
        }));
    }

    getJsonlPath(sessionName: string): string {
        return jsonlPath(sessionName);
    }

    async deleteSession(sessionName: string): Promise<void> {
        await this.store.deleteSession(sessionName);
    }

    async clearSession(sessionName: string): Promise<void> {
        await this.store.clearSessionLogs(sessionName);
    }
}
