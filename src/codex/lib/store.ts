import { existsSync, readFileSync } from "node:fs";
import { parseJsonl } from "@genesiscz/utils/jsonl";
import { JsonlWriter } from "@genesiscz/utils/log-session/jsonl-writer";
import { logger } from "@genesiscz/utils/logger";
import { WorkerMetaStore } from "@genesiscz/utils/worker/meta-store";
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
    accountId?: string;
    accountName?: string;
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

function isNonEmpty(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

/**
 * The first field that would make the record unusable, or null.
 *
 * Deliberately shorter than the grok and claude lists: a codex session is driven through its
 * daemon, so `cwd` and the name are the only two fields every verb needs before it can talk to
 * it. Anything stricter would hide a live session whose daemon is the authority on its state.
 */
function firstInvalidField(meta: Partial<CodexSessionMeta> | null | undefined): string | null {
    if (!isNonEmpty(meta?.name)) {
        return "name";
    }

    if (!isNonEmpty(meta?.cwd)) {
        return "cwd";
    }

    return null;
}

/**
 * This was a third hand-written copy of the shared store, and in copying it lost `createMeta`'s
 * O_EXCL claim: two concurrent spawns of one name both saw the name as free, both started a
 * daemon, and the second overwrote the first's record, leaving the first daemon's pid
 * unreachable. The event log on top is a genuine codex need, not drift, so it stays here.
 */
export class CodexSessionStore extends WorkerMetaStore<CodexSessionMeta> {
    private readonly lastEventSeq = new Map<string, number>();

    constructor() {
        super({
            dir: sessionsDir,
            metaPath: sessionMetaPath,
            firstInvalidField,
            label: "codex session",
            title: "Codex session",
            existsMessage: (name) =>
                `Codex session '${name}' already exists. Use 'tools codex steer --name ${name}' or pick a new name.`,
            log,
        });
    }

    /** Kept for callers that predate the shared store. */
    ensureSessionsDir(): string {
        return this.ensureDir();
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
