import type { CallTarget } from "@genesiscz/utils/ai/core/call";
import { coreChat, resolveCallTarget } from "@genesiscz/utils/ai/core/call";
import type { ModelRef } from "@genesiscz/utils/ai/core/model-ref";
import type { ResolvedBinding, ResolveOptions } from "@genesiscz/utils/ai/core/types";
import { logger } from "@genesiscz/utils/logger";
import type { LanguageModelUsage, ModelMessage, ToolSet } from "ai";
import type { MessageRecord, SessionId, SessionRecord, SessionStore } from "./types";
import { SessionBusyError } from "./types";

/**
 * A conversation that can call tools and be steered mid-answer.
 *
 * This is `AiProxySession`'s job description (send / interject / runTools) with
 * two things it never had: durable history, and a model named the same way the
 * rest of the AI layer names one. The tool loop itself is the SDK's — `coreChat`
 * already stops at `maxSteps` — so what lives here is the turn bookkeeping:
 * which messages exist, what an abort leaves behind, and what gets persisted.
 *
 * `transport` is the seam that keeps the ai-proxy honest. The proxy client has
 * its own HTTP stack (tolerant schema parsing, raw OpenAI tool deltas) and
 * cannot resolve through the plugin registry until an `ai-proxy` account exists,
 * so it supplies a transport instead of a `ModelRef` and gets the same steering
 * semantics as everyone else.
 */

export interface AgentCallbacks {
    onChunk?: (text: string) => void;
    onThinking?: (text: string) => void;
    onToolCall?: (name: string, input: unknown) => void;
    onToolResult?: (name: string, output: unknown) => void;
}

export interface AgentTransportRequest {
    system?: string;
    messages: ModelMessage[];
    tools?: ToolSet;
    maxSteps?: number;
    signal?: AbortSignal;
    callbacks?: AgentCallbacks;
}

export interface AgentTransportResult {
    text: string;
    toolCalls: number;
    usage?: LanguageModelUsage;
    /** Set when the turn was cut short by `interject`; `text` is then partial. */
    aborted?: boolean;
    /** Transport-specific payload (the proxy's `ChatResult`, for instance). */
    raw?: unknown;
}

export interface AgentTransport {
    run(request: AgentTransportRequest): Promise<AgentTransportResult>;
}

export interface MiniAgentOptions {
    /** A ModelRef (`opus`, `@account/acc_x:opus`) or an already-resolved binding. */
    model?: ModelRef | ResolvedBinding;
    system?: string;
    session?: { store: SessionStore; owner: string; title: string };
    tools?: ToolSet;
    maxSteps?: number;
    /** Tool name, for `defaults.app.<app>.<task>` model overrides. */
    app?: string;
    task?: ResolveOptions["task"];
    /** Replaces the default `coreChat` transport. Mutually exclusive with `model`. */
    transport?: AgentTransport;
}

export interface AgentTurn {
    text: string;
    toolCalls: number;
    usage?: LanguageModelUsage;
    aborted?: boolean;
    raw?: unknown;
}

export interface MiniAgent {
    send(text: string, options?: { callbacks?: AgentCallbacks }): Promise<AgentTurn>;
    /** Abort the in-flight turn and queue `text` as the next user message. */
    interject(text: string): Promise<void>;
    readonly busy: boolean;
    /** The working context, including tool round-trips from the current turn. */
    readonly messages: ModelMessage[];
    /** The persisted session, once one has been opened. */
    session(): Promise<SessionRecord | undefined>;
}

export function createMiniAgent(options: MiniAgentOptions): MiniAgent {
    const { log } = logger.scoped("ai-session");

    if (options.model && options.transport) {
        throw new Error("Pass either `model` or `transport` to createMiniAgent, not both.");
    }

    const messages: ModelMessage[] = [];
    const queued: string[] = [];
    let inflight: AbortController | undefined;
    let transport = options.transport;
    let record: SessionRecord | undefined;
    let hydrated = false;

    async function ensureTransport(): Promise<AgentTransport> {
        if (!transport) {
            const target = await resolveCallTarget({
                model: options.model,
                task: options.task,
                app: options.app,
            });
            transport = createCoreTransport(target);
        }

        return transport;
    }

    async function ensureSession(): Promise<SessionRecord | undefined> {
        if (!options.session) {
            return undefined;
        }

        if (!record) {
            record = await options.session.store.getOrCreate(options.session.owner, options.session.title);
        }

        if (!hydrated) {
            hydrated = true;
            const history = await options.session.store.history(record.id);
            messages.push(...toModelMessages(history));
            log.debug({ session: record.id, messages: messages.length }, "mini-agent hydrated from session");
        }

        return record;
    }

    /** One request to the model, with the in-memory context updated from its outcome. */
    async function runOnce(userText: string, callbacks: AgentCallbacks | undefined): Promise<AgentTransportResult> {
        messages.push({ role: "user", content: userText });
        const controller = new AbortController();
        inflight = controller;

        try {
            const result = await (await ensureTransport()).run({
                system: options.system,
                messages: [...messages],
                tools: options.tools,
                maxSteps: options.maxSteps,
                signal: controller.signal,
                callbacks,
            });
            messages.push({ role: "assistant", content: result.text });

            return result;
        } finally {
            if (inflight === controller) {
                inflight = undefined;
            }
        }
    }

    async function send(text: string, sendOptions?: { callbacks?: AgentCallbacks }): Promise<AgentTurn> {
        if (inflight) {
            throw new SessionBusyError(record?.id ?? options.session?.title ?? "mini-agent");
        }

        const session = await ensureSession();
        let pending = text;
        let toolCalls = 0;
        let usage: LanguageModelUsage | undefined;

        for (;;) {
            const result = session
                ? await runInSession(options.session, session.id, pending, sendOptions?.callbacks)
                : await runOnce(pending, sendOptions?.callbacks);
            toolCalls += result.toolCalls;
            usage = mergeUsage(usage, result.usage);
            const next = queued.shift();

            if (result.aborted && next !== undefined) {
                log.debug({ chars: result.text.length }, "turn interjected — partial answer kept, continuing");
                pending = next;
                continue;
            }

            return { text: result.text, toolCalls, usage, aborted: result.aborted, raw: result.raw };
        }
    }

    /** The session-backed spelling of `runOnce`: the store owns ordering and the busy guard. */
    async function runInSession(
        config: MiniAgentOptions["session"],
        id: SessionId,
        userText: string,
        callbacks: AgentCallbacks | undefined
    ): Promise<AgentTransportResult> {
        if (!config) {
            throw new Error("runInSession called without a session config");
        }

        let captured: AgentTransportResult | undefined;
        await config.store.turn(id, userText, async () => {
            captured = await runOnce(userText, callbacks);

            return {
                text: captured.text,
                meta: compact({
                    usage: captured.usage,
                    toolCalls: captured.toolCalls || undefined,
                    aborted: captured.aborted,
                }),
            };
        });

        if (!captured) {
            throw new Error("session turn produced no result");
        }

        return captured;
    }

    return {
        send,

        async interject(text: string): Promise<void> {
            queued.push(text);
            inflight?.abort();
            log.debug({ queued: queued.length, wasBusy: Boolean(inflight) }, "interjected");
        },

        get busy(): boolean {
            return inflight !== undefined;
        },

        get messages(): ModelMessage[] {
            return messages;
        },

        session: ensureSession,
    };
}

/**
 * The default transport: `coreChat`, always streamed.
 *
 * Streaming is not a preference here — an aborted turn only has a partial answer
 * because the deltas were collected as they arrived. A non-streamed call that is
 * cancelled returns nothing at all, which would make `interject` lose the text
 * `AiProxySession` was careful to keep.
 */
export function createCoreTransport(target: CallTarget): AgentTransport {
    return {
        async run(request: AgentTransportRequest): Promise<AgentTransportResult> {
            let text = "";
            let toolCalls = 0;

            try {
                const result = await coreChat({
                    target,
                    system: request.system,
                    messages: request.messages,
                    tools: request.tools,
                    maxSteps: request.maxSteps,
                    abortSignal: request.signal,
                    stream: true,
                    onChunk: (chunk) => {
                        text += chunk;
                        request.callbacks?.onChunk?.(chunk);
                    },
                    onThinking: request.callbacks?.onThinking,
                    onToolCall: (name, input) => {
                        toolCalls += 1;
                        request.callbacks?.onToolCall?.(name, input);
                    },
                    onToolResult: request.callbacks?.onToolResult,
                });

                if (request.signal?.aborted) {
                    return { text: result.content || text, toolCalls, aborted: true };
                }

                return { text: result.content, toolCalls, usage: result.usage };
            } catch (error) {
                if (request.signal?.aborted) {
                    logger.debug({ err: error }, "aborted call threw — keeping the partial text");

                    return { text, toolCalls, aborted: true };
                }

                throw error;
            }
        },
    };
}

/** Session history as model context. `config` rows carry no content and are skipped. */
export function toModelMessages(history: MessageRecord[]): ModelMessage[] {
    const messages: ModelMessage[] = [];

    for (const record of history) {
        if (record.role === "config" || !record.content) {
            continue;
        }

        if (record.role === "user") {
            messages.push({ role: "user", content: record.content });
            continue;
        }

        if (record.role === "assistant") {
            messages.push({ role: "assistant", content: record.content });
            continue;
        }

        // `system`, `context` and `tool` rows all enter the context as system
        // text: the SDK's tool role needs a matching tool-call id, which a
        // reloaded session no longer has.
        messages.push({ role: "system", content: record.content });
    }

    return messages;
}

function mergeUsage(
    total: LanguageModelUsage | undefined,
    next: LanguageModelUsage | undefined
): LanguageModelUsage | undefined {
    if (!next) {
        return total;
    }

    if (!total) {
        return next;
    }

    // Spread first so the SDK's per-call detail breakdown (cache reads/writes,
    // reasoning tokens) survives; only the three totals are summable.
    return {
        ...total,
        inputTokens: add(total.inputTokens, next.inputTokens),
        outputTokens: add(total.outputTokens, next.outputTokens),
        totalTokens: add(total.totalTokens, next.totalTokens),
    };
}

function add(a: number | undefined, b: number | undefined): number | undefined {
    if (a === undefined && b === undefined) {
        return undefined;
    }

    return (a ?? 0) + (b ?? 0);
}

function compact(value: Record<string, unknown>): Record<string, unknown> | undefined {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);

    if (entries.length === 0) {
        return undefined;
    }

    return Object.fromEntries(entries);
}
