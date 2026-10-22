import { relative } from "node:path";
import { formatCostLine } from "@app/ai-spend/lib/workers/cost";
import { recordWorkerTurnCost, type WorkerCostRow } from "@app/ai-spend/lib/workers/ledger";
import { withTimeout } from "@genesiscz/utils/async";
import { type CodexFinishedTurn, CodexTurnCostTracker } from "@genesiscz/utils/codex/turn-cost";
import { codexTurnOutcome } from "@genesiscz/utils/codex/turn-outcome";
import { logger } from "@genesiscz/utils/logger";
import { buildWorkerContract, type ReviewEffort } from "@genesiscz/utils/worker/contract";
import { WorkerDeliveryRejectedError, workerSourceHome } from "@genesiscz/utils/worker/delivery";
import type {
    InitializeParams,
    ReviewStartParams,
    ReviewTarget,
    ThreadReadParams,
    ThreadRevertParams,
    ThreadStartParams,
    ThreadTurnsListParams,
    ThreadTurnsListResponse,
    ThreadUnsubscribeParams,
    Turn,
    TurnInterruptParams,
    TurnStartParams,
} from "./_generated/protocol";
import type { CodexAccountBinding } from "./account";
import type { RpcNotification, RpcServerRequest } from "./app-server-client";
import { isOwnBusCommand, isReadOnlyCommand } from "./bus-approval";
import type { CodexControl } from "./control";
import { assignThreadToProject, type CodexProject, resolveProjectSelector } from "./desktop-project";
import { markReviewShallow, recordReviewTurn } from "./review/controller";
import { buildAgentInstructions, contractSandbox } from "./seed-instructions";
import type { CodexSessionMeta, CodexSessionStore } from "./store";

const log = logger.child({ component: "codex:session" });

export interface RpcClient {
    request<T>(method: string, params?: unknown): Promise<T>;
    notify(method: string, params?: unknown): Promise<void>;
    close(): Promise<void>;
}

interface RuntimeOptions {
    account?: CodexAccountBinding;
    client: RpcClient;
    store: CodexSessionStore;
    meta: CodexSessionMeta;
    onApprovalRequest?: (notice: Record<string, unknown>) => void | Promise<void>;
    unsubscribeTimeoutMs?: number;
    /** `tools codex spawn --project`: a Desktop project id, name or root. Without it the cwd decides. */
    project?: string;
    /** Starts the escalated review session the depth gate asked for; the daemon wires it to `spawnCodexSession`. */
    escalateReview?: (request: EscalateReviewRequest) => Promise<void>;
    /** Told about every gate decision, so the daemon can put it on the agents bus. */
    onReviewGate?: (event: Record<string, unknown>) => void | Promise<void>;
}

export interface EscalateReviewRequest {
    meta: CodexSessionMeta;
    effort: ReviewEffort;
    name: string;
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
    private readonly account?: CodexAccountBinding;
    private readonly client: RpcClient;
    private readonly store: CodexSessionStore;
    private meta: CodexSessionMeta;
    private readonly onApprovalRequest: RuntimeOptions["onApprovalRequest"];
    private readonly unsubscribeTimeoutMs: number;
    private readonly pendingApprovalDecisions = new Map<string, PendingApprovalDecision>();
    private readonly projectSelector?: string;
    private chosenProject?: CodexProject;
    private filingAttempts = 0;
    private readonly reviewThreadIds = new Set<string>();
    /** Paths of the file-change items in flight, by item id: their approval request carries only the id. */
    private readonly fileChangePaths = new Map<string, string[]>();
    /** Per-turn usage, tool calls and login, for the worker cost ledger. */
    private readonly costTracker: CodexTurnCostTracker;
    /** The cost line of the last booked turn, for the lead's `turn_completed` bus event. */
    private lastTurnCost: { turnId?: string; line: string } | null = null;
    /** The current turn's last agent message: a review's report, which the depth gate reads. */
    private turnMessage = "";
    private readonly escalateReview: RuntimeOptions["escalateReview"];
    private readonly onReviewGate: RuntimeOptions["onReviewGate"];

    constructor(options: RuntimeOptions) {
        this.account = options.account;
        this.client = options.client;
        this.store = options.store;
        this.meta = options.meta;
        this.onApprovalRequest = options.onApprovalRequest;
        this.unsubscribeTimeoutMs = options.unsubscribeTimeoutMs ?? 1000;
        this.projectSelector = options.project;
        this.escalateReview = options.escalateReview;
        this.onReviewGate = options.onReviewGate;
        // A pinned account is a ChatGPT login; `account/updated` confirms or corrects it.
        this.costTracker = new CodexTurnCostTracker({
            model: options.meta.model ?? null,
            auth: options.meta.accountName ? "subscription" : "unknown",
        });
    }

    async start(options: { prompt?: string }): Promise<void> {
        this.store.appendEvent(this.meta.name, { source: "daemon", method: "daemon/started" });

        const initialize: InitializeParams = {
            clientInfo: {
                name: "genesis-tools-codex",
                title: "GenesisTools Codex",
                version: "0.1.0",
            },
            // `project/list` and `thread/metadata/update` (filing the thread in Codex Desktop) are
            // experimental methods; without the capability they fail and the thread stays projectless.
            capabilities: { experimentalApi: true },
        };
        await this.client.request("initialize", initialize);
        await this.client.notify("initialized");
        await this.account?.authenticate(this.client);

        // Resolved before the thread starts, so a wrong --project fails the spawn the user is watching
        // instead of a filing attempt that only the daemon log would mention.
        if (this.projectSelector) {
            const projects = await this.client.request<{ data?: CodexProject[] }>("project/list", {});
            this.chosenProject = resolveProjectSelector(projects.data ?? [], this.projectSelector);
        }

        const review = this.meta.review
            ? { effort: this.meta.review.effort, manifest: this.meta.review.manifest }
            : null;
        const threadParams: ThreadStartParams = {
            cwd: this.meta.cwd,
            sandbox: this.meta.sandbox,
            approvalPolicy: this.meta.approvalPolicy,
            ...(this.meta.model ? { model: this.meta.model } : {}),
            // Every worker gets the shared contract (checkpoints, report shape); the bus identity and
            // commands only when the swarm is enabled; a reviewer its tier rules and the diff manifest.
            developerInstructions: this.meta.agentsEnabled
                ? buildAgentInstructions({
                      agentName: this.meta.agentName,
                      rendezvousSession: this.meta.rendezvousSession,
                      leadName: "lead",
                      sandbox: this.meta.sandbox,
                      review,
                  })
                : buildWorkerContract({
                      backend: "codex",
                      sandbox: contractSandbox(this.meta.sandbox),
                      review,
                  }),
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
            ...(this.meta.effort ? { effort: this.meta.effort } : {}),
        };
        const result = await this.client.request<TurnStartResult>("turn/start", params);
        // A review keeps its first prompt, so an escalated session can rerun the same review one tier higher.
        const review = this.meta.review && !this.meta.review.prompt ? { ...this.meta.review, prompt: body } : undefined;
        await this.updateMeta({ activeTurnId: result.turn.id, status: "running", ...(review ? { review } : {}) });
        return result.turn.id;
    }

    async handleNotification(notification: RpcNotification): Promise<void> {
        this.store.appendEvent(this.meta.name, {
            source: "app-server",
            method: notification.method,
            params: notification.params,
        });

        const lastEventAt = new Date().toISOString();

        // A native subagent runs its own thread in this app-server. Its turns are not this worker's:
        // counting them set activeTurnId to the subagent's turn, overwrote usage with its tokens, and would
        // report the worker "ready" when only the subagent finished (observed 2026-10-13).
        if (!this.isOwnThreadEvent(notification)) {
            await this.updateMeta({ lastEventAt });
            return;
        }

        await this.fileUnderProject(notification);
        this.trackFileChange(notification);

        this.trackAgentMessage(notification);
        const finished = this.costTracker.observe(notification, new Date());
        const booked = finished ? await this.bookTurnCost(finished) : null;

        if (notification.method === "turn/started") {
            await this.updateMeta({
                activeTurnId: turnIdFromParams(notification.params),
                status: "running",
                lastEventAt,
            });
            return;
        }

        const terminal = codexTurnOutcome(notification);
        if (terminal) {
            // A steered review keeps running: the session never reads as ready between the turn and its steer.
            if (finished && this.meta.review && (await this.gateReviewTurn(finished, booked))) {
                await this.updateMeta({ lastEventAt });
                return;
            }

            await this.updateMeta({ activeTurnId: undefined, status: "ready", lastEventAt });
            if (terminal.outcome !== "interrupted") {
                await this.deliverQueuedSteer();
            }
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
                if (
                    control.expectedTarget &&
                    (this.meta.threadId !== control.expectedTarget.threadId ||
                        !this.meta.home ||
                        workerSourceHome(this.meta.home) !== workerSourceHome(control.expectedTarget.home))
                ) {
                    throw new WorkerDeliveryRejectedError(
                        "The Codex thread or source home changed; no prompt was sent."
                    );
                }

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
        if (this.account && request.method === "account/chatgptAuthTokens/refresh") {
            const params = request.params;
            const previous =
                isRecord(params) && typeof params.previousAccountId === "string" ? params.previousAccountId : null;
            return this.account.refresh(previous);
        }

        if (!isApprovalMethod(request.method)) {
            throw new Error(`Unsupported Codex server request: ${request.method}`);
        }

        // `full` runs with approvalPolicy never like `allow`, so a request reaching here is one Codex sends anyway.
        if (this.meta.writePolicy === "allow" || this.meta.writePolicy === "full") {
            return approvalResponse(request.method, true);
        }

        if (this.meta.writePolicy === "deny") {
            return approvalResponse(request.method, false);
        }

        if (this.isOwnBusRequest(request)) {
            this.store.appendEvent(this.meta.name, {
                source: "daemon",
                method: "approval/auto-accepted",
                params: { reason: "the worker's own seeded bus command", detail: approvalDetail(request.params) },
            });
            return approvalResponse(request.method, true);
        }

        if (this.isReadOnlyRequest(request)) {
            this.store.appendEvent(this.meta.name, {
                source: "daemon",
                method: "approval/auto-accepted",
                params: { reason: "a read-only command", detail: approvalDetail(request.params) },
            });
            return approvalResponse(request.method, true);
        }

        const requestId = String(request.id);
        const detail = this.describeApproval(request);
        const params = isRecord(request.params) ? request.params : {};
        const commandRequest =
            request.method === "item/commandExecution/requestApproval" || request.method === "execCommandApproval";
        const pendingApprovals = {
            ...this.meta.pendingApprovals,
            [requestId]: {
                rpcId: request.id,
                method: request.method,
                detail,
                paths: this.approvalPaths(request),
                command: commandRequest && typeof params.command === "string" ? params.command : undefined,
                cwd: commandRequest && typeof params.cwd === "string" ? params.cwd : undefined,
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
            detail,
        });
        return response;
    }

    async close(): Promise<void> {
        for (const pending of this.pendingApprovalDecisions.values()) {
            pending.resolve(approvalResponse(pending.method, false));
        }
        this.pendingApprovalDecisions.clear();

        try {
            if (this.meta.threadId) {
                const params: ThreadUnsubscribeParams = { threadId: this.meta.threadId };
                await withTimeout(
                    this.client.request("thread/unsubscribe", params),
                    this.unsubscribeTimeoutMs,
                    new Error("Codex thread unsubscribe timed out")
                );
            }
        } catch (err) {
            log.debug({ err, threadId: this.meta.threadId }, "thread unsubscribe failed during close");
        } finally {
            await this.client.close();
        }
        await this.updateMeta({
            activeTurnId: undefined,
            status: "closed",
            lastEventAt: new Date().toISOString(),
            pendingApprovals: {},
        });
    }

    /** A command approval for this worker's own seeded `tools agents` command, from its own thread. */
    private isOwnBusRequest(request: RpcServerRequest): boolean {
        const command = isRecord(request.params) ? request.params.command : undefined;

        return (
            request.method === "item/commandExecution/requestApproval" &&
            this.meta.agentsEnabled &&
            typeof command === "string" &&
            this.isOwnThreadEvent(request) &&
            isOwnBusCommand(command, { agentName: this.meta.agentName, session: this.meta.rendezvousSession })
        );
    }

    /** A command approval, from this worker's own thread, for a command that only reads (`isReadOnlyCommand`). */
    private isReadOnlyRequest(request: RpcServerRequest): boolean {
        const command = isRecord(request.params) ? request.params.command : undefined;

        return (
            request.method === "item/commandExecution/requestApproval" &&
            typeof command === "string" &&
            this.isOwnThreadEvent(request) &&
            isReadOnlyCommand(command)
        );
    }

    /** Keeps a file-change item's paths from its start to its end, for the approval asked in between. */
    private trackFileChange(notification: RpcNotification): void {
        const item = isRecord(notification.params) ? notification.params.item : undefined;

        if (!isRecord(item) || item.type !== "fileChange" || typeof item.id !== "string") {
            return;
        }

        if (notification.method === "item/completed") {
            this.fileChangePaths.delete(item.id);
            return;
        }

        if (notification.method === "item/started" && Array.isArray(item.changes)) {
            const paths = item.changes.flatMap((change) =>
                isRecord(change) && typeof change.path === "string"
                    ? [relative(this.meta.cwd, change.path) || change.path]
                    : []
            );
            this.fileChangePaths.set(item.id, paths);
        }
    }

    private approvalPaths(request: RpcServerRequest): string[] | undefined {
        const params = isRecord(request.params) ? request.params : {};
        return request.method === "item/fileChange/requestApproval" && typeof params.itemId === "string"
            ? this.fileChangePaths.get(params.itemId)
            : undefined;
    }

    /** What the lead reads for an approval: a file change names the files it writes, not its item id. */
    private describeApproval(request: RpcServerRequest): string {
        const params = isRecord(request.params) ? request.params : {};
        const paths = this.approvalPaths(request);

        if (request.method === "item/fileChange/requestApproval" && paths && paths.length > 0) {
            const reason = typeof params.reason === "string" && params.reason ? ` (${params.reason})` : "";

            return `edit ${paths.join(", ")}${reason}`;
        }

        return approvalDetail(request.params);
    }

    /** False for a notification from another thread in this app-server: a native subagent's. */
    isOwnThreadEvent(notification: RpcNotification): boolean {
        const params = isRecord(notification.params) ? notification.params : {};
        const threadId =
            notification.method === "thread/started"
                ? (nestedRecord(params, "thread")?.id ?? params.threadId)
                : params.threadId;

        if (typeof threadId !== "string" || !this.meta.threadId) {
            return true;
        }

        return threadId === this.meta.threadId || this.reviewThreadIds.has(threadId);
    }

    /**
     * Put the thread under its Codex Desktop project, where Desktop's sidebar shows it. A thread is not in
     * `thread/list` until its first user message is recorded, so the first try waits for that item, and the
     * end of the first turn gets one more. Never fatal: a failed filing leaves a working thread unlisted.
     */
    private async fileUnderProject(notification: RpcNotification): Promise<void> {
        if (this.meta.desktopProject || this.filingAttempts >= 2 || !this.meta.threadId) {
            return;
        }

        const item = nestedRecord(notification.params, "item");
        const userMessageRecorded = notification.method === "item/completed" && item?.type === "userMessage";

        if (!userMessageRecorded && !codexTurnOutcome(notification)) {
            return;
        }

        this.filingAttempts += 1;

        try {
            const project = await withTimeout(
                assignThreadToProject(this.client, {
                    threadId: this.meta.threadId,
                    cwd: this.meta.cwd,
                    ...(this.chosenProject ? { project: this.chosenProject } : {}),
                }),
                5000,
                new Error("Codex Desktop project filing")
            );

            if (project) {
                await this.updateMeta({ desktopProject: { id: project.id, name: project.name } });
            }
        } catch (err) {
            log.warn({ err, threadId: this.meta.threadId }, "could not file the thread under a Codex Desktop project");
        }
    }

    /** The last agent message of the current turn, which a review's gate parses. */
    private trackAgentMessage(notification: RpcNotification): void {
        if (notification.method === "turn/started") {
            this.turnMessage = "";
            return;
        }

        const item = nestedRecord(notification.params, "item");

        if (
            notification.method === "item/completed" &&
            item?.type === "agentMessage" &&
            typeof item.text === "string"
        ) {
            this.turnMessage = item.text;
        }
    }

    /**
     * Runs the depth gate on a finished review turn and takes its step. True when the review continues in this
     * session (the steer started a turn). An escalation starts a new session and this one ends; a step the runtime
     * cannot take ends the review `shallow` with the reason.
     */
    private async gateReviewTurn(finished: CodexFinishedTurn, booked: WorkerCostRow | null): Promise<boolean> {
        const current = this.meta.review;

        if (!current) {
            return false;
        }

        const outcome = recordReviewTurn({
            name: this.meta.name,
            ...(this.meta.label ? { label: this.meta.label } : {}),
            review: current,
            finished,
            report: this.turnMessage,
            costUsd: booked?.cost.apiEquivalentUsd ?? null,
        });
        this.turnMessage = "";
        await this.updateMeta({ review: outcome.review });

        if (outcome.decision) {
            await this.publishReviewGate(outcome.review);
        }

        const action = outcome.action;

        try {
            if (action.kind === "steer") {
                await this.startTurn(action.text);
                return true;
            }

            if (action.kind === "escalate") {
                if (!this.escalateReview) {
                    throw new Error("this runtime has no way to start an escalated session");
                }

                await this.escalateReview({ meta: this.meta, effort: action.effort, name: action.name });
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warn({ err, name: this.meta.name, action: action.kind }, "review gate step failed");
            const review = markReviewShallow({
                name: this.meta.name,
                ...(this.meta.label ? { label: this.meta.label } : {}),
                review: outcome.review,
                reason: `${outcome.review.reason}; the ${action.kind} failed: ${message}`,
            });
            await this.updateMeta({ review });
            await this.publishReviewGate(review);
        }

        return false;
    }

    private async publishReviewGate(review: NonNullable<CodexSessionMeta["review"]>): Promise<void> {
        try {
            await this.onReviewGate?.({
                event: "review_gate",
                name: this.meta.name,
                verdict: review.verdict,
                reason: review.reason,
                step: review.step,
                ...(review.escalatedTo ? { escalatedTo: review.escalatedTo } : {}),
            });
        } catch (err) {
            log.warn({ err, name: this.meta.name }, "publishing the review gate decision failed");
        }
    }

    /** Never throws: `recordWorkerTurnCost` logs its own failure and the turn goes on without a cost line. */
    private async bookTurnCost(finished: CodexFinishedTurn): Promise<WorkerCostRow | null> {
        const row = await recordWorkerTurnCost({
            backend: "codex",
            name: this.meta.name,
            sessionId: this.meta.threadId ?? null,
            turn: finished.turn,
            model: finished.model ?? this.meta.model ?? null,
            effort: this.meta.effort ?? null,
            auth: finished.auth,
            account: this.meta.accountName ?? null,
            startedAt: finished.startedAt,
            endedAt: finished.endedAt,
            durationMs: finished.durationMs,
            toolCalls: finished.toolCalls,
            parts: finished.parts,
            cwd: this.meta.cwd,
            label: this.meta.label,
            outcome: finished.outcome,
        });

        this.lastTurnCost = row
            ? { ...(finished.turnId ? { turnId: finished.turnId } : {}), line: formatCostLine(row.cost, "codex") }
            : null;
        return row;
    }

    /** `{ cost }` for the bus event of the turn just booked; undefined for any other notification. */
    turnCostEnvelope(notification: RpcNotification): Record<string, unknown> | undefined {
        const terminal = codexTurnOutcome(notification);

        if (!terminal || !this.lastTurnCost || this.lastTurnCost.turnId !== terminal.turnId) {
            return undefined;
        }

        return { cost: this.lastTurnCost.line };
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

    private async steer(body: string, force: boolean): Promise<{ turnId?: string; queued: boolean; merged?: boolean }> {
        // codex 0.162.1 answers turn/start during an active turn by steering: the
        // input MERGES into that turn (verified live on 2026-10-13), so keep the
        // original active id in meta. A turn that takes no steering (a review or
        // compact turn) refuses instead; that input waits for the turn boundary.
        const activeBefore = this.meta.activeTurnId;

        try {
            const turnId = await this.startTurn(body);

            if (activeBefore) {
                await this.updateMeta({ activeTurnId: activeBefore });
                return { turnId, queued: false, merged: true };
            }

            return { turnId, queued: false };
        } catch (err) {
            if (!isNotSteerableRejection(err)) {
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

    /**
     * codex 0.162.1 has no `thread/rollback`; `thread/revert` drops one turn and every later turn from the persisted
     * history. It does not undo file changes. The server's own refusals (an ephemeral or non-paginated thread, a
     * thread with no user message yet) reach the caller unchanged.
     */
    private async rollback(turns: number): Promise<{ rolledBack: number }> {
        const threadId = this.threadId();
        const newest = await this.newestTurns(threadId, turns);
        const oldestDropped = newest[turns - 1];
        if (!oldestDropped) {
            throw new Error(`Cannot roll back ${turns} turn(s): the thread has only ${newest.length}.`);
        }

        const params: ThreadRevertParams = { threadId, beforeTurnId: oldestDropped.id };
        await this.client.request("thread/revert", params);
        return { rolledBack: turns };
    }

    /** Up to `count` turns of the thread, the newest first. */
    private async newestTurns(threadId: string, count: number): Promise<Turn[]> {
        const turns: Turn[] = [];
        let cursor: string | null = null;

        do {
            const params: ThreadTurnsListParams = {
                threadId,
                ...(cursor ? { cursor } : {}),
                limit: count - turns.length,
                sortDirection: "desc",
                itemsView: "notLoaded",
            };
            const page = await this.client.request<ThreadTurnsListResponse>("thread/turns/list", params);
            turns.push(...page.data);
            cursor = page.data.length > 0 ? page.nextCursor : null;
        } while (cursor && turns.length < count);

        return turns.slice(0, count);
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
        this.reviewThreadIds.add(result.reviewThreadId);
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

/**
 * The app-server refused input because the active turn takes no steering (a review or compact turn). codex-cli
 * 0.162.1 says so two ways: `turn/start` fails with `failed to submit turn input: ActiveTurnNotSteerable { turn_kind:
 * Review }` and no error data, and `turn/steer` fails with `cannot steer a review turn` plus
 * `codexErrorInfo.activeTurnNotSteerable` in the error data. "no active turn to steer" is not matched on purpose:
 * no turn is running then, so a queued steer would wait for a boundary that never comes.
 */
function isNotSteerableRejection(err: unknown): boolean {
    const info = nestedRecord(nestedRecord(err, "data"), "codexErrorInfo");
    if (info && "activeTurnNotSteerable" in info) {
        return true;
    }

    const message = err instanceof Error ? err.message : String(err);
    return /ActiveTurnNotSteerable|cannot steer a (review|compact) turn/.test(message);
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
