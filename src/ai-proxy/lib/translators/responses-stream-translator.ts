import {
    closeFoldedDetailsContent,
    type FoldedStreamState,
    foldedAnswerPrefix,
    foldedReasoningPrefix,
} from "@app/ai-proxy/lib/thinking-folded";
import {
    buildReasoningItem,
    type ReasoningItem,
    reasoningItemsFromOutput,
    serializeReasoningItems,
    transformResponsesUsage,
} from "@app/ai-proxy/lib/translators/reasoning";
import type { ThinkingPresentationMode } from "@app/ai-proxy/lib/types";
import { isObject } from "@app/utils/object";

type JsonObject = Record<string, unknown>;

export interface ToolCallIndexState {
    outputToToolIndex: Map<number, number>;
    nextIndex: number;
}

export function createToolCallIndexState(): ToolCallIndexState {
    return { outputToToolIndex: new Map(), nextIndex: 0 };
}

function resolveToolCallIndex(state: ToolCallIndexState | undefined, outputIndex: number): number {
    if (!state) {
        return outputIndex;
    }

    let toolIndex = state.outputToToolIndex.get(outputIndex);

    if (toolIndex === undefined) {
        toolIndex = state.nextIndex;
        state.outputToToolIndex.set(outputIndex, toolIndex);
        state.nextIndex += 1;
    }

    return toolIndex;
}

export interface ChatToolCallDelta {
    index: number;
    id?: string;
    type: "function";
    function: {
        name?: string;
        arguments?: string;
    };
}

export interface ChatStreamDelta {
    role?: string;
    content?: string;
    reasoning_content?: string;
    reasoning_items?: ReturnType<typeof serializeReasoningItems>;
    tool_calls?: ChatToolCallDelta[];
}

export interface TranslatedStreamChunk {
    delta?: ChatStreamDelta;
    finishReason?: string | null;
    usage?: JsonObject;
}

function toolCallId(item: JsonObject): string | undefined {
    if (typeof item.call_id === "string") {
        return item.call_id;
    }

    if (typeof item.id === "string") {
        return item.id;
    }

    return undefined;
}

function hasFunctionCalls(outputItems: unknown[]): boolean {
    return outputItems.some((item) => isObject(item) && item.type === "function_call");
}

export function translateResponsesStreamEvent({
    event,
    thinkingMode = "raw",
    foldedState,
    toolCallIndexState,
}: {
    event: JsonObject;
    thinkingMode?: ThinkingPresentationMode;
    foldedState?: FoldedStreamState;
    toolCallIndexState?: ToolCallIndexState;
}): TranslatedStreamChunk | null {
    const type = event.type;
    const useCursorThinking = thinkingMode === "cursor";
    const useFoldedThinking = thinkingMode === "folded";

    if (type === "response.output_text.delta" && typeof event.delta === "string") {
        if (useFoldedThinking && foldedState) {
            const prefix = foldedAnswerPrefix(foldedState);

            return { delta: { content: `${prefix}${event.delta}` } };
        }

        return { delta: { content: event.delta } };
    }

    if (
        (type === "response.reasoning_text.delta" ||
            type === "response.reasoning_summary_text.delta" ||
            type === "response.reasoning.delta") &&
        typeof event.delta === "string"
    ) {
        if (useCursorThinking) {
            return { delta: { reasoning_content: event.delta } };
        }

        if (useFoldedThinking && foldedState) {
            const prefix = foldedReasoningPrefix(foldedState);

            return { delta: { content: `${prefix}${event.delta}` } };
        }

        return { delta: { content: event.delta } };
    }

    if (type === "response.output_item.added") {
        const item = isObject(event.item) ? event.item : {};
        const outputIndex = typeof event.output_index === "number" ? event.output_index : 0;

        if (item.type === "function_call") {
            const toolIndex = resolveToolCallIndex(toolCallIndexState, outputIndex);
            const id = toolCallId(item) ?? `call_${toolIndex}`;

            return {
                delta: {
                    tool_calls: [
                        {
                            index: toolIndex,
                            id,
                            type: "function",
                            function: {
                                name: typeof item.name === "string" ? item.name : undefined,
                                arguments:
                                    typeof item.arguments === "string"
                                        ? item.arguments
                                        : typeof event.arguments === "string"
                                          ? event.arguments
                                          : "",
                            },
                        },
                    ],
                },
            };
        }

        if (item.type === "reasoning") {
            if (useFoldedThinking) {
                return null;
            }

            if (!useCursorThinking) {
                return null;
            }

            const reasoningItem = buildReasoningItem(item);

            return {
                delta: {
                    reasoning_items: serializeReasoningItems([reasoningItem]),
                },
            };
        }
    }

    if (type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
        const outputIndex = typeof event.output_index === "number" ? event.output_index : 0;
        const toolIndex = resolveToolCallIndex(toolCallIndexState, outputIndex);

        return {
            delta: {
                tool_calls: [
                    {
                        index: toolIndex,
                        type: "function",
                        function: {
                            arguments: event.delta,
                        },
                    },
                ],
            },
        };
    }

    if (type === "response.output_item.done") {
        const item = isObject(event.item) ? event.item : {};

        if (item.type === "function_call") {
            return { delta: {} };
        }

        if (item.type === "reasoning") {
            if (useFoldedThinking) {
                return null;
            }

            if (!useCursorThinking) {
                return null;
            }

            const reasoningItem: ReasoningItem = buildReasoningItem(item);

            return {
                delta: {
                    reasoning_items: serializeReasoningItems([reasoningItem]),
                },
            };
        }

        if (item.type === "message") {
            if (useFoldedThinking) {
                return null;
            }

            return { delta: { content: "" } };
        }
    }

    if (type === "response.completed") {
        const response = isObject(event.response) ? event.response : {};
        const output = Array.isArray(response.output) ? response.output : [];
        const finishReason = hasFunctionCalls(output) ? "tool_calls" : "stop";
        const delta: ChatStreamDelta = {};

        if (useCursorThinking) {
            const reasoningItems = reasoningItemsFromOutput(output);

            if (reasoningItems.length > 0) {
                delta.reasoning_items = serializeReasoningItems(reasoningItems);
            }
        }

        if (useFoldedThinking && foldedState) {
            const closeTag = closeFoldedDetailsContent(foldedState);

            if (closeTag) {
                delta.content = closeTag;
            }
        }

        return {
            delta,
            finishReason,
            usage: transformResponsesUsage(response.usage),
        };
    }

    return null;
}
