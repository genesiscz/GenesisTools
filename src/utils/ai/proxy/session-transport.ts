import type {
    AgentTransport,
    AgentTransportRequest,
    AgentTransportResult,
    MiniAgent,
    SessionStore,
} from "@genesiscz/utils/ai/session";
import { createMiniAgent } from "@genesiscz/utils/ai/session";
import { logger } from "@genesiscz/utils/logger";
import type { LanguageModelUsage, ModelMessage } from "ai";
import type {
    AiProxyClient,
    ChatMessage,
    ChatOptions,
    ChatResult,
    ChatUsage,
    StreamCallbacks,
    ToolCall,
    ToolDefinition,
    ToolHandler,
} from "./AiProxyClient";

/**
 * Durable sessions over the local ai-proxy.
 *
 * `AiProxySession` proved the semantics (send, abort-and-interject, an agentic
 * tool loop) but kept them to itself and to memory. This exposes the same
 * behaviour as a `MiniAgent`, which means the ai-proxy gets the shared turn
 * protocol and, with a `store`, a conversation that survives the process.
 *
 * It goes through `AiProxyClient` rather than the gateway provider plugin on
 * purpose. Phase 8b landed the `ai-proxy` account the plugin needs, so that half
 * is no longer the reason; what remains is the client's tolerant schema parsing,
 * abort-returns-partial and raw tool-call deltas, none of which `coreChat`
 * expresses yet — see the four-point list at the top of AiProxyClient.ts. When
 * those land, this file is what gets deleted, not what gets rewritten.
 */

/** The two client methods a transport needs; narrow so tests can supply a stub. */
export type ProxyChatClient = Pick<AiProxyClient, "chat" | "chatStream">;

export interface ProxyTransportOptions {
    client: ProxyChatClient;
    /** Proxy model id, e.g. `anthropic/claude-sonnet-4-5`. */
    model: string;
    /** OpenAI-shaped tool definitions; the proxy speaks these, not ai-sdk ToolSets. */
    tools?: ToolDefinition[];
    /** Executes a requested tool. Without one, tool calls come back unhandled. */
    toolHandler?: ToolHandler;
    /** Tool round-trips per turn before the loop gives up. Ported from `runTools`. */
    maxRounds?: number;
    /** Per-request knobs (maxTokens, temperature, tags, schemaMode, …). */
    chat?: Omit<ChatOptions, "model" | "messages" | "signal" | "tools">;
    /** Streamed (default) so an interjected turn still has its partial text. */
    stream?: boolean;
    callbacks?: StreamCallbacks;
}

export function createProxyTransport(options: ProxyTransportOptions): AgentTransport {
    const { log } = logger.scoped("ai-proxy-session");
    const maxRounds = options.maxRounds ?? 8;

    return {
        async run(request: AgentTransportRequest): Promise<AgentTransportResult> {
            const messages = toChatMessages(request);
            let toolCalls = 0;
            let result = await complete(options, messages, request);

            for (let round = 0; round < maxRounds && result.toolCalls.length > 0; round++) {
                toolCalls += result.toolCalls.length;

                if (!options.toolHandler) {
                    log.warn({ tools: result.toolCalls.length }, "proxy asked for tools but no handler was given");
                    break;
                }

                messages.push(assistantTurn(result));

                for (const call of result.toolCalls) {
                    request.callbacks?.onToolCall?.(call.name, call.arguments);
                    const output = await options.toolHandler(call);
                    messages.push({ role: "tool", content: output, tool_call_id: call.id });
                    request.callbacks?.onToolResult?.(call.name, output);
                }

                result = await complete(options, messages, request);
            }

            return {
                text: result.text,
                toolCalls,
                usage: toUsage(result.usage),
                aborted: result.aborted,
                raw: result,
            };
        },
    };
}

export interface ProxySessionOptions extends ProxyTransportOptions {
    system?: string;
    /** Durable history. Without it the conversation lives only in the agent. */
    session?: { store: SessionStore; owner: string; title: string };
}

/** A `MiniAgent` whose turns run against the local ai-proxy. */
export function createProxySession(options: ProxySessionOptions): MiniAgent {
    return createMiniAgent({
        transport: createProxyTransport(options),
        system: options.system,
        session: options.session,
        maxSteps: options.maxRounds,
    });
}

async function complete(
    options: ProxyTransportOptions,
    messages: ChatMessage[],
    request: AgentTransportRequest
): Promise<ChatResult> {
    const chatOptions: ChatOptions = {
        ...options.chat,
        model: options.model,
        messages: [...messages],
        signal: request.signal,
        ...(options.tools ? { tools: options.tools } : {}),
    };

    if (options.stream === false) {
        return options.client.chat(chatOptions);
    }

    return options.client.chatStream(chatOptions, {
        ...options.callbacks,
        onDelta: (delta) => {
            request.callbacks?.onChunk?.(delta);
            options.callbacks?.onDelta?.(delta);
        },
        onReasoningDelta: (delta) => {
            request.callbacks?.onThinking?.(delta);
            options.callbacks?.onReasoningDelta?.(delta);
        },
    });
}

function assistantTurn(result: ChatResult): ChatMessage {
    return {
        role: "assistant",
        content: result.text,
        tool_calls: result.toolCalls.map((call: ToolCall) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.argumentsJson },
        })),
    };
}

/** The agent's context in the OpenAI shape the proxy speaks. */
function toChatMessages(request: AgentTransportRequest): ChatMessage[] {
    const messages: ChatMessage[] = [];

    if (request.system) {
        messages.push({ role: "system", content: request.system });
    }

    for (const message of request.messages) {
        const content = flatten(message);

        if (!content) {
            continue;
        }

        if (message.role === "assistant") {
            messages.push({ role: "assistant", content });
            continue;
        }

        // `tool` parts of a reloaded history have no call id to pair with, so
        // they enter as system text rather than an unmatched tool message.
        messages.push({ role: message.role === "user" ? "user" : "system", content });
    }

    return messages;
}

function flatten(message: ModelMessage): string {
    if (typeof message.content === "string") {
        return message.content;
    }

    if (!Array.isArray(message.content)) {
        return "";
    }

    return message.content
        .map((part) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
        .join("");
}

function toUsage(usage: ChatUsage | undefined): LanguageModelUsage | undefined {
    if (!usage) {
        return undefined;
    }

    return {
        inputTokens: usage.promptTokens,
        outputTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    };
}
