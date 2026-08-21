import { safeStreamControllerError } from "@app/ai-proxy/lib/safe-stream-controller";
import { packReasoningSignature } from "@app/ai-proxy/lib/translators/formats/anthropic/anthropic-to-responses";
import {
    type AnthropicStopReason,
    type AnthropicUsage,
    anthropicSseFrame,
    parsedToolInput,
} from "@app/ai-proxy/lib/translators/formats/anthropic/openai-to-anthropic-responses";
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

function reasoningSignature(item: JsonRecord): string {
    if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) {
        return "";
    }

    const id = typeof item.id === "string" ? item.id : `rs_${crypto.randomUUID()}`;
    return packReasoningSignature(id, item.encrypted_content);
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
export function grokResponsesToAnthropicMessage(response: JsonRecord, options: { model: string }): JsonRecord {
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
                signature: reasoningSignature(item),
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
                input: parsedToolInput(item.arguments),
            });
        }
    }

    if (content.length === 0) {
        content.push({ type: "text", text: "" });
    }

    return {
        id: `msg_${typeof response.id === "string" ? response.id.replace(/^resp_/, "") : crypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        model: options.model,
        content,
        stop_reason: stopReasonFor(response, false),
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
}

interface StreamState {
    model: string;
    messageId: string;
    started: boolean;
    nextBlockIndex: number;
    /** Responses output_index → block state. Ignored item types are absent. */
    items: Map<number, ItemState>;
    sawFunctionCall: boolean;
    usage: AnthropicUsage | null;
    outputChars: number;
    finished: boolean;
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

function contentBlockFor(item: JsonRecord): { kind: BlockKind; block: JsonRecord } | null {
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

    return null;
}

function openItem(state: StreamState, outputIndex: number, item: JsonRecord): string {
    const mapped = contentBlockFor(item);

    if (mapped === null) {
        return "";
    }

    const blockIndex = state.nextBlockIndex++;
    state.items.set(outputIndex, {
        blockIndex,
        kind: mapped.kind,
        streamedChars: 0,
        summaryParts: 0,
        closed: false,
    });

    if (mapped.kind === "tool_use") {
        state.sawFunctionCall = true;
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

    return anthropicSseFrame("content_block_delta", { index: item.blockIndex, delta });
}

function closeItem(state: StreamState, outputIndex: number, doneItem: JsonRecord | undefined): string {
    const item = state.items.get(outputIndex);

    if (item === undefined || item.closed) {
        return "";
    }

    let out = "";

    if (doneItem !== undefined) {
        // The done frame carries the complete item; anything the stream never
        // delivered as deltas is salvaged here.
        if (item.kind === "thinking") {
            const summary = reasoningSummaryText(doneItem);

            if (item.streamedChars === 0 && summary.length > 0) {
                out += deltaFrame(state, outputIndex, { type: "thinking_delta", thinking: summary }, summary.length);
            }

            const signature = reasoningSignature(doneItem);

            if (signature.length > 0) {
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

    state.finished = true;

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

        out += closeItem(state, i, raw);
    }

    for (const [outputIndex, item] of state.items) {
        if (!item.closed) {
            out += closeItem(state, outputIndex, undefined);
        }
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
        return deltaFrame(
            state,
            outputIndex,
            { type: "input_json_delta", partial_json: event.delta },
            event.delta.length
        );
    }

    if (type === "response.output_item.done") {
        return closeItem(state, outputIndex, isObject(event.item) ? event.item : undefined);
    }

    if (type === "response.completed" || type === "response.incomplete") {
        return finishFrames(state, isObject(event.response) ? event.response : undefined);
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
    options: { model: string }
): ReadableStream<Uint8Array> {
    const state: StreamState = {
        model: options.model,
        messageId: `msg_${crypto.randomUUID()}`,
        started: false,
        nextBlockIndex: 0,
        items: new Map(),
        sawFunctionCall: false,
        usage: null,
        outputChars: 0,
        finished: false,
    };

    const reader = upstream.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";

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
                                "ai-proxy: skipped grok /responses SSE event"
                            );
                        }
                    }
                }

                // The 1-in-38 case: the stream ended without a terminal frame.
                // Close with what was seen instead of leaving the message open.
                emit(finishFrames(state, undefined));
                streamSucceeded = true;
            } catch (err) {
                logger.warn({ err, model: options.model }, "ai-proxy: grok /responses SSE translation failed");

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
            reader.cancel(reason).catch((err) => {
                logger.debug({ err }, "ai-proxy: upstream reader cancel failed");
            });
        },
    });
}
