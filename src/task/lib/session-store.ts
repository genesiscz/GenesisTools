import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { suggestCommand } from "@app/utils/cli/executor";
import { SafeJSON } from "@app/utils/json";
import { fuzzyResolveSession } from "@app/utils/log-session/fuzzy-resolver";
import { readJsonlFile } from "@app/utils/log-session/jsonl-reader";
import type { JsonlExitRecord } from "@app/utils/log-session/types";
import { Storage } from "@app/utils/storage/storage";
import type { MarkExitedInput, PrepareSessionInput, TaskConfig, TaskSessionMeta } from "../types";
import { jsonlPath, metaPath, TASK_SESSIONS_DIR } from "./paths";
import { buildTimestampedSessionName } from "./session-name";
import { isProcessAlive } from "./process-alive";

export type { ResolvedRunSession } from "../types";
import type { ResolvedRunSession } from "../types";

const TOOL_NAME = "tools task";
export const ACTIVE_THRESHOLD_MS = 60 * 60 * 1000;

export class TaskSessionStore {
    private storage = new Storage("task");

    async getSessionsDir(): Promise<string> {
        if (!existsSync(TASK_SESSIONS_DIR)) {
            mkdirSync(TASK_SESSIONS_DIR, { recursive: true });
        }

        return TASK_SESSIONS_DIR;
    }

    async loadConfig(): Promise<TaskConfig> {
        return (await this.storage.getConfig<TaskConfig>()) ?? {};
    }

    async saveConfig(config: TaskConfig): Promise<void> {
        await this.storage.ensureDirs();
        await Bun.write(this.storage.getConfigPath(), SafeJSON.stringify(config, null, 2));
    }

    async setRecentSession(name: string): Promise<void> {
        const config = await this.loadConfig();
        config.recentSession = name;
        await this.saveConfig(config);
    }

    async listSessionNames(): Promise<string[]> {
        await this.getSessionsDir();
        const files = readdirSync(TASK_SESSIONS_DIR);
        return files.filter((f) => f.endsWith(".jsonl")).map((f) => basename(f, ".jsonl"));
    }

    async getSessionMeta(name: string): Promise<TaskSessionMeta | null> {
        const path = metaPath(name);
        if (!existsSync(path)) {
            return null;
        }

        try {
            return (await Bun.file(path).json()) as TaskSessionMeta;
        } catch {
            return null;
        }
    }

    async writeSessionMeta(meta: TaskSessionMeta): Promise<void> {
        await Bun.write(metaPath(meta.name), SafeJSON.stringify(meta, null, "\t"));
    }

    async touchSession(name: string): Promise<void> {
        const meta = await this.getSessionMeta(name);
        if (!meta) {
            return;
        }

        meta.lastActivityAt = Date.now();
        await this.writeSessionMeta(meta);
    }

    sessionFilesExist(name: string): boolean {
        return existsSync(jsonlPath(name));
    }

    async resolveRunSessionName(requested: string): Promise<ResolvedRunSession> {
        await this.getSessionsDir();

        if (!this.sessionFilesExist(requested)) {
            return { session: requested, requested, renamed: false };
        }

        let session = buildTimestampedSessionName(requested);
        while (this.sessionFilesExist(session)) {
            session = buildTimestampedSessionName(requested, new Date(), true);
        }

        return { session, requested, renamed: true };
    }

    async listRelatedSessionNames(name: string, requestedAs?: string): Promise<string[]> {
        const base = requestedAs ?? name;
        const names = await this.listSessionNames();

        return names.filter((candidate) => candidate === base || candidate.startsWith(`${base}-`)).sort();
    }

    async reconcileSessionState(name: string): Promise<TaskSessionMeta | null> {
        let meta = await this.getSessionMeta(name);

        if (!meta || meta.exitCode !== undefined) {
            return meta;
        }

        const records = await readJsonlFile(jsonlPath(name));
        const exit = records.find(
            (record): record is JsonlExitRecord =>
                record.type === "exit" && typeof (record as JsonlExitRecord).code === "number"
        );

        if (exit) {
            await this.markExited({ name, exitCode: exit.code, durationMs: exit.durationMs });
            return this.getSessionMeta(name);
        }

        if (meta.pid !== undefined && !isProcessAlive(meta.pid)) {
            const durationMs = Date.now() - meta.createdAt;
            await this.markExited({ name, exitCode: 130, durationMs });
            return this.getSessionMeta(name);
        }

        return meta;
    }

    async prepareSession(input: PrepareSessionInput): Promise<void> {
        await this.getSessionsDir();
        const now = Date.now();

        const meta: TaskSessionMeta = {
            name: input.name,
            requestedAs: input.requestedAs,
            command: input.command,
            mode: input.mode,
            cwd: input.cwd,
            createdAt: now,
            lastActivityAt: now,
            startedAt: new Date(now).toISOString(),
        };

        await this.writeSessionMeta(meta);
        await this.setRecentSession(input.name);
    }

    async markExited(input: MarkExitedInput): Promise<void> {
        const meta = await this.getSessionMeta(input.name);
        if (!meta) {
            return;
        }

        meta.exitCode = input.exitCode;
        meta.durationMs = input.durationMs;
        meta.exitedAt = new Date().toISOString();
        meta.lastActivityAt = Date.now();
        await this.writeSessionMeta(meta);
    }

    async updatePid(name: string, pid: number): Promise<void> {
        const meta = await this.getSessionMeta(name);
        if (!meta) {
            return;
        }

        meta.pid = pid;
        await this.writeSessionMeta(meta);
    }

    async getActiveSessions(): Promise<TaskSessionMeta[]> {
        const names = await this.listSessionNames();
        const now = Date.now();
        const active: TaskSessionMeta[] = [];

        for (const name of names) {
            const meta = await this.reconcileSessionState(name);
            if (meta && meta.exitCode === undefined && now - meta.lastActivityAt < ACTIVE_THRESHOLD_MS) {
                active.push(meta);
            }
        }

        return active;
    }

    async resolveSession(sessionFlag?: string): Promise<string> {
        const names = await this.listSessionNames();

        if (sessionFlag) {
            const resolved = fuzzyResolveSession(sessionFlag, names, {
                toolHint: TOOL_NAME,
                startHint: `${TOOL_NAME} run --session ${sessionFlag} -- <cmd>`,
            });
            await this.setRecentSession(resolved);
            return resolved;
        }

        const config = await this.loadConfig();
        if (config.recentSession && names.includes(config.recentSession)) {
            const meta = await this.reconcileSessionState(config.recentSession);
            if (meta && meta.exitCode === undefined && Date.now() - meta.lastActivityAt < ACTIVE_THRESHOLD_MS) {
                return config.recentSession;
            }
        }

        const activeSessions = await this.getActiveSessions();

        if (activeSessions.length === 1) {
            const name = activeSessions[0].name;
            await this.setRecentSession(name);
            return name;
        }

        if (activeSessions.length > 1) {
            const suggestions = activeSessions
                .map((s) => `  ${suggestCommand(TOOL_NAME, { add: ["get", "--session", s.name] })}`)
                .join("\n");
            throw new Error(`Multiple active sessions found. Specify one with --session:\n${suggestions}`);
        }

        throw new Error(`No active sessions. Start one with:\n  ${TOOL_NAME} run --session <name> -- <cmd>`);
    }

    async deleteSession(name: string): Promise<void> {
        const paths = [
            join(TASK_SESSIONS_DIR, `${name}.jsonl`),
            join(TASK_SESSIONS_DIR, `${name}.log`),
            join(TASK_SESSIONS_DIR, `${name}.err.log`),
            metaPath(name),
        ];

        for (const path of paths) {
            if (existsSync(path)) {
                unlinkSync(path);
            }
        }
    }

    async getSessionFileSize(path: string): Promise<number> {
        if (!existsSync(path)) {
            return 0;
        }

        return statSync(path).size;
    }
}
