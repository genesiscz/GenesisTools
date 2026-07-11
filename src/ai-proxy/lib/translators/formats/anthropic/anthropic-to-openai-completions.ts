import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { isObject } from "@app/utils/object";

/**
 * Maps Anthropic `/v1/messages` responses back into the OpenAI
 * chat-completions shape the proxy's clients expect — both the non-streaming
 * final message and the streaming SSE event flow.
 */

export interface OpenAiToolCall {
    index?: number;
    id?: string;
    type: "function";
    function: { name?: string; arguments: string };
}

export interface OpenAiChatCompletion {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] };
        finish_reason: string;
    }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

type AnthropicStopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | string | null | undefined;

function mapFinishReason(stopReason: AnthropicStopReason): string {
    if (stopReason === "max_tokens") {
        return "length";
    }

    if (stopReason === "tool_use") {
        return "tool_calls";
    }

    return "stop";
}

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

/** Non-streaming: an Anthropic message object → an OpenAI chat.completion. */
export function anthropicMessageToOpenAiCompletion(
    message: Record<string, unknown>,
    options: { model: string }
): OpenAiChatCompletion {
    const contentBlocks = Array.isArray(message.content) ? message.content : [];
    const textParts: string[] = [];
    const toolCalls: OpenAiToolCall[] = [];

    for (const block of contentBlocks) {
        if (!isObject(block)) {
            continue;
        }

        if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
            continue;
        }

        if (block.type === "tool_use") {
            toolCalls.push({
                index: toolCalls.length,
                id: typeof block.id === "string" ? block.id : `call_${crypto.randomUUID()}`,
                type: "function",
                function: {
                    name: typeof block.name === "string" ? block.name : "unknown",
                    arguments: SafeJSON.stringify(block.input ?? {}),
                },
            });
        }
    }

    const usage = isObject(message.usage) ? message.usage : undefined;
    const inputTokens = usage && typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
    const outputTokens = usage && typeof usage.output_tokens === "number" ? usage.output_tokens : 0;

    const completion: OpenAiChatCompletion = {
        id: `chatcmpl-${typeof message.id === "string" ? message.id : crypto.randomUUID()}`,
        object: "chat.completion",
        created: nowSeconds(),
        model: options.model,
        choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content: textParts.length > 0 ? textParts.join("") : null,
                    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
                },
                finish_reason: mapFinishReason(message.stop_reason as AnthropicStopReason),
            },
        ],
        usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
        },
    };

    return completion;
}

interface ChunkDelta {
    role?: "assistant";
    content?: string;
    tool_calls?: OpenAiToolCall[];
}

function chunk(input: {
    id: string;
    model: string;
    created: number;
    delta: ChunkDelta;
    finishReason: string | null;
}): string {
    const payload = {
        id: input.id,
        object: "chat.completion.chunk",
        created: input.created,
        model: input.model,
        choices: [{ index: 0, delta: input.delta, finish_reason: input.finishReason }],
    };

    return `data: ${SafeJSON.stringify(payload)}\n\n`;
}

/**
 * Streaming: transform an Anthropic Messages SSE byte stream into an OpenAI
 * chat.completion.chunk SSE byte stream.
 */
export function anthropicSseToOpenAiChatStream(
    upstream: ReadableStream<Uint8Array>,
    options: { model: string }
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = upstream.getReader();

    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = nowSeconds();
    const model = options.model;

    let buffer = "";
    let roleEmitted = false;
    let finishReason: string | null = null;
    let nextToolIndex = 0;
    const blockToToolIndex = new Map<number, number>();

    function handleEvent(event: Record<string, unknown>, controller: ReadableStreamDefaultController<Uint8Array>): void {
        const type = event.type;

        if (type === "message_start") {
            if (!roleEmitted) {
                roleEmitted = true;
                controller.enqueue(encoder.encode(chunk({ id, model, created, delta: { role: "assistant" }, finishReason: null })));
            }

            return;
        }

        if (type === "content_block_start" && isObject(event.content_block) && typeof event.index === "number") {
            const contentBlock = event.content_block;

            if (contentBlock.type === "tool_use") {
                const toolIndex = nextToolIndex++;
                blockToToolIndex.set(event.index, toolIndex);
                controller.enqueue(
                    encoder.encode(
                        chunk({
                            id,
                            model,
                            created,
                            delta: {
                                tool_calls: [
                                    {
                                        index: toolIndex,
                                        id: typeof contentBlock.id === "string" ? contentBlock.id : `call_${crypto.randomUUID()}`,
                                        type: "function",
                                        function: {
                                            name: typeof contentBlock.name === "string" ? contentBlock.name : "unknown",
                                            arguments: "",
                                        },
                                    },
                                ],
                            },
                            finishReason: null,
                        })
                    )
                );
            }

            return;
        }

        if (type === "content_block_delta" && isObject(event.delta) && typeof event.index === "number") {
            const delta = event.delta;

            if (delta.type === "text_delta" && typeof delta.text === "string") {
                controller.enqueue(encoder.encode(chunk({ id, model, created, delta: { content: delta.text }, finishReason: null })));
                return;
            }

            if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
                const toolIndex = blockToToolIndex.get(event.index) ?? 0;
                controller.enqueue(
                    encoder.encode(
                        chunk({
                            id,
                            model,
                            created,
                            delta: { tool_calls: [{ index: toolIndex, type: "function", function: { arguments: delta.partial_json } }] },
                            finishReason: null,
                        })
                    )
                );
            }

            return;
        }

        if (type === "message_delta" && isObject(event.delta)) {
            const stopReason = event.delta.stop_reason;

            if (typeof stopReason === "string") {
                finishReason = mapFinishReason(stopReason);
            }

            return;
        }
    }

    function processLine(line: string, controller: ReadableStreamDefaultController<Uint8Array>): void {
        const trimmed = line.trimStart();

        if (!trimmed.startsWith("data:")) {
            return;
        }

        const payload = trimmed.slice("data:".length).trim();

        if (payload.length === 0) {
            return;
        }

        try {
            const event = SafeJSON.parse(payload, { strict: true });

            if (isObject(event)) {
                handleEvent(event, controller);
            }
        } catch (err) {
            logger.debug({ err, payload }, "ai-proxy: anthropic SSE line parse failed");
        }
    }

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();

                if (done) {
                    if (buffer.trim().length > 0) {
                        processLine(buffer, controller);
                        buffer = "";
                    }

                    controller.enqueue(encoder.encode(chunk({ id, model, created, delta: {}, finishReason: finishReason ?? "stop" })));
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                    return;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";

                for (const line of lines) {
                    processLine(line, controller);
                }
            } catch (err) {
                logger.warn({ err }, "ai-proxy: anthropic SSE stream error");
                controller.error(err);
            }
        },
        cancel(reason) {
            reader.cancel(reason).catch(() => {});
        },
    });
}
