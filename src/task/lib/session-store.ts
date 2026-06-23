import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { logger } from "@app/logger";
import {
    getTaskSessionsDir,
    jsonlPath,
    metaPath,
    sessionFilePaths,
    sessionNameFromJsonlFilename,
    uiJsonlPath,
} from "@app/task/lib/paths";
import { isProcessAlive } from "@app/task/lib/process-alive";
import { buildTimestampedSessionName, isRelatedSessionName } from "@app/task/lib/session-name";
import type {
    MarkExitedInput,
    PrepareSessionInput,
    ResolvedRunSession,
    TaskConfig,
    TaskSessionMeta,
} from "@app/task/types";
import { suggestCommand } from "@app/utils/cli/executor";
import { SafeJSON } from "@app/utils/json";
import { fuzzyResolveSession } from "@app/utils/log-session/fuzzy-resolver";
import { filterLineRecords, readJsonlFile } from "@app/utils/log-session/jsonl-reader";
import type { JsonlExitRecord, JsonlLineRecord, JsonlMetaRecord } from "@app/utils/log-session/types";
import { atomicWriteFileSync, Storage } from "@app/utils/storage/storage";

export type { ResolvedRunSession } from "@app/task/types";

const TOOL_NAME = "tools task";
export const ACTIVE_THRESHOLD_MS = 60 * 60 * 1000;

export class TaskSessionStore {
    private storage = new Storage("task");

    async getSessionsDir(): Promise<string> {
        const sessionsDir = getTaskSessionsDir();
        if (!existsSync(sessionsDir)) {
            mkdirSync(sessionsDir, { recursive: true });
        }

        return sessionsDir;
    }

    async loadConfig(): Promise<TaskConfig> {
        return (await this.storage.getConfig<TaskConfig>()) ?? {};
    }

    async setRecentSession(name: string): Promise<void> {
        await this.storage.atomicConfigUpdate<TaskConfig>((config) => {
            config.recentSession = name;
        });
    }

    async listSessionNames(): Promise<string[]> {
        const sessionsDir = await this.getSessionsDir();
        const files = readdirSync(sessionsDir);
        const names: string[] = [];

        for (const file of files) {
            const name = sessionNameFromJsonlFilename(file);

            if (name) {
                names.push(name);
            }
        }

        return names;
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

    writeSessionMeta(meta: TaskSessionMeta): void {
        atomicWriteFileSync(metaPath(meta.name), SafeJSON.stringify(meta, null, "\t"));
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

    async getLastLineSeq(name: string): Promise<number> {
        const path = jsonlPath(name);

        if (!existsSync(path)) {
            return 0;
        }

        // Read just the tail. The writer appends line records with monotonic
        // seq, so the last line in the file carries the max. Reading the whole
        // file would be O(file size) — Metro/Vite sessions can be gigabytes.
        const file = Bun.file(path);
        const tailStart = Math.max(0, file.size - 64 * 1024);
        const tail = await file.slice(tailStart).text();
        const lines = tail.split("\n");

        // Drop first row only when slice truly starts mid-line.
        if (tailStart > 0) {
            const prevChar = await file.slice(tailStart - 1, tailStart).text();

            if (prevChar !== "\n") {
                lines.shift();
            }
        }

        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();

            if (!line) {
                continue;
            }

            try {
                const record = SafeJSON.parse(line, { strict: true }) as JsonlLineRecord | null;

                if (record?.type === "line" && typeof record.seq === "number") {
                    return record.seq;
                }
            } catch (err) {
                logger.debug(
                    { err, path, tailStart, lineIndex: i },
                    "TaskSessionStore.getLastLineSeq skipped unparsable JSONL tail line"
                );
            }
        }

        const records = await readJsonlFile(path);

        for (let i = records.length - 1; i >= 0; i--) {
            const record = records[i];

            if (record.type === "line" && typeof (record as JsonlLineRecord).seq === "number") {
                return (record as JsonlLineRecord).seq;
            }
        }

        return 0;
    }

    async clearSessionLogs(name: string): Promise<void> {
        await this.getSessionsDir();
        const paths = sessionFilePaths(name);

        writeFileSync(paths.jsonl, "");
        writeFileSync(paths.uiJsonl, "");
        writeFileSync(paths.stdout, "");
        writeFileSync(paths.stderr, "");

        if (existsSync(paths.meta)) {
            unlinkSync(paths.meta);
        }
    }

    async prepareSessionReuseContinue(input: PrepareSessionInput): Promise<void> {
        await this.getSessionsDir();
        const path = jsonlPath(input.name);
        const records = await readJsonlFile(path);
        const kept = records.filter((record) => record.type !== "exit");
        const body = kept.map((record) => SafeJSON.stringify(record)).join("\n");

        atomicWriteFileSync(path, body ? `${body}\n` : "");

        const now = Date.now();
        const existing = await this.getSessionMeta(input.name);

        const meta: TaskSessionMeta = {
            name: input.name,
            requestedAs: input.requestedAs ?? existing?.requestedAs,
            command: input.command,
            mode: input.mode,
            cwd: input.cwd,
            createdAt: existing?.createdAt ?? now,
            lastActivityAt: now,
            startedAt: existing?.startedAt ?? new Date(now).toISOString(),
        };

        this.writeSessionMeta(meta);
        await this.setRecentSession(input.name);
    }

    async clearOlderThanSeq(name: string, seq: number): Promise<number> {
        await this.getSessionsDir();

        const canonicalPath = jsonlPath(name);
        const uiPath = uiJsonlPath(name);
        const records = await readJsonlFile(canonicalPath);
        const linesBefore = filterLineRecords(records).length;
        const kept = records.filter((record) => {
            if (record.type !== "line") {
                return true;
            }

            return (record as JsonlLineRecord).seq > seq;
        });
        const linesAfter = filterLineRecords(kept).length;
        const body = kept.map((record) => SafeJSON.stringify(record)).join("\n");

        atomicWriteFileSync(canonicalPath, body ? `${body}\n` : "");

        if (existsSync(uiPath)) {
            const uiRecords = await readJsonlFile(uiPath);
            const keptUi = uiRecords.filter((record) => {
                if (record.type !== "line") {
                    return true;
                }

                return (record as JsonlLineRecord).seq > seq;
            });
            const uiBody = keptUi.map((record) => SafeJSON.stringify(record)).join("\n");
            atomicWriteFileSync(uiPath, uiBody ? `${uiBody}\n` : "");
        }

        return linesBefore - linesAfter;
    }

    async resolveRunSessionName(requested: string): Promise<ResolvedRunSession> {
        await this.getSessionsDir();

        if (!this.sessionFilesExist(requested)) {
            return { session: requested, requested, renamed: false };
        }

        let session = buildTimestampedSessionName(requested);
        while (this.sessionFilesExist(session)) {
            await Bun.sleep(1100);
            session = buildTimestampedSessionName(requested);
        }

        return { session, requested, renamed: true };
    }

    async listRelatedSessionNames(name: string, requestedAs?: string): Promise<string[]> {
        const base = requestedAs ?? name;
        const names = await this.listSessionNames();

        return names.filter((candidate) => isRelatedSessionName(base, candidate)).sort();
    }

    private metaFromJsonl(name: string, records: Awaited<ReturnType<typeof readJsonlFile>>): TaskSessionMeta | null {
        const metaRecord = records.find((record): record is JsonlMetaRecord => record.type === "meta");
        const exitRecord = records.find(
            (record): record is JsonlExitRecord =>
                record.type === "exit" && typeof (record as JsonlExitRecord).code === "number"
        );

        if (!metaRecord && !exitRecord) {
            return null;
        }

        const now = Date.now();
        const startedAt = metaRecord?.startedAt ?? new Date(now).toISOString();

        return {
            name,
            command: metaRecord?.command ?? "(unknown)",
            mode: metaRecord?.mode ?? "pipe",
            cwd: metaRecord?.cwd ?? "(unknown)",
            createdAt: now,
            lastActivityAt: now,
            startedAt,
            pid: metaRecord?.pid,
            exitCode: exitRecord?.code,
            durationMs: exitRecord?.durationMs,
            exitedAt: exitRecord ? exitRecord.ts : undefined,
        };
    }

    async reconcileSessionState(name: string): Promise<TaskSessionMeta | null> {
        const meta = await this.getSessionMeta(name);

        if (meta?.exitCode !== undefined) {
            return meta;
        }

        const records = await readJsonlFile(jsonlPath(name));
        const exit = records.find(
            (record): record is JsonlExitRecord =>
                record.type === "exit" && typeof (record as JsonlExitRecord).code === "number"
        );

        if (exit) {
            if (meta) {
                await this.markExited({ name, exitCode: exit.code, durationMs: exit.durationMs });
                return this.getSessionMeta(name);
            }

            const synthesized = this.metaFromJsonl(name, records);
            if (synthesized) {
                await this.writeSessionMeta(synthesized);
                return synthesized;
            }
        }

        if (meta) {
            if (meta.pid !== undefined && !isProcessAlive(meta.pid)) {
                const durationMs = Date.now() - meta.createdAt;
                await this.markExited({ name, exitCode: 130, durationMs });
                return this.getSessionMeta(name);
            }

            return meta;
        }

        if (records.length > 0) {
            return this.metaFromJsonl(name, records);
        }

        return null;
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
        // Every path goes through safeSessionPath (via sessionFilePaths) so
        // a maliciously-named session — `..` traversal, embedded `/` — is
        // rejected before any unlink runs. The prior implementation used
        // bare path.join for 4 of 5 entries; safety relied on the array
        // literal evaluating metaPath() first and throwing. A future
        // refactor that reordered or removed it would silently unmask the
        // traversal.
        const paths = sessionFilePaths(name);
        for (const path of [paths.jsonl, paths.uiJsonl, paths.stdout, paths.stderr, paths.meta]) {
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
