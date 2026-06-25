import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { wrapReasoningForFoldedJson } from "@app/ai-proxy/lib/thinking-folded";
import {
    reasoningContentFromItem,
    reasoningItemsFromOutput,
    serializeReasoningItems,
    transformResponsesUsage,
} from "@app/ai-proxy/lib/translators/reasoning";
import type { ThinkingPresentationMode } from "@app/ai-proxy/lib/types";
import { type PipelineResult, pipelineResult } from "@app/ai-proxy/lib/usage/pipeline-result";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { isObject } from "@app/utils/object";

type JsonObject = Record<string, unknown>;

function extractTextFromContentParts(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (!Array.isArray(content)) {
        return "";
    }

    const parts: string[] = [];

    for (const part of content) {
        if (!isObject(part)) {
            continue;
        }

        if (
            (part.type === "output_text" || part.type === "reasoning_text" || part.type === "text") &&
            typeof part.text === "string"
        ) {
            parts.push(part.text);
        }
    }

    return parts.join("");
}

export function transformResponsesToChatCompletion({
    response,
    proxyModel,
    thinkingMode = "raw",
}: {
    response: JsonObject;
    proxyModel: string;
    thinkingMode?: ThinkingPresentationMode;
}): JsonObject {
    const output = Array.isArray(response.output) ? response.output : [];

    let content = "";
    let reasoningContent = "";
    const reasoningItems = reasoningItemsFromOutput(output);
    const toolCalls: JsonObject[] = [];
    let toolCallIndex = 0;

    for (const item of output) {
        if (!isObject(item)) {
            continue;
        }

        if (item.type === "reasoning") {
            const reasoningText = reasoningContentFromItem(item);
            if (reasoningText) {
                reasoningContent = reasoningContent ? `${reasoningContent} ${reasoningText}` : reasoningText;
            }
        }

        if (item.type === "message") {
            const messageText = extractTextFromContentParts(item.content);
            if (messageText) {
                content = messageText;
            }
        }

        if (item.type === "function_call") {
            const toolCallId =
                typeof item.call_id === "string"
                    ? item.call_id
                    : typeof item.id === "string"
                      ? item.id
                      : `call_${toolCallIndex}`;

            toolCalls.push({
                id: toolCallId,
                type: "function",
                index: toolCallIndex,
                function: {
                    name: typeof item.name === "string" ? item.name : "",
                    arguments:
                        typeof item.arguments === "string" ? item.arguments : SafeJSON.stringify(item.arguments ?? {}),
                },
            });
            toolCallIndex += 1;
        }
    }

    const useCursorThinking = thinkingMode === "cursor";
    const useFoldedThinking = thinkingMode === "folded";
    let messageContent = content || null;

    if (useFoldedThinking && reasoningContent) {
        messageContent = wrapReasoningForFoldedJson(reasoningContent, messageContent);
    } else if (!useCursorThinking && reasoningContent) {
        messageContent = messageContent ? `${reasoningContent}\n\n${messageContent}` : reasoningContent;
    }

    const message: JsonObject = {
        role: "assistant",
        content: messageContent,
    };

    if (useCursorThinking && reasoningContent) {
        message.reasoning_content = reasoningContent;
    }

    if (useCursorThinking && reasoningItems.length > 0) {
        message.reasoning_items = serializeReasoningItems(reasoningItems);
    }

    if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
    }

    const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";
    const created =
        typeof response.created_at === "number" && response.created_at > 0
            ? response.created_at
            : Math.floor(Date.now() / 1000);

    const result: JsonObject = {
        id: typeof response.id === "string" ? response.id : `chatcmpl-${crypto.randomUUID()}`,
        object: "chat.completion",
        created,
        model: proxyModel,
        choices: [
            {
                index: 0,
                message,
                finish_reason: finishReason,
            },
        ],
    };

    const usage = transformResponsesUsage(response.usage);
    if (usage) {
        result.usage = usage;
    }

    return result;
}

export async function responsesToChatJson({
    provider,
    upstreamModel,
    proxyModel,
    req,
    bodyText,
    thinkingMode = "raw",
}: {
    provider: ProxyProvider;
    upstreamModel: string;
    proxyModel: string;
    req: Request;
    bodyText: string;
    thinkingMode?: ThinkingPresentationMode;
}): Promise<PipelineResult> {
    const upstream = await provider.responses(req, upstreamModel, bodyText);

    if (!upstream.ok) {
        return pipelineResult(upstream);
    }

    const rawText = await upstream.text();

    try {
        const parsed = SafeJSON.parse(rawText, { strict: true }) as JsonObject;
        const transformed = transformResponsesToChatCompletion({ response: parsed, proxyModel, thinkingMode });
        const responseText = SafeJSON.stringify(transformed);

        return pipelineResult(
            new Response(responseText, {
                status: upstream.status,
                headers: { "Content-Type": "application/json" },
            }),
            responseText
        );
    } catch (err) {
        logger.warn(
            { err, proxyModel, upstreamModel, upstreamStatus: upstream.status },
            "ai-proxy: responses-to-chat-json transform failed"
        );
        return pipelineResult(
            new Response(rawText, {
                status: upstream.status,
                headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
            }),
            rawText
        );
    }
}
