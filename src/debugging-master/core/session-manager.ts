import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type { LogEntry, SessionMeta } from "@app/debugging-master/types";
import { suggestCommand } from "@app/utils/cli/executor";
import { parseVariadic } from "@app/utils/cli/variadic";
import { formatRelativeTime } from "@app/utils/format";
import { SafeJSON } from "@app/utils/json";
import { fuzzyFind } from "@app/utils/string";
import { formatTable } from "@app/utils/table";
import { ConfigManager } from "./config-manager";

export const ACTIVE_THRESHOLD_MS = 2 * 60 * 60 * 1000;
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
        await Bun.write(metaPath, SafeJSON.stringify(meta, null, "\t"));

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
                    `Tip: ${TOOL_NAME} start --session ${sessionFlag}`
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
            await Bun.write(metaPath, SafeJSON.stringify(meta, null, "\t"));
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
                entries.push(SafeJSON.parse(line, { strict: true }) as LogEntry);
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

    async deleteSession(name: string): Promise<boolean> {
        const dir = await this.getSessionsDir();
        const jsonlPath = join(dir, `${name}.jsonl`);
        const metaPath = join(dir, `${name}.meta.json`);

        if (!existsSync(jsonlPath) && !existsSync(metaPath)) {
            return false;
        }

        if (existsSync(jsonlPath)) {
            unlinkSync(jsonlPath);
        }

        if (existsSync(metaPath)) {
            unlinkSync(metaPath);
        }

        const recent = await this.config.getRecentSession();

        if (recent === name) {
            const cfg = await this.config.load();
            delete cfg.recentSession;
            await this.config.save();
        }

        return true;
    }

    async getInactiveSessions(thresholdMs: number = 24 * 60 * 60 * 1000): Promise<SessionMeta[]> {
        const names = await this.listSessionNames();
        const now = Date.now();
        const inactive: SessionMeta[] = [];

        for (const name of names) {
            const meta = await this.getSessionMeta(name);

            if (meta && now - meta.lastActivityAt >= thresholdMs) {
                inactive.push(meta);
            }
        }

        return inactive;
    }

    async resolveSessionInteractive(sessionFlag?: string): Promise<string[]> {
        if (sessionFlag) {
            const requested = parseVariadic(sessionFlag);
            const names = await this.listSessionNames();
            const resolved: string[] = [];

            for (const req of requested) {
                if (names.includes(req)) {
                    resolved.push(req);
                    continue;
                }

                const match = fuzzyFind(req, names);

                if (match) {
                    resolved.push(match);
                } else {
                    throw new Error(`Session "${req}" not found. Available: ${names.join(", ") || "(none)"}`);
                }
            }

            return resolved;
        }

        const names = await this.listSessionNames();

        if (names.length === 0) {
            throw new Error(`No sessions found. Start one with:\n  ${TOOL_NAME} start --session <name>`);
        }

        if (names.length === 1) {
            return [names[0]];
        }

        if (process.stdout.isTTY) {
            const { multiselect } = await import("@clack/prompts");
            const allMeta: Array<{ name: string; meta: SessionMeta | null }> = [];

            for (const name of names) {
                const meta = await this.getSessionMeta(name);
                allMeta.push({ name, meta });
            }

            const now = Date.now();
            const options = allMeta.map(({ name, meta }) => {
                const isActive = meta ? now - meta.lastActivityAt < ACTIVE_THRESHOLD_MS : false;
                const lastStr = meta?.lastActivityAt
                    ? formatRelativeTime(new Date(meta.lastActivityAt), { compact: true })
                    : "unknown";
                const project = meta?.projectPath ? basename(meta.projectPath) : "";
                const hint = [lastStr, project, isActive ? "active" : ""].filter(Boolean).join(" | ");
                return { value: name, label: name, hint };
            });

            const selected = await multiselect({
                message: "Select session(s)",
                options,
                required: true,
            });

            if (typeof selected === "symbol") {
                throw new Error("Session selection cancelled.");
            }

            return selected as string[];
        }

        const allMeta: Array<{ name: string; meta: SessionMeta | null }> = [];

        for (const name of names) {
            const meta = await this.getSessionMeta(name);
            allMeta.push({ name, meta });
        }

        const now = Date.now();
        const headers = ["Name", "Last Activity", "Project", "Status"];
        const rows = allMeta.map(({ name, meta }) => {
            const isActive = meta ? now - meta.lastActivityAt < ACTIVE_THRESHOLD_MS : false;
            const lastStr = meta?.lastActivityAt
                ? formatRelativeTime(new Date(meta.lastActivityAt), { compact: true })
                : "unknown";
            const project = meta?.projectPath ? basename(meta.projectPath) : "unknown";
            return [name, lastStr, project, isActive ? "active" : ""];
        });

        console.log(formatTable(rows, headers));
        console.log("");

        for (const { name } of allMeta) {
            console.log(`  ${suggestCommand(TOOL_NAME, { add: ["--session", name] })}`);
        }

        throw new Error("Multiple sessions found. Specify one with --session (see above).");
    }
}
