import type { RpcNotification } from "@genesiscz/utils/ai/openai/app-server-client";
import { type CodexTurnOutcome, codexTurnOutcome } from "@genesiscz/utils/codex/turn-outcome";
import type { WorkerAuthMode, WorkerTokens, WorkerUsagePart } from "@genesiscz/utils/worker/cost";

/**
 * Per-turn cost facts from a codex app-server notification stream.
 *
 * Pure and replayable: the live daemon feeds it the notifications of its own thread, and the
 * ledger backfill feeds it the same notifications out of `<name>.jsonl`. Usage comes from
 * `thread/tokenUsage/updated`'s `last` (ONE model call), not from diffing `total`: the calls
 * keep their own prompt length, so a context band applies per call, and a sum of `last` is
 * exactly `total` (3,011,927 tokens over 31 calls on sol-pr511, 2026-10-13).
 */

export interface CodexFinishedTurn {
    /** 1-based, counted per thread by this tracker. */
    turn: number;
    turnId?: string;
    outcome: CodexTurnOutcome;
    startedAt: Date | null;
    endedAt: Date;
    durationMs: number | null;
    /** One part per model call; empty when the turn ended before any call reported usage. */
    parts: WorkerUsagePart[];
    toolCalls: number;
    model: string | null;
    auth: WorkerAuthMode;
}

/** Items that are not a tool the agent ran. Everything else (`commandExecution`, `fileChange`, `mcpToolCall`, …) is. */
const NON_TOOL_ITEMS = new Set([
    "userMessage",
    "agentMessage",
    "reasoning",
    "hookPrompt",
    "todoList",
    "plan",
    "contextCompaction",
    "enteredReviewMode",
    "exitedReviewMode",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nested(value: unknown, key: string): Record<string, unknown> | null {
    return isRecord(value) && isRecord(value[key]) ? value[key] : null;
}

function count(record: Record<string, unknown>, key: string): number {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Codex counts `inputTokens` INCLUDING the cached part (OpenAI's convention), and reasoning
 * inside `outputTokens`: `totalTokens` is input + output.
 */
export function codexCallTokens(last: Record<string, unknown>): WorkerTokens {
    const input = count(last, "inputTokens");
    const cacheRead = count(last, "cachedInputTokens");
    const cacheWrite = count(last, "cacheWriteInputTokens");

    return {
        input: Math.max(0, input - cacheRead - cacheWrite),
        cacheRead,
        cacheWrite,
        output: count(last, "outputTokens"),
        reasoning: count(last, "reasoningOutputTokens"),
    };
}

/** `account/updated` names the login: `chatgpt…` is a ChatGPT plan, `apikey` the metered API. */
export function codexAuthMode(authMode: unknown): WorkerAuthMode {
    if (typeof authMode !== "string") {
        return "unknown";
    }

    const mode = authMode.toLowerCase();

    if (mode.startsWith("chatgpt")) {
        return "subscription";
    }

    return mode === "apikey" || mode === "api_key" || mode === "api-key" ? "api-key" : "unknown";
}

/** Unix seconds (codex `startedAt` / `completedAt`) to a Date; null when absent. */
function fromUnixSeconds(value: unknown): Date | null {
    return typeof value === "number" && value > 0 ? new Date(value * 1000) : null;
}

export class CodexTurnCostTracker {
    private model: string | null;
    private auth: WorkerAuthMode;
    private turns = 0;
    private parts: WorkerUsagePart[] = [];
    private toolCalls = 0;
    private startedAt: Date | null = null;

    constructor(init: { model?: string | null; auth?: WorkerAuthMode; turns?: number } = {}) {
        this.model = init.model ?? null;
        this.auth = init.auth ?? "unknown";
        this.turns = init.turns ?? 0;
    }

    get turnCount(): number {
        return this.turns;
    }

    /** Feed one notification of the worker's own thread; answers with the turn it finished, if any. */
    observe(notification: RpcNotification, at: Date): CodexFinishedTurn | null {
        const { method, params } = notification;

        if (method === "account/updated" && isRecord(params)) {
            const auth = codexAuthMode(params.authMode);

            if (auth !== "unknown") {
                this.auth = auth;
            }

            return null;
        }

        if (method === "thread/started") {
            const model = nested(params, "thread")?.model;

            if (typeof model === "string" && model) {
                this.model = model;
            }

            return null;
        }

        if (method === "turn/started") {
            this.parts = [];
            this.toolCalls = 0;
            this.startedAt = fromUnixSeconds(nested(params, "turn")?.startedAt) ?? at;
            return null;
        }

        if (method === "thread/tokenUsage/updated") {
            const last = nested(nested(params, "tokenUsage"), "last");

            if (last) {
                this.parts.push({ model: this.model, tokens: codexCallTokens(last), singleRequest: true });
            }

            return null;
        }

        if (method === "item/completed") {
            const type = nested(params, "item")?.type;

            if (typeof type === "string" && !NON_TOOL_ITEMS.has(type)) {
                this.toolCalls += 1;
            }

            return null;
        }

        const terminal = codexTurnOutcome(notification);

        if (!terminal) {
            return null;
        }

        const turn = nested(params, "turn");
        const endedAt = fromUnixSeconds(turn?.completedAt) ?? at;
        const reported = turn?.durationMs;
        const durationMs =
            typeof reported === "number"
                ? reported
                : this.startedAt
                  ? Math.max(0, endedAt.getTime() - this.startedAt.getTime())
                  : null;

        this.turns += 1;
        const finished: CodexFinishedTurn = {
            turn: this.turns,
            ...(terminal.turnId ? { turnId: terminal.turnId } : {}),
            outcome: terminal.outcome,
            startedAt: this.startedAt,
            endedAt,
            durationMs,
            parts: this.parts,
            toolCalls: this.toolCalls,
            model: this.model,
            auth: this.auth,
        };

        this.parts = [];
        this.toolCalls = 0;
        this.startedAt = null;
        return finished;
    }
}
