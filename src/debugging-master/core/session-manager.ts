import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { LogEntry, SessionMeta } from "@app/debugging-master/types";
import { suggestCommand } from "@app/utils/cli/executor";
import { fuzzyFind } from "@app/utils/string";
import { ConfigManager } from "./config-manager";

export const ACTIVE_THRESHOLD_MS = 60 * 60 * 1000;
const TOOL_NAME = "tools debugging-master";

export class SessionManager {
    private config: ConfigManager;

    constructor(config?: ConfigManager) {
        this.config = config ?? new ConfigManager();
    }

    getConfig(): ConfigManager {
        return this.config;
    }

    async getSessionsDir(): Promise<string> {
        const dir = this.config.getSessionsDir();
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        return dir;
    }

    async createSession(name: string, projectPath: string, opts?: { serve?: boolean; port?: number }): Promise<string> {
        const dir = await this.getSessionsDir();
        const jsonlPath = join(dir, `${name}.jsonl`);
        const metaPath = join(dir, `${name}.meta.json`);

        if (existsSync(jsonlPath)) {
            throw new Error(`Session "${name}" already exists. Use a different name or remove it first.`);
        }

        const now = Date.now();
        const meta: SessionMeta = {
            name,
            projectPath,
            createdAt: now,
            lastActivityAt: now,
            ...(opts?.serve !== undefined && { serve: opts.serve }),
            ...(opts?.port !== undefined && { port: opts.port }),
        };

        await Bun.write(jsonlPath, "");
        await Bun.write(metaPath, JSON.stringify(meta, null, "\t"));

        await this.config.setRecentSession(name);

        return jsonlPath;
    }

    async resolveSession(sessionFlag?: string): Promise<string> {
        const names = await this.listSessionNames();

        if (sessionFlag) {
            if (names.includes(sessionFlag)) {
                await this.config.setRecentSession(sessionFlag);
                return sessionFlag;
            }

            const match = fuzzyFind(sessionFlag, names);
            if (match) {
                await this.config.setRecentSession(match);
                return match;
            }

            const available = names.length > 0 ? names.join(", ") : "(none)";
            throw new Error(
                `Session "${sessionFlag}" not found. Available: ${available}\n` +
                    `Tip: ${TOOL_NAME} start --session ${sessionFlag}`,
            );
        }

        const recent = await this.config.getRecentSession();
        if (recent && names.includes(recent)) {
            const meta = await this.getSessionMeta(recent);
            if (meta && Date.now() - meta.lastActivityAt < ACTIVE_THRESHOLD_MS) {
                return recent;
            }
        }

        const activeSessions = await this.getActiveSessions();

        if (activeSessions.length === 1) {
            const name = activeSessions[0].name;
            await this.config.setRecentSession(name);
            return name;
        }

        if (activeSessions.length > 1) {
            const suggestions = activeSessions
                .map((s) => `  ${suggestCommand(TOOL_NAME, { add: ["--session", s.name] })}`)
                .join("\n");
            throw new Error(`Multiple active sessions found. Specify one with --session:\n${suggestions}`);
        }

        throw new Error(`No active sessions. Start one with:\n  ${TOOL_NAME} start --session <name>`);
    }

    async listSessionNames(): Promise<string[]> {
        const dir = await this.getSessionsDir();
        const files = readdirSync(dir);
        return files.filter((f) => f.endsWith(".jsonl")).map((f) => basename(f, ".jsonl"));
    }

    async getActiveSessions(): Promise<SessionMeta[]> {
        const names = await this.listSessionNames();
        const now = Date.now();
        const active: SessionMeta[] = [];

        for (const name of names) {
            const meta = await this.getSessionMeta(name);
            if (meta && now - meta.lastActivityAt < ACTIVE_THRESHOLD_MS) {
                active.push(meta);
            }
        }

        return active;
    }

    async getSessionMeta(name: string): Promise<SessionMeta | null> {
        const dir = await this.getSessionsDir();
        const metaPath = join(dir, `${name}.meta.json`);
        if (!existsSync(metaPath)) {
            return null;
        }

        try {
            return (await Bun.file(metaPath).json()) as SessionMeta;
        } catch {
            return null;
        }
    }

    async touchSession(name: string): Promise<void> {
        const dir = await this.getSessionsDir();
        const metaPath = join(dir, `${name}.meta.json`);
        if (!existsSync(metaPath)) {
            return;
        }

        try {
            const meta = (await Bun.file(metaPath).json()) as SessionMeta;
            meta.lastActivityAt = Date.now();
            await Bun.write(metaPath, JSON.stringify(meta, null, "\t"));
        } catch {
            // Silently ignore corrupted meta files
        }
    }

    async readEntries(name: string): Promise<LogEntry[]> {
        const dir = await this.getSessionsDir();
        const jsonlPath = join(dir, `${name}.jsonl`);
        if (!existsSync(jsonlPath)) {
            return [];
        }

        const text = await Bun.file(jsonlPath).text();
        if (!text.trim()) {
            return [];
        }

        const lines = text.trim().split("\n");
        const entries: LogEntry[] = [];

        for (const line of lines) {
            try {
                entries.push(JSON.parse(line) as LogEntry);
            } catch {
                entries.push({ level: "raw", msg: line, ts: 0 });
            }
        }

        return entries;
    }

    async getSessionPath(name: string): Promise<string> {
        const dir = await this.getSessionsDir();
        return join(dir, `${name}.jsonl`);
    }
}
