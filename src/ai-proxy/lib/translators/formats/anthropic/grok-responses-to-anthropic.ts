import { safeStreamControllerError } from "@app/ai-proxy/lib/safe-stream-controller";
import {
    type AnthropicStopReason,
    type AnthropicUsage,
    anthropicSseFrame,
    parsedToolInput,
} from "@app/ai-proxy/lib/translators/formats/anthropic/openai-to-anthropic-responses";
import { grokReasoningCodec } from "@app/ai-proxy/lib/translators/formats/anthropic/reasoning-codec";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

type JsonRecord = Record<string, unknown>;

/**
 * xAI Responses output → Anthropic Messages, streaming and not. The mirror of
 * anthropic-to-responses.ts. One Responses output item becomes one Anthropic
 * content block, keyed by `output_index` — the merge defect the shim has is
 * structurally impossible here.
 *
 * Terminal-frame reconciliation: grok occasionally streams an item only in the
 * final `response.completed` snapshot (fleet-harness measured 1 dropped
 * terminal frame in 38 calls against the same upstream, in the OTHER
 * direction — items streamed but the terminal frame missing). Both gaps are
 * covered: items never streamed are synthesized from the snapshot, and a
 * stream that ends without a terminal frame still closes with what it saw.
 */

function usageFromResponses(raw: unknown): AnthropicUsage | null {
    if (!isObject(raw)) {
        return null;
    }

    const inputTokens = typeof raw.input_tokens === "number" ? raw.input_tokens : 0;
    const outputTokens = typeof raw.output_tokens === "number" ? raw.output_tokens : 0;

    // Same folds as the chat-completions mapping: reasoning is added only when
    // the totals prove it was excluded, cache reads move OUTSIDE input_tokens.
    const outputDetails = isObject(raw.output_tokens_details) ? raw.output_tokens_details : undefined;
    const reasoningTokens =
        outputDetails && typeof outputDetails.reasoning_tokens === "number" ? outputDetails.reasoning_tokens : 0;
    const totalTokens = typeof raw.total_tokens === "number" ? raw.total_tokens : undefined;
    const reasoningExcluded = reasoningTokens > 0 && totalTokens != null && inputTokens + outputTokens < totalTokens;

    const usage: AnthropicUsage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens + (reasoningExcluded ? reasoningTokens : 0),
    };

    const inputDetails = isObject(raw.input_tokens_details) ? raw.input_tokens_details : undefined;

    if (inputDetails && typeof inputDetails.cached_tokens === "number" && inputDetails.cached_tokens > 0) {
        usage.cache_read_input_tokens = inputDetails.cached_tokens;
        usage.input_tokens = Math.max(0, inputTokens - inputDetails.cached_tokens);
    }

    if (reasoningTokens > 0) {
        usage.output_tokens_details = { reasoning_tokens: reasoningTokens };
    }

    return usage;
}

function reasoningSummaryText(item: JsonRecord): string {
    if (!Array.isArray(item.summary)) {
        return "";
    }

    return item.summary
        .map((part) => (isObject(part) && typeof part.text === "string" ? part.text : ""))
        .filter((text) => text.length > 0)
        .join("\n\n");
}

/** Maximum UTF-16 code units retained for replay of a completed reply. */
export const MAX_REPLAY_RESPONSE_CHARS = 256 * 1024;

/** What differs per upstream when a Responses output becomes an Anthropic message. */
export interface ResponsesToAnthropicOptions {
    model: string;
    /** The thinking block's signature for a reasoning item (default: Grok's `grokrs1:`). */
    signReasoning?: (item: JsonRecord) => string;
    /** Receive a completed text-only assistant reply, using the blocks sent to the client. */
    onTextResponse?: (content: JsonRecord[]) => void;
    /** Names the upstream in log lines. */
    label?: string;
    /** Client request abort, which may reject the upstream read before output cancellation. */
    signal?: AbortSignal;
    /**
     * A rewrite of one tool's input, chosen by tool name. That call's arguments are held until it is complete and
     * then sent once, rewritten; every other call streams as it arrives.
     */
    toolInput?: (name: string) => ((input: unknown) => unknown) | undefined;
    /**
     * A custom (free-form) tool call as a client tool call, chosen by the custom tool's name: the client tool's name and
     * its input built from the raw text the model wrote, sent once the call is complete. Without a mapping the call is
     * skipped like any item with no Anthropic block.
     */
    customToolCall?: (name: string) => CustomToolMapping | undefined;
}

export interface CustomToolMapping {
    name: string;
    input: (raw: string) => unknown;
}

function customMapping(options: { customToolCall?: ResponsesToAnthropicOptions["customToolCall"] }, item: JsonRecord) {
    return item.type === "custom_tool_call" && typeof item.name === "string"
        ? options.customToolCall?.(item.name)
        : undefined;
}

const warnedItemTypes = new Set<string>();

function rewriteToolInput(options: ResponsesToAnthropicOptions, name: unknown, input: unknown): unknown {
    const rewrite = typeof name === "string" ? options.toolInput?.(name) : undefined;
    return rewrite ? rewrite(input) : input;
}

/** An output item no content block exists for (agent items, new types): logged once per type, the turn goes on. */
function warnUnknownItem(item: JsonRecord, label: string): void {
    const type = typeof item.type === "string" ? item.type : "(none)";

    if (!warnedItemTypes.has(type)) {
        warnedItemTypes.add(type);
        logger.warn(
            { type, upstream: label },
            "ai-proxy: skipped a Responses output item type with no Anthropic block"
        );
    }
}

function messageText(item: JsonRecord): string {
    if (!Array.isArray(item.content)) {
        return "";
    }

    return item.content.map((part) => (isObject(part) && typeof part.text === "string" ? part.text : "")).join("");
}

function stopReasonFor(response: JsonRecord, sawFunctionCall: boolean): AnthropicStopReason {
    const incomplete = isObject(response.incomplete_details) ? response.incomplete_details : undefined;

    if (response.status === "incomplete" && incomplete?.reason === "max_output_tokens") {
        return "max_tokens";
    }

    const output = Array.isArray(response.output) ? response.output : [];
    const hasCall = sawFunctionCall || output.some((item) => isObject(item) && item.type === "function_call");

    return hasCall ? "tool_use" : "end_turn";
}

/** Non-streaming: a Responses envelope → an Anthropic message object. */
export function grokResponsesToAnthropicMessage(
    response: JsonRecord,
    options: ResponsesToAnthropicOptions
): JsonRecord {
    return responsesToAnthropicMessage(response, options);
}

export function responsesToAnthropicMessage(response: JsonRecord, options: ResponsesToAnthropicOptions): JsonRecord {
    const sign = options.signReasoning ?? grokReasoningCodec.seal;
    const output = Array.isArray(response.output) ? response.output : [];
    const content: JsonRecord[] = [];

    for (const item of output) {
        if (!isObject(item)) {
            continue;
        }

        if (item.type === "reasoning") {
            content.push({
                type: "thinking",
                thinking: reasoningSummaryText(item),
                signature: sign(item),
            });
            continue;
        }

        if (item.type === "message") {
            content.push({ type: "text", text: messageText(item) });
            continue;
        }

        if (item.type === "function_call") {
            content.push({
                type: "tool_use",
                id: typeof item.call_id === "string" ? item.call_id : `toolu_${crypto.randomUUID()}`,
                name: typeof item.name === "string" ? item.name : "unknown",
                input: rewriteToolInput(options, item.name, parsedToolInput(item.arguments)),
            });
            continue;
        }

        const custom = customMapping(options, item);

        if (custom) {
            content.push({
                type: "tool_use",
                id: typeof item.call_id === "string" ? item.call_id : `toolu_${crypto.randomUUID()}`,
                name: custom.name,
                input: custom.input(typeof item.input === "string" ? item.input : ""),
            });
            continue;
        }

        warnUnknownItem(item, options.label ?? "grok");
    }

    // Claude Code drops a thinking block that ends a message, and with it the reasoning a next turn would replay.
    if (content.length === 0 || content.at(-1)?.type === "thinking") {
        content.push({ type: "text", text: "" });
    }

    if (
        response.status === "completed" &&
        content.some((block) => block.type === "thinking") &&
        content.every((block) => block.type !== "tool_use")
    ) {
        options.onTextResponse?.(content);
    }

    return {
        id: `msg_${typeof response.id === "string" ? response.id.replace(/^resp_/, "") : crypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        model: options.model,
        content,
        stop_reason: stopReasonFor(
            response,
            content.some((block) => block.type === "tool_use")
        ),
        stop_sequence: null,
        usage: usageFromResponses(response.usage) ?? { input_tokens: 0, output_tokens: 0 },
    };
}

type BlockKind = "thinking" | "text" | "tool_use";

interface ItemState {
    /** Anthropic content-block index this output item was assigned. */
    blockIndex: number;
    kind: BlockKind;
    /** Characters already streamed for this block (dedupes the done-frame salvage). */
    streamedChars: number;
    summaryParts: number;
    closed: boolean;
    /** Set for a tool call whose input is rewritten: its arguments are held in `heldArgs`. */
    rewrite?: (input: unknown) => unknown;
    /** Set for a custom tool call sent as a client tool call: its raw input is held in `heldArgs`. */
    customInput?: (raw: string) => unknown;
    heldArgs: string;
    clientBlock?: JsonRecord;
    clientChunks?: string[];
    completeCustomInput?: string;
    customBlock?: JsonRecord;
}

interface StreamState {
    model: string;
    sign: (item: JsonRecord) => string;
    onTextResponse?: (content: JsonRecord[]) => void;
    label: string;
    /** The kind of the last block opened, so a message never ends on a thinking block. */
    lastKind: BlockKind | undefined;
    messageId: string;
    started: boolean;
    nextBlockIndex: number;
    /** Responses output_index → block state. Ignored item types are absent. */
    items: Map<number, ItemState>;
    toolInput: ResponsesToAnthropicOptions["toolInput"];
    customToolCall: ResponsesToAnthropicOptions["customToolCall"];
    sawFunctionCall: boolean;
    usage: AnthropicUsage | null;
    outputChars: number;
    replayChars: number;
    finished: boolean;
}

function stopTextCapture(state: StreamState): void {
    state.onTextResponse = undefined;
    for (const item of state.items.values()) {
        item.clientBlock = undefined;
        item.clientChunks = undefined;
    }
}

function reserveReplayChars(state: StreamState, chars: number): boolean {
    if (!state.onTextResponse) {
        return false;
    }
    if (state.replayChars + chars > MAX_REPLAY_RESPONSE_CHARS) {
        stopTextCapture(state);
        return false;
    }
    state.replayChars += chars;
    return true;
}

function frameStart(state: StreamState): string {
    if (state.started) {
        return "";
    }

    state.started = true;

    return anthropicSseFrame("message_start", {
        message: {
            id: state.messageId,
            type: "message",
            role: "assistant",
            model: state.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
        },
    });
}

function contentBlockFor(
    item: JsonRecord,
    state: StreamState
): { kind: BlockKind; block: JsonRecord; customInput?: (raw: string) => unknown } | null {
    if (item.type === "reasoning") {
        return { kind: "thinking", block: { type: "thinking", thinking: "" } };
    }

    if (item.type === "message") {
        return { kind: "text", block: { type: "text", text: "" } };
    }

    if (item.type === "function_call") {
        return {
            kind: "tool_use",
            block: {
                type: "tool_use",
                id: typeof item.call_id === "string" ? item.call_id : `toolu_${crypto.randomUUID()}`,
                name: typeof item.name === "string" ? item.name : "unknown",
                input: {},
            },
        };
    }

    const custom = customMapping(state, item);

    if (custom) {
        return {
            kind: "tool_use",
            block: {
                type: "tool_use",
                id: typeof item.call_id === "string" ? item.call_id : `toolu_${crypto.randomUUID()}`,
                name: custom.name,
                input: {},
            },
            customInput: custom.input,
        };
    }

    return null;
}

function openItem(state: StreamState, outputIndex: number, item: JsonRecord): string {
    const mapped = contentBlockFor(item, state);

    if (mapped === null) {
        warnUnknownItem(item, state.label);
        return "";
    }

    if (mapped.kind === "tool_use") {
        stopTextCapture(state);
    }
    // Count each block too, so empty blocks cannot make replay capture unbounded.
    const capture = reserveReplayChars(state, 1);
    const blockIndex = state.nextBlockIndex++;
    state.lastKind = mapped.kind;
    state.items.set(outputIndex, {
        blockIndex,
        kind: mapped.kind,
        streamedChars: 0,
        summaryParts: 0,
        closed: false,
        rewrite:
            mapped.kind === "tool_use" && !mapped.customInput && typeof mapped.block.name === "string"
                ? state.toolInput?.(mapped.block.name)
                : undefined,
        customInput: mapped.customInput,
        customBlock: mapped.customInput ? mapped.block : undefined,
        heldArgs: "",
        clientBlock: capture ? { ...mapped.block } : undefined,
        clientChunks: capture ? [] : undefined,
    });

    if (mapped.kind === "tool_use") {
        state.sawFunctionCall = true;
    }

    if (mapped.customInput) {
        return frameStart(state);
    }

    return (
        frameStart(state) + anthropicSseFrame("content_block_start", { index: blockIndex, content_block: mapped.block })
    );
}

function deltaFrame(state: StreamState, outputIndex: number, delta: JsonRecord, chars: number): string {
    const item = state.items.get(outputIndex);

    if (item === undefined || item.closed) {
        return "";
    }

    item.streamedChars += chars;
    state.outputChars += chars;
    const fragment =
        delta.type === "thinking_delta" && typeof delta.thinking === "string"
            ? delta.thinking
            : delta.type === "text_delta" && typeof delta.text === "string"
              ? delta.text
              : "";
    if (fragment.length > 0 && item.clientChunks && reserveReplayChars(state, fragment.length)) {
        item.clientChunks.push(fragment);
    }

    return anthropicSseFrame("content_block_delta", { index: item.blockIndex, delta });
}

function closeItem(state: StreamState, outputIndex: number, doneItem: JsonRecord | undefined): string {
    const item = state.items.get(outputIndex);

    if (item === undefined || item.closed) {
        return "";
    }

    let out = "";

    if (item.customInput) {
        const raw = typeof doneItem?.input === "string" ? doneItem.input : item.completeCustomInput;
        if (raw === undefined) {
            state.finished = true;
            return anthropicSseFrame("error", {
                error: { type: "api_error", message: "upstream custom tool input was incomplete" },
            });
        }

        const json = SafeJSON.stringify(item.customInput(raw));
        out += anthropicSseFrame("content_block_start", { index: item.blockIndex, content_block: item.customBlock });
        out += deltaFrame(state, outputIndex, { type: "input_json_delta", partial_json: json }, json.length);
    }

    if (item.rewrite) {
        const raw =
            typeof doneItem?.arguments === "string" && doneItem.arguments.length > 0
                ? doneItem.arguments
                : item.heldArgs;
        const json = SafeJSON.stringify(item.rewrite(parsedToolInput(raw)));
        out += deltaFrame(state, outputIndex, { type: "input_json_delta", partial_json: json }, json.length);
    }

    if (doneItem !== undefined) {
        // The done frame carries the complete item; anything the stream never
        // delivered as deltas is salvaged here.
        if (item.kind === "thinking") {
            const summary = reasoningSummaryText(doneItem);

            if (item.streamedChars === 0 && summary.length > 0) {
                out += deltaFrame(state, outputIndex, { type: "thinking_delta", thinking: summary }, summary.length);
            }

            const signature = state.sign(doneItem);

            if (signature.length > 0) {
                if (item.clientBlock && reserveReplayChars(state, signature.length)) {
                    item.clientBlock.signature = signature;
                }
                out += anthropicSseFrame("content_block_delta", {
                    index: item.blockIndex,
                    delta: { type: "signature_delta", signature },
                });
            }
        }

        if (item.kind === "text") {
            const text = messageText(doneItem);

            if (item.streamedChars === 0 && text.length > 0) {
                out += deltaFrame(state, outputIndex, { type: "text_delta", text }, text.length);
            }
        }

        if (item.kind === "tool_use" && typeof doneItem.arguments === "string" && doneItem.arguments.length > 0) {
            if (item.streamedChars === 0) {
                out += deltaFrame(
                    state,
                    outputIndex,
                    { type: "input_json_delta", partial_json: doneItem.arguments },
                    doneItem.arguments.length
                );
            }
        }
    }

    item.closed = true;
    out += anthropicSseFrame("content_block_stop", { index: item.blockIndex });

    return out;
}

function finishFrames(state: StreamState, response: JsonRecord | undefined): string {
    if (state.finished) {
        return "";
    }

    let out = frameStart(state);

    // Items the stream never opened (terminal-snapshot-only) are synthesized
    // whole; open items are closed with their snapshot for salvage.
    const output = response !== undefined && Array.isArray(response.output) ? response.output : [];

    for (const [i, raw] of output.entries()) {
        if (!isObject(raw)) {
            continue;
        }

        if (!state.items.has(i)) {
            out += openItem(state, i, raw);
        }

        const incompleteCustom = state.items.get(i)?.customInput && response?.status !== "completed";
        out += closeItem(state, i, incompleteCustom ? undefined : raw);
        if (state.finished) {
            return out;
        }
    }

    for (const [outputIndex, item] of state.items) {
        if (!item.closed) {
            out += closeItem(state, outputIndex, undefined);
            if (state.finished) {
                return out;
            }
        }
    }

    state.finished = true;

    // Claude Code drops a thinking block that ends a message, and with it the reasoning a next turn would replay.
    if (state.lastKind === "thinking") {
        const index = state.nextBlockIndex++;
        state.lastKind = "text";
        out += anthropicSseFrame("content_block_start", { index, content_block: { type: "text", text: "" } });
        out += anthropicSseFrame("content_block_stop", { index });
    }

    if (response !== undefined) {
        state.usage = usageFromResponses(response.usage) ?? state.usage;
    }

    const stopReason =
        response !== undefined
            ? stopReasonFor(response, state.sawFunctionCall)
            : state.sawFunctionCall
              ? "tool_use"
              : "end_turn";

    out += anthropicSseFrame("message_delta", {
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: state.usage ?? { input_tokens: 0, output_tokens: Math.ceil(state.outputChars / 4) },
    });
    out += anthropicSseFrame("message_stop", {});

    return out;
}

function handleEvent(state: StreamState, event: JsonRecord): string {
    const type = event.type;
    const outputIndex = typeof event.output_index === "number" ? event.output_index : 0;

    if (type === "response.output_item.added" && isObject(event.item)) {
        return openItem(state, outputIndex, event.item);
    }

    if (type === "response.reasoning_summary_part.added") {
        const item = state.items.get(outputIndex);

        if (item !== undefined && item.summaryParts > 0) {
            item.summaryParts += 1;
            return deltaFrame(state, outputIndex, { type: "thinking_delta", thinking: "\n\n" }, 2);
        }

        if (item !== undefined) {
            item.summaryParts += 1;
        }

        return "";
    }

    if (type === "response.reasoning_summary_text.delta" && typeof event.delta === "string") {
        return deltaFrame(state, outputIndex, { type: "thinking_delta", thinking: event.delta }, event.delta.length);
    }

    if (type === "response.output_text.delta" && typeof event.delta === "string") {
        return deltaFrame(state, outputIndex, { type: "text_delta", text: event.delta }, event.delta.length);
    }

    if (type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
        const held = state.items.get(outputIndex);

        if (held?.rewrite) {
            held.heldArgs += event.delta;
            return "";
        }

        return deltaFrame(
            state,
            outputIndex,
            { type: "input_json_delta", partial_json: event.delta },
            event.delta.length
        );
    }

    if (type === "response.custom_tool_call_input.delta" && typeof event.delta === "string") {
        const held = state.items.get(outputIndex);

        if (held?.customInput) {
            held.heldArgs += event.delta;
        }

        return "";
    }

    if (type === "response.custom_tool_call_input.done" && typeof event.input === "string") {
        const held = state.items.get(outputIndex);
        if (held?.customInput) {
            held.completeCustomInput = event.input;
        }

        return "";
    }

    if (type === "response.output_item.done") {
        return closeItem(state, outputIndex, isObject(event.item) ? event.item : undefined);
    }

    if (type === "response.completed" || type === "response.incomplete") {
        const wasFinished = state.finished;
        const frames = finishFrames(state, isObject(event.response) ? event.response : undefined);
        if (!wasFinished && type === "response.completed" && !state.sawFunctionCall && state.onTextResponse) {
            const content = [...state.items.values()]
                .sort((left, right) => left.blockIndex - right.blockIndex)
                .flatMap((item) => {
                    if (!item.clientBlock) {
                        return [];
                    }
                    const block = { ...item.clientBlock };
                    if (item.kind === "thinking") {
                        block.thinking = item.clientChunks?.join("") ?? "";
                    } else if (item.kind === "text") {
                        block.text = item.clientChunks?.join("") ?? "";
                    }
                    return [block];
                });
            if (content.some((block) => block.type === "thinking")) {
                if (content.at(-1)?.type === "thinking") {
                    content.push({ type: "text", text: "" });
                }
                state.onTextResponse(content);
            }
        }
        return frames;
    }

    if (type === "response.failed" || type === "error") {
        const err = isObject(event.response) && isObject(event.response.error) ? event.response.error : event.error;
        const message = isObject(err) && typeof err.message === "string" ? err.message : "upstream response failed";
        state.finished = true;

        return anthropicSseFrame("error", { error: { type: "api_error", message } });
    }

    return "";
}

/** Streaming: a Responses SSE body → an Anthropic SSE body. */
export function grokResponsesSseToAnthropic(
    upstream: ReadableStream<Uint8Array>,
    options: ResponsesToAnthropicOptions
): ReadableStream<Uint8Array> {
    return responsesSseToAnthropic(upstream, options);
}

export function responsesSseToAnthropic(
    upstream: ReadableStream<Uint8Array>,
    options: ResponsesToAnthropicOptions
): ReadableStream<Uint8Array> {
    const label = options.label ?? "grok";
    const state: StreamState = {
        model: options.model,
        sign: options.signReasoning ?? grokReasoningCodec.seal,
        onTextResponse: options.onTextResponse,
        label,
        lastKind: undefined,
        messageId: `msg_${crypto.randomUUID()}`,
        started: false,
        nextBlockIndex: 0,
        items: new Map(),
        toolInput: options.toolInput,
        customToolCall: options.customToolCall,
        sawFunctionCall: false,
        usage: null,
        outputChars: 0,
        replayChars: 0,
        finished: false,
    };

    const reader = upstream.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";

    // Set when the client stops reading (Claude Code stopping a subagent): the read loop then fails with "The
    // connection was closed", which is the stop, not a translation failure.
    let clientCancelled = false;

    return new ReadableStream<Uint8Array>({
        async start(controller) {
            let streamSucceeded = false;

            const emit = (chunk: string): void => {
                if (chunk.length > 0) {
                    controller.enqueue(encoder.encode(chunk));
                }
            };

            try {
                while (true) {
                    const { done, value } = await reader.read();

                    if (done) {
                        break;
                    }

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() ?? "";

                    for (const line of lines) {
                        // Grok stalls up to ~15s before the first byte and holds
                        // the connection with SSE comments; forward them so the
                        // client's idle timeout sees a live stream.
                        if (line.startsWith(":")) {
                            emit(`${line}\n\n`);
                            continue;
                        }

                        if (!line.startsWith("data:")) {
                            continue;
                        }

                        const payload = line.slice(5).trim();

                        if (!payload || payload === "[DONE]") {
                            continue;
                        }

                        try {
                            const event = SafeJSON.parse(payload, { strict: true });

                            if (isObject(event)) {
                                emit(handleEvent(state, event));
                            }
                        } catch (err) {
                            logger.debug(
                                { err, payloadPreview: payload.slice(0, 120) },
                                `ai-proxy: skipped ${label} /responses SSE event`
                            );
                        }
                    }
                }

                // The 1-in-38 case: the stream ended without a terminal frame.
                // Close with what was seen instead of leaving the message open.
                emit(finishFrames(state, undefined));
                streamSucceeded = true;
            } catch (err) {
                if (clientCancelled || options.signal?.aborted) {
                    logger.debug(
                        { err, model: options.model, upstream: label },
                        "ai-proxy: the client stopped the stream"
                    );
                } else {
                    logger.warn(
                        { err, model: options.model, upstream: label },
                        "ai-proxy: /responses SSE translation failed"
                    );
                }

                if (!safeStreamControllerError(controller, err, streamSucceeded)) {
                    logger.debug({ err }, "ai-proxy: skipped controller.error (client abort or detached)");
                }
            } finally {
                if (streamSucceeded) {
                    try {
                        controller.close();
                    } catch (controllerErr) {
                        logger.debug({ err: controllerErr }, "ai-proxy: controller.close() threw — client detached");
                    }
                }
            }
        },
        cancel(reason) {
            clientCancelled = true;
            reader.cancel(reason).catch((err) => {
                logger.debug({ err }, "ai-proxy: upstream reader cancel failed");
            });
        },
    });
}
