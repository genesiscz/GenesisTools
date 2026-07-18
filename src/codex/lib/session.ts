import { logger } from "@genesiscz/utils/logger";
import type {
    InitializeParams,
    ReviewStartParams,
    ReviewTarget,
    ThreadReadParams,
    ThreadRollbackParams,
    ThreadStartParams,
    ThreadUnsubscribeParams,
    TurnInterruptParams,
    TurnStartParams,
} from "./_generated/protocol";
import type { RpcNotification, RpcServerRequest } from "./app-server-client";
import type { CodexControl } from "./control";
import { buildAgentInstructions } from "./seed-instructions";
import type { CodexSessionMeta, CodexSessionStore } from "./store";

const log = logger.child({ component: "codex:session" });

export interface RpcClient {
    request<T>(method: string, params?: unknown): Promise<T>;
    notify(method: string, params?: unknown): Promise<void>;
    close(): Promise<void>;
}

interface RuntimeOptions {
    client: RpcClient;
    store: CodexSessionStore;
    meta: CodexSessionMeta;
    onApprovalRequest?: (notice: Record<string, unknown>) => void | Promise<void>;
}

interface ThreadStartResult {
    thread: { id: string };
}

interface TurnStartResult {
    turn: { id: string };
}

interface ReviewStartResult {
    turn: { id: string };
    reviewThreadId: string;
}

interface PendingApprovalDecision {
    method: string;
    resolve: (response: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | null {
    if (!isRecord(value)) {
        return null;
    }

    const nested = value[key];
    return isRecord(nested) ? nested : null;
}

function turnIdFromParams(params: unknown): string | undefined {
    const turn = nestedRecord(params, "turn");
    return typeof turn?.id === "string" ? turn.id : undefined;
}

function usageFromParams(params: unknown): Record<string, number> | undefined {
    const tokenUsage = nestedRecord(params, "tokenUsage");
    const total = nestedRecord(tokenUsage, "total");
    if (!total) {
        return undefined;
    }

    const usage: Record<string, number> = {};
    for (const [key, value] of Object.entries(total)) {
        if (typeof value === "number") {
            usage[key] = value;
        }
    }

    return usage;
}

export class CodexSessionRuntime {
    private readonly client: RpcClient;
    private readonly store: CodexSessionStore;
    private meta: CodexSessionMeta;
    private readonly onApprovalRequest: RuntimeOptions["onApprovalRequest"];
    private readonly pendingApprovalDecisions = new Map<string, PendingApprovalDecision>();

    constructor(options: RuntimeOptions) {
        this.client = options.client;
        this.store = options.store;
        this.meta = options.meta;
        this.onApprovalRequest = options.onApprovalRequest;
    }

    async start(options: { prompt?: string }): Promise<void> {
        this.store.appendEvent(this.meta.name, { source: "daemon", method: "daemon/started" });

        const initialize: InitializeParams = {
            clientInfo: {
                name: "genesis-tools-codex",
                title: "GenesisTools Codex",
                version: "0.1.0",
            },
            capabilities: null,
        };
        await this.client.request("initialize", initialize);
        await this.client.notify("initialized");

        const threadParams: ThreadStartParams = {
            cwd: this.meta.cwd,
            sandbox: this.meta.sandbox,
            approvalPolicy: this.meta.approvalPolicy,
            ...(this.meta.model ? { model: this.meta.model } : {}),
            ...(this.meta.agentsEnabled
                ? {
                      developerInstructions: buildAgentInstructions({
                          agentName: this.meta.agentName,
                          rendezvousSession: this.meta.rendezvousSession,
                          leadName: "lead",
                      }),
                  }
                : {}),
        };
        const thread = await this.client.request<ThreadStartResult>("thread/start", threadParams);
        await this.updateMeta({ threadId: thread.thread.id, status: "ready" });

        if (options.prompt) {
            await this.startTurn(options.prompt);
        }
    }

    async startTurn(body: string): Promise<string> {
        if (!this.meta.threadId) {
            throw new Error("Codex thread is not initialized");
        }

        const params: TurnStartParams = {
            threadId: this.meta.threadId,
            input: [{ type: "text", text: body, text_elements: [] }],
            ...(this.meta.model ? { model: this.meta.model } : {}),
            ...(this.meta.effort ? { effort: this.meta.effort as TurnStartParams["effort"] } : {}),
        };
        const result = await this.client.request<TurnStartResult>("turn/start", params);
        await this.updateMeta({ activeTurnId: result.turn.id, status: "running" });
        return result.turn.id;
    }

    async handleNotification(notification: RpcNotification): Promise<void> {
        this.store.appendEvent(this.meta.name, {
            source: "app-server",
            method: notification.method,
            params: notification.params,
        });

        const lastEventAt = new Date().toISOString();

        if (notification.method === "turn/started") {
            await this.updateMeta({
                activeTurnId: turnIdFromParams(notification.params),
                status: "running",
                lastEventAt,
            });
            return;
        }

        if (notification.method === "turn/completed") {
            await this.updateMeta({ activeTurnId: undefined, status: "ready", lastEventAt });
            await this.deliverQueuedSteer();
            return;
        }

        if (notification.method === "turn/failed") {
            await this.updateMeta({ activeTurnId: undefined, status: "ready", lastEventAt });
            return;
        }

        if (notification.method === "thread/tokenUsage/updated") {
            await this.updateMeta({ usage: usageFromParams(notification.params), lastEventAt });
            return;
        }

        await this.updateMeta({ lastEventAt });
    }

    async execute(control: CodexControl): Promise<unknown> {
        switch (control.op) {
            case "steer":
                return this.steer(control.body, control.force);
            case "interrupt":
                return this.interrupt();
            case "rollback":
                return this.rollback(control.turns);
            case "read":
                return this.read();
            case "review":
                return this.review(control);
            case "approve":
            case "deny":
                return this.resolveApproval(control.requestId, control.op === "approve");
            case "stop":
                throw new Error(`Control op ${control.op} is not available in this runtime phase`);
        }
    }

    async handleServerRequest(request: RpcServerRequest): Promise<unknown> {
        if (!isApprovalMethod(request.method)) {
            throw new Error(`Unsupported Codex server request: ${request.method}`);
        }

        if (this.meta.writePolicy === "allow") {
            return approvalResponse(request.method, true);
        }

        if (this.meta.writePolicy === "deny") {
            return approvalResponse(request.method, false);
        }

        const requestId = String(request.id);
        const pendingApprovals = {
            ...this.meta.pendingApprovals,
            [requestId]: {
                rpcId: request.id,
                method: request.method,
                detail: approvalDetail(request.params),
                requestedAt: new Date().toISOString(),
            },
        };
        await this.updateMeta({ pendingApprovals });

        const response = new Promise<unknown>((resolve) => {
            this.pendingApprovalDecisions.set(requestId, { method: request.method, resolve });
        });
        await this.onApprovalRequest?.({
            event: "approval_request",
            op: "approval_request",
            requestId,
            method: request.method,
            detail: approvalDetail(request.params),
        });
        return response;
    }

    async close(): Promise<void> {
        for (const pending of this.pendingApprovalDecisions.values()) {
            pending.resolve(approvalResponse(pending.method, false));
        }
        this.pendingApprovalDecisions.clear();

        if (this.meta.threadId) {
            const params: ThreadUnsubscribeParams = { threadId: this.meta.threadId };
            try {
                await this.client.request("thread/unsubscribe", params);
            } catch (err) {
                log.debug({ err, threadId: this.meta.threadId }, "thread unsubscribe failed during close");
                // The child may already be gone; close still needs to release local resources.
            }
        }

        await this.client.close();
        await this.updateMeta({
            activeTurnId: undefined,
            status: "closed",
            lastEventAt: new Date().toISOString(),
            pendingApprovals: {},
        });
    }

    private async updateMeta(update: Partial<CodexSessionMeta>): Promise<void> {
        this.meta = await this.store.updateMeta(this.meta.name, update);
    }

    private threadId(): string {
        if (!this.meta.threadId) {
            throw new Error("Codex thread is not initialized");
        }

        return this.meta.threadId;
    }

    private async steer(body: string, force: boolean): Promise<{ turnId?: string; queued: boolean }> {
        try {
            const turnId = await this.startTurn(body);
            return { turnId, queued: false };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!/same-turn steer|same-turn steering|cannot accept/i.test(message)) {
                throw err;
            }

            if (force) {
                await this.interrupt();
                const turnId = await this.startTurn(body);
                return { turnId, queued: false };
            }

            const queuedSteers = [...(this.meta.queuedSteers ?? []), { body, force: false }];
            await this.updateMeta({ queuedSteers });
            return { queued: true };
        }
    }

    private async interrupt(): Promise<{ interrupted: boolean }> {
        if (!this.meta.activeTurnId) {
            return { interrupted: false };
        }

        const params: TurnInterruptParams = {
            threadId: this.threadId(),
            turnId: this.meta.activeTurnId,
        };
        await this.client.request("turn/interrupt", params);
        return { interrupted: true };
    }

    private async rollback(turns: number): Promise<{ rolledBack: number }> {
        const params: ThreadRollbackParams = { threadId: this.threadId(), numTurns: turns };
        await this.client.request("thread/rollback", params);
        return { rolledBack: turns };
    }

    private async read(): Promise<unknown> {
        const params: ThreadReadParams = { threadId: this.threadId(), includeTurns: true };
        return this.client.request("thread/read", params);
    }

    private async deliverQueuedSteer(): Promise<void> {
        const [next, ...rest] = this.meta.queuedSteers ?? [];
        if (!next) {
            return;
        }

        await this.startTurn(next.body);
        await this.updateMeta({ queuedSteers: rest });
    }

    private async review(control: Extract<CodexControl, { op: "review" }>): Promise<unknown> {
        if (control.adversarial) {
            const focus = control.adversarial.length > 0 ? control.adversarial.join(", ") : "all material risks";
            const target = control.base ? `changes against ${control.base}` : "the current working tree";
            return this.startTurn(buildAdversarialReviewPrompt({ target, focus }));
        }

        const target = reviewTarget(control);
        const params: ReviewStartParams = { threadId: this.threadId(), target };
        const result = await this.client.request<ReviewStartResult>("review/start", params);
        await this.updateMeta({ activeTurnId: result.turn.id, status: "running" });
        return { turnId: result.turn.id, reviewThreadId: result.reviewThreadId };
    }

    private async resolveApproval(requestId: string, approved: boolean): Promise<{ resolved: boolean }> {
        const pending = this.pendingApprovalDecisions.get(requestId);
        if (!pending) {
            throw new Error(`Pending approval not found: ${requestId}`);
        }

        this.pendingApprovalDecisions.delete(requestId);
        const pendingApprovals = { ...this.meta.pendingApprovals };
        delete pendingApprovals[requestId];
        await this.updateMeta({ pendingApprovals });
        pending.resolve(approvalResponse(pending.method, approved));
        return { resolved: true };
    }
}

function isApprovalMethod(method: string): boolean {
    return (
        method === "item/commandExecution/requestApproval" ||
        method === "item/fileChange/requestApproval" ||
        method === "applyPatchApproval" ||
        method === "execCommandApproval"
    );
}

function approvalResponse(method: string, approved: boolean): { decision: string } {
    if (method === "applyPatchApproval" || method === "execCommandApproval") {
        return { decision: approved ? "approved" : "denied" };
    }

    return { decision: approved ? "accept" : "decline" };
}

function approvalDetail(params: unknown): string {
    if (!isRecord(params)) {
        return "Codex requested approval";
    }

    for (const key of ["reason", "command", "grantRoot", "itemId"]) {
        if (typeof params[key] === "string" && params[key]) {
            return params[key];
        }
    }

    return "Codex requested approval";
}

function reviewTarget(control: Extract<CodexControl, { op: "review" }>): ReviewTarget {
    if (control.scope === "branch") {
        if (!control.base) {
            throw new Error("--base is required for --scope branch");
        }

        return { type: "baseBranch", branch: control.base };
    }

    if (control.base && control.scope !== "working-tree") {
        return { type: "baseBranch", branch: control.base };
    }

    return { type: "uncommittedChanges" };
}

function buildAdversarialReviewPrompt(options: { target: string; focus: string }): string {
    return `<role>
You are Codex performing an adversarial software review. Your job is to break confidence in the change, not validate it.
</role>

<task>
Review ${options.target}. User focus: ${options.focus}.
</task>

Default to skepticism. Prioritize auth and trust boundaries, data loss, rollback and retry safety, races, stale state,
timeouts, schema drift, and observability gaps. Actively try to disprove the change. Report only material, grounded,
actionable findings tied to concrete files and lines. Prefer one strong finding over several weak ones.`;
}
