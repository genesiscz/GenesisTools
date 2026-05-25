import { join } from "node:path";
import { SESSIONS_DIR } from "@app/debugging-master/core/paths";
import { SessionManager } from "@app/debugging-master/core/session-manager";
import type { LogEntry } from "@app/debugging-master/types";
import type { LogSource, LogSourceSession } from "./log-source";

export class DebuggingMasterLogSource implements LogSource {
    id = "debugging-master" as const;
    badge = "dbg";
    private manager = new SessionManager();

    async listSessions(): Promise<LogSourceSession[]> {
        const names = await this.manager.listSessionNames();
        const sessions: LogSourceSession[] = [];

        for (const name of names) {
            const entries = await this.manager.readEntries(name);
            sessions.push({
                source: this.id,
                name,
                badge: this.badge,
                jsonlPath: join(SESSIONS_DIR, `${name}.jsonl`),
                metaPath: join(SESSIONS_DIR, `${name}.meta.json`),
                entryCount: entries.length,
            });
        }

        return sessions;
    }

    async readEntries(sessionName: string): Promise<LogEntry[]> {
        return this.manager.readEntries(sessionName);
    }

    getJsonlPath(sessionName: string): string {
        return join(SESSIONS_DIR, `${sessionName}.jsonl`);
    }
}
