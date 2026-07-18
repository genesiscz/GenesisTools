import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { parseJsonl } from "@app/utils/jsonl";
import { JsonlWriter } from "@app/utils/log-session/jsonl-writer";
import { atomicWriteFileSync } from "@app/utils/storage/storage";
import { sessionEventsPath, sessionMetaPath, sessionsDir } from "./paths";

const log = logger.child({ component: "codex:store" });

export type CodexWritePolicy = "ask" | "allow" | "deny";
export type CodexSandbox = "read-only" | "workspace-write";
export type CodexApprovalPolicy = "never" | "untrusted";
export type PersistedCodexStatus = "starting" | "ready" | "running" | "closed" | "failed";
export type CodexStatus = PersistedCodexStatus | "stalled";

export interface PendingApproval {
    rpcId: string | number;
    method: string;
    detail: string;
    requestedAt: string;
}

export interface CodexSessionMeta {
    name: string;
    daemonPid: number;
    appServerPid?: number;
    threadId?: string;
    activeTurnId?: string;
    cwd: string;
    home?: string;
    model?: string;
    effort?: string;
    sandbox: CodexSandbox;
    approvalPolicy: CodexApprovalPolicy;
    writePolicy: CodexWritePolicy;
    status: PersistedCodexStatus;
    agentName: string;
    agentId?: string;
    rendezvousSession: string;
    agentsEnabled: boolean;
    startedAt: string;
    lastEventAt: string;
    codexVersion: string;
    exitCode?: number;
    usage?: Record<string, number>;
    pendingApprovals: Record<string, PendingApproval>;
    queuedSteers?: Array<{ body: string; force: boolean }>;
    lastAgentSeq?: number;
}

export interface CodexEventRecord {
    seq: number;
    ts: string;
    source: "app-server" | "control" | "agents" | "daemon";
    method: string;
    params?: unknown;
}

export function deriveSessionStatus(meta: CodexSessionMeta, now = Date.now(), stallMs = 120_000): CodexStatus {
    if (meta.status !== "running") {
        return meta.status;
    }

    const lastEventAt = Date.parse(meta.lastEventAt);
    if (Number.isFinite(lastEventAt) && now - lastEventAt > stallMs) {
        return "stalled";
    }

    return "running";
}

export class CodexSessionStore {
    private readonly lastEventSeq = new Map<string, number>();

    ensureSessionsDir(): string {
        const path = sessionsDir();
        mkdirSync(path, { recursive: true });
        return path;
    }

    async readMeta(name: string): Promise<CodexSessionMeta | null> {
        const path = sessionMetaPath(name);
        if (!existsSync(path)) {
            return null;
        }

        try {
            return SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as CodexSessionMeta;
        } catch (err) {
            log.warn({ err, path, name }, "failed to read codex session metadata");
            return null;
        }
    }

    writeMeta(meta: CodexSessionMeta): void {
        this.ensureSessionsDir();
        atomicWriteFileSync(sessionMetaPath(meta.name), SafeJSON.stringify(meta, null, 2));
    }

    async updateMeta(name: string, update: Partial<CodexSessionMeta>): Promise<CodexSessionMeta> {
        const current = await this.readMeta(name);
        if (!current) {
            throw new Error(`Codex session not found: ${name}`);
        }

        const next = { ...current, ...update };
        this.writeMeta(next);
        return next;
    }

    async listNames(): Promise<string[]> {
        const dir = this.ensureSessionsDir();
        return readdirSync(dir)
            .filter((file) => file.endsWith(".meta.json"))
            .map((file) => file.slice(0, -".meta.json".length))
            .sort();
    }

    appendEvent(name: string, event: Omit<CodexEventRecord, "seq" | "ts">): CodexEventRecord {
        this.ensureSessionsDir();
        const path = sessionEventsPath(name);
        let previousSeq = this.lastEventSeq.get(name);

        if (previousSeq === undefined && existsSync(path)) {
            const text = readFileSync(path, "utf8");
            const records = text.trim() ? parseJsonl<CodexEventRecord>(text) : [];
            previousSeq = records.at(-1)?.seq ?? 0;
        }

        const record: CodexEventRecord = {
            ...event,
            seq: (previousSeq ?? 0) + 1,
            ts: new Date().toISOString(),
        };
        new JsonlWriter(path).append({ ...record });
        this.lastEventSeq.set(name, record.seq);
        return record;
    }

    async readEvents(name: string): Promise<CodexEventRecord[]> {
        const path = sessionEventsPath(name);
        if (!existsSync(path)) {
            return [];
        }

        const text = await Bun.file(path).text();
        return text.trim() ? parseJsonl<CodexEventRecord>(text) : [];
    }
}
