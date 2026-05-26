import { existsSync, unlinkSync, writeFileSync } from "node:fs";
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
            const meta = await this.manager.getSessionMeta(name);
            const entries = await this.manager.readEntries(name);
            sessions.push({
                source: this.id,
                name,
                badge: this.badge,
                jsonlPath: join(SESSIONS_DIR, `${name}.jsonl`),
                metaPath: join(SESSIONS_DIR, `${name}.meta.json`),
                entryCount: entries.length,
                projectPath: meta?.projectPath,
                createdAt: meta?.createdAt,
                lastActivityAt: meta?.lastActivityAt,
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

    async deleteSession(sessionName: string): Promise<void> {
        const dir = SESSIONS_DIR;
        for (const suffix of [".jsonl", ".meta.json"]) {
            const path = join(dir, `${sessionName}${suffix}`);
            if (existsSync(path)) {
                unlinkSync(path);
            }
        }
    }

    async clearSession(sessionName: string): Promise<void> {
        const path = join(SESSIONS_DIR, `${sessionName}.jsonl`);
        if (existsSync(path)) {
            writeFileSync(path, "");
        }
    }
}
