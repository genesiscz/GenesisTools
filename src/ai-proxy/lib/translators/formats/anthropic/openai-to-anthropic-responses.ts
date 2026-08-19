import { SafeJSON } from "@genesiscz/utils/json";
import { isObject } from "@genesiscz/utils/object";

/**
 * Maps OpenAI chat-completions RESPONSES into the Anthropic `/v1/messages`
 * shape. This is the mirror of anthropic-to-openai-completions.ts: that file
 * serves clients who speak OpenAI against a Claude upstream, this one serves
 * clients who speak Anthropic (Claude Code) against an OpenAI upstream.
 *
 * Extended thinking is forwarded as real `thinking` blocks but WITHOUT a
 * `signature`. Anthropic only needs a signature to verify a thinking block sent
 * back up, and the inbound normalizer (normalize.ts) drops assistant thinking
 * blocks from history, so nothing is ever echoed to an upstream that would
 * check it.
 */

export type AnthropicStopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";

export interface AnthropicUsage {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
}

export function openAiFinishToAnthropicStop(finishReason: unknown): AnthropicStopReason {
    if (finishReason === "length") {
        return "max_tokens";
    }

    if (finishReason === "tool_calls" || finishReason === "function_call") {
        return "tool_use";
    }

    return "end_turn";
}

function usageFrom(raw: unknown): AnthropicUsage {
    if (!isObject(raw)) {
        return { input_tokens: 0, output_tokens: 0 };
    }

    const promptTokens = typeof raw.prompt_tokens === "number" ? raw.prompt_tokens : 0;
    const completionTokens = typeof raw.completion_tokens === "number" ? raw.completion_tokens : 0;

    // Anthropic counts thinking INSIDE output_tokens; OpenAI keeps reasoning out of
    // completion_tokens and reports it under completion_tokens_details. Reporting
    // completion_tokens alone made a grok-4.6:xhigh turn look like 139 output tokens
    // when it actually produced 1763 — a 12x undercount in every client's cost and
    // context display, and worst exactly on the reasoning models people reach for.
    const completionDetails = isObject(raw.completion_tokens_details) ? raw.completion_tokens_details : undefined;
    const reasoningTokens =
        completionDetails && typeof completionDetails.reasoning_tokens === "number"
            ? completionDetails.reasoning_tokens
            : 0;

    const usage: AnthropicUsage = {
        input_tokens: promptTokens,
        output_tokens: completionTokens + reasoningTokens,
    };

    const details = isObject(raw.prompt_tokens_details) ? raw.prompt_tokens_details : undefined;

    if (details && typeof details.cached_tokens === "number" && details.cached_tokens > 0) {
        // Anthropic reports cache reads OUTSIDE input_tokens, OpenAI reports them
        // inside prompt_tokens. Subtract so the client's own "input + cache read"
        // sum matches what the upstream actually charged for.
        usage.cache_read_input_tokens = details.cached_tokens;
        usage.input_tokens = Math.max(0, promptTokens - details.cached_tokens);
    }

    return usage;
}

function parsedToolInput(rawArguments: unknown): unknown {
    if (typeof rawArguments !== "string" || rawArguments.trim().length === 0) {
        return {};
    }

    try {
        return SafeJSON.parse(rawArguments, { strict: true });
    } catch {
        return { _raw: rawArguments };
    }
}

/** Non-streaming: an OpenAI chat.completion → an Anthropic message object. */
export function openAiCompletionToAnthropicMessage(
    completion: Record<string, unknown>,
    options: { model: string }
): Record<string, unknown> {
    const choices = Array.isArray(completion.choices) ? completion.choices : [];
    const choice = isObject(choices[0]) ? choices[0] : {};
    const message = isObject(choice.message) ? choice.message : {};
    const content: Record<string, unknown>[] = [];

    const reasoning = message.reasoning_content ?? message.reasoning;

    if (typeof reasoning === "string" && reasoning.length > 0) {
        content.push({ type: "thinking", thinking: reasoning });
    }

    if (typeof message.content === "string" && message.content.length > 0) {
        content.push({ type: "text", text: message.content });
    }

    if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
            if (!isObject(call)) {
                continue;
            }

            const fn = isObject(call.function) ? call.function : {};

            content.push({
                type: "tool_use",
                id: typeof call.id === "string" ? call.id : `toolu_${crypto.randomUUID()}`,
                name: typeof fn.name === "string" ? fn.name : "unknown",
                input: parsedToolInput(fn.arguments),
            });
        }
    }

    // Anthropic clients treat an empty content array as a protocol error; Claude
    // Code renders nothing and then retries forever.
    if (content.length === 0) {
        content.push({ type: "text", text: "" });
    }

    return {
        id: `msg_${typeof completion.id === "string" ? completion.id.replace(/^chatcmpl-/, "") : crypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        model: options.model,
        content,
        stop_reason: openAiFinishToAnthropicStop(choice.finish_reason),
        stop_sequence: null,
        usage: usageFrom(completion.usage),
    };
}

function frame(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${SafeJSON.stringify({ type, ...data })}\n\n`;
}

type BlockKind = "thinking" | "text" | "tool_use";

interface OpenBlock {
    kind: BlockKind;
    index: number;
    /** The OpenAI tool_call index this block mirrors; only set for tool_use. */
    toolIndex?: number;
}

export interface AnthropicStreamState {
    model: string;
    messageId: string;
    started: boolean;
    open: OpenBlock | null;
    nextIndex: number;
    stopReason: AnthropicStopReason | null;
    usage: AnthropicUsage;
    /** id/name seen for an OpenAI tool_call index — later frames carry arguments only. */
    seenTools: Map<number, { id: string; name: string }>;
    /** Characters streamed out, for the usage estimate when the upstream reports none. */
    outputChars: number;
    /** Prompt-token estimate to fall back on; see createAnthropicStreamState. */
    fallbackInputTokens: number;
}

/**
 * `fallbackInputTokens` exists because several upstreams stream no usage at all:
 * Grok's chat/completions drops `stream_options`, so its SSE never carries a
 * token count. Reporting 0/0 would leave Claude Code's context meter empty and
 * its auto-compact trigger blind, so an estimate is reported instead of nothing.
 */
export function createAnthropicStreamState(model: string, fallbackInputTokens = 0): AnthropicStreamState {
    return {
        model,
        messageId: `msg_${crypto.randomUUID()}`,
        started: false,
        open: null,
        nextIndex: 0,
        stopReason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
        seenTools: new Map(),
        outputChars: 0,
        fallbackInputTokens,
    };
}

function reportedUsage(state: AnthropicStreamState): AnthropicUsage {
    if (state.usage.input_tokens > 0 || state.usage.output_tokens > 0) {
        return state.usage;
    }

    return {
        input_tokens: state.fallbackInputTokens,
        output_tokens: Math.ceil(state.outputChars / 4),
    };
}

/** The `message_start` frame. Emitted lazily so an upstream error never opens a message. */
export function anthropicStreamStart(state: AnthropicStreamState): string {
    if (state.started) {
        return "";
    }

    state.started = true;

    return frame("message_start", {
        message: {
            id: state.messageId,
            type: "message",
            role: "assistant",
            model: state.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: state.fallbackInputTokens, output_tokens: 0 },
        },
    });
}

function closeBlock(state: AnthropicStreamState): string {
    if (!state.open) {
        return "";
    }

    const out = frame("content_block_stop", { index: state.open.index });
    state.open = null;
    return out;
}

function openBlock(state: AnthropicStreamState, kind: BlockKind, contentBlock: Record<string, unknown>): string {
    const index = state.nextIndex++;
    state.open = { kind, index };

    return frame("content_block_start", { index, content_block: contentBlock });
}

/**
 * Translate ONE OpenAI `chat.completion.chunk` into the Anthropic SSE frames it
 * implies. Returns "" when the chunk carries nothing renderable (a bare role
 * delta, a usage-only trailer).
 */
export function anthropicStreamChunk(state: AnthropicStreamState, chunk: Record<string, unknown>): string {
    let out = "";

    if (isObject(chunk.usage)) {
        state.usage = usageFrom(chunk.usage);
    }

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = isObject(choices[0]) ? choices[0] : {};
    const delta = isObject(choice.delta) ? choice.delta : {};

    if (typeof choice.finish_reason === "string") {
        state.stopReason = openAiFinishToAnthropicStop(choice.finish_reason);
    }

    const reasoning = delta.reasoning_content ?? delta.reasoning;

    if (typeof reasoning === "string" && reasoning.length > 0) {
        out += anthropicStreamStart(state);
        state.outputChars += reasoning.length;

        if (state.open?.kind !== "thinking") {
            out += closeBlock(state);
            out += openBlock(state, "thinking", { type: "thinking", thinking: "" });
        }

        out += frame("content_block_delta", {
            index: state.open?.index ?? 0,
            delta: { type: "thinking_delta", thinking: reasoning },
        });
    }

    if (typeof delta.content === "string" && delta.content.length > 0) {
        out += anthropicStreamStart(state);
        state.outputChars += delta.content.length;

        if (state.open?.kind !== "text") {
            out += closeBlock(state);
            out += openBlock(state, "text", { type: "text", text: "" });
        }

        out += frame("content_block_delta", {
            index: state.open?.index ?? 0,
            delta: { type: "text_delta", text: delta.content },
        });
    }

    if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
            if (!isObject(call)) {
                continue;
            }

            const toolIndex = typeof call.index === "number" ? call.index : 0;
            const fn = isObject(call.function) ? call.function : {};
            const known = state.seenTools.get(toolIndex);

            const id = typeof call.id === "string" ? call.id : known?.id;
            const name = typeof fn.name === "string" ? fn.name : known?.name;

            if (id || name) {
                state.seenTools.set(toolIndex, {
                    id: id ?? `toolu_${crypto.randomUUID()}`,
                    name: name ?? "unknown",
                });
            }

            out += anthropicStreamStart(state);

            if (state.open?.kind !== "tool_use" || state.open.toolIndex !== toolIndex) {
                const resolved = state.seenTools.get(toolIndex) ?? {
                    id: `toolu_${crypto.randomUUID()}`,
                    name: "unknown",
                };
                out += closeBlock(state);
                out += openBlock(state, "tool_use", {
                    type: "tool_use",
                    id: resolved.id,
                    name: resolved.name,
                    input: {},
                });

                if (state.open) {
                    state.open.toolIndex = toolIndex;
                }
            }

            if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
                state.outputChars += fn.arguments.length;
                out += frame("content_block_delta", {
                    index: state.open?.index ?? 0,
                    delta: { type: "input_json_delta", partial_json: fn.arguments },
                });
            }
        }
    }

    return out;
}

/** Closing frames: the open block, then `message_delta` (stop reason + usage) and `message_stop`. */
export function anthropicStreamEnd(state: AnthropicStreamState): string {
    let out = anthropicStreamStart(state);
    out += closeBlock(state);

    // input_tokens rides along in message_delta as well: the real Anthropic API
    // knows them at message_start, an OpenAI upstream only reports them in its
    // final usage trailer, and a client that never sees them shows a 0-token
    // context. Extra fields here are ignored by clients that do not want them.
    out += frame("message_delta", {
        delta: { stop_reason: state.stopReason ?? "end_turn", stop_sequence: null },
        usage: reportedUsage(state),
    });

    out += frame("message_stop", {});

    return out;
}
