import { createFoldedStreamState, foldedAnswerPrefix, foldedReasoningPrefix } from "@app/ai-proxy/lib/thinking-folded";
import { buildReasoningItem, serializeReasoningItems } from "@app/ai-proxy/lib/translators/reasoning";
import type { ThinkingPresentationMode } from "@app/ai-proxy/lib/types";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { isObject } from "@app/utils/object";
import { safeStreamControllerError } from "./safe-stream-controller";

type JsonObject = Record<string, unknown>;

interface StreamEnrichState {
    foldedState: ReturnType<typeof createFoldedStreamState>;
    roleSent: boolean;
    reasoningItemId: string | null;
}

function createStreamEnrichState(): StreamEnrichState {
    return {
        foldedState: createFoldedStreamState(),
        roleSent: false,
        reasoningItemId: null,
    };
}

function rewriteChatPayloadModel(payload: unknown, responseModel: string): unknown {
    if (!isObject(payload)) {
        return payload;
    }

    if (!("model" in payload)) {
        return payload;
    }

    return {
        ...payload,
        model: responseModel,
    };
}

function isSseDonePayload(payload: string): boolean {
    return payload.trim() === "[DONE]";
}

function deltaHasPayload(delta: JsonObject): boolean {
    return (
        delta.content !== undefined ||
        delta.reasoning_content !== undefined ||
        delta.reasoning_items !== undefined ||
        delta.tool_calls !== undefined
    );
}

function withAssistantRole(delta: JsonObject, state: StreamEnrichState): JsonObject {
    if (typeof delta.role === "string") {
        state.roleSent = true;

        return delta;
    }

    if (state.roleSent || !deltaHasPayload(delta)) {
        return delta;
    }

    state.roleSent = true;

    return {
        role: "assistant",
        ...delta,
    };
}

function enrichDeltaForCursor(delta: JsonObject, state: StreamEnrichState): JsonObject {
    const next: JsonObject = { ...delta };

    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        if (!state.reasoningItemId) {
            state.reasoningItemId = `rs_${crypto.randomUUID()}`;
            const reasoningItem = buildReasoningItem({
                id: state.reasoningItemId,
                type: "reasoning",
                content: [{ type: "reasoning_text", text: delta.reasoning_content }],
            });

            next.reasoning_items = serializeReasoningItems([reasoningItem]);
        }
    }

    return withAssistantRole(next, state);
}

function enrichDeltaForFolded(delta: JsonObject, state: StreamEnrichState): JsonObject {
    const next: JsonObject = { ...delta };

    if (typeof delta.reasoning_content === "string") {
        const prefix = foldedReasoningPrefix(state.foldedState);
        next.content = `${prefix}${delta.reasoning_content}`;
        delete next.reasoning_content;
    }

    if (typeof delta.content === "string") {
        const prefix = foldedAnswerPrefix(state.foldedState);
        next.content = `${prefix}${delta.content}`;
    }

    return next;
}

function enrichChatPayload(
    payload: JsonObject,
    thinkingMode: ThinkingPresentationMode,
    state: StreamEnrichState
): JsonObject {
    const choices = payload.choices;

    if (!Array.isArray(choices) || choices.length === 0) {
        return payload;
    }

    let changed = false;
    const enrichedChoices = choices.map((rawChoice) => {
        if (!isObject(rawChoice)) {
            return rawChoice;
        }

        const delta = rawChoice.delta;

        if (!isObject(delta)) {
            return rawChoice;
        }

        let enrichedDelta = delta;

        if (thinkingMode === "cursor") {
            enrichedDelta = enrichDeltaForCursor(delta, state);
        } else if (thinkingMode === "folded") {
            enrichedDelta = enrichDeltaForFolded(delta, state);
        }

        if (enrichedDelta === delta) {
            return rawChoice;
        }

        changed = true;

        return {
            ...rawChoice,
            delta: enrichedDelta,
        };
    });

    if (!changed) {
        return payload;
    }

    return {
        ...payload,
        choices: enrichedChoices,
    };
}

function transformChatPayload(
    payload: unknown,
    responseModel: string,
    thinkingMode: ThinkingPresentationMode,
    state: StreamEnrichState
): unknown {
    let next = rewriteChatPayloadModel(payload, responseModel);

    if ((thinkingMode === "cursor" || thinkingMode === "folded") && isObject(next)) {
        next = enrichChatPayload(next, thinkingMode, state);
    }

    return next;
}

function rewriteSseDataLine(
    line: string,
    responseModel: string,
    thinkingMode: ThinkingPresentationMode,
    state: StreamEnrichState
): string {
    const prefix = "data:";
    const trimmed = line.trimStart();

    if (!trimmed.startsWith(prefix)) {
        return line;
    }

    const payload = trimmed.slice(prefix.length).trim();

    if (isSseDonePayload(payload)) {
        return line;
    }

    try {
        const parsed = SafeJSON.parse(payload, { strict: true });
        const rewritten = transformChatPayload(parsed, responseModel, thinkingMode, state);

        if (rewritten === parsed) {
            return line;
        }

        const suffix = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";

        return `data: ${SafeJSON.stringify(rewritten)}${suffix}`;
    } catch (err) {
        logger.debug({ err, responseModel }, "ai-proxy: enrichGrokChatSseLine fallback");
        return line;
    }
}

function enrichGrokChatSseStream(
    stream: ReadableStream<Uint8Array>,
    responseModel: string,
    thinkingMode: ThinkingPresentationMode
): ReadableStream<Uint8Array> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    const state = createStreamEnrichState();

    return new ReadableStream({
        async start(controller) {
            const reader = stream.getReader();
            let closed = false;

            try {
                while (true) {
                    const { done, value } = await reader.read();

                    if (done) {
                        if (buffer.length > 0) {
                            controller.enqueue(
                                encoder.encode(rewriteSseDataLine(buffer, responseModel, thinkingMode, state))
                            );
                        }

                        try {
                            controller.close();
                            closed = true;
                        } catch (controllerErr) {
                            logger.warn(
                                { err: controllerErr, responseModel },
                                "ai-proxy: enrichGrokChatSseStream controller.close() threw"
                            );
                        }
                        break;
                    }

                    buffer += decoder.decode(value, { stream: true });

                    let newlineIndex = buffer.indexOf("\n");

                    while (newlineIndex >= 0) {
                        const line = buffer.slice(0, newlineIndex + 1);
                        buffer = buffer.slice(newlineIndex + 1);
                        controller.enqueue(
                            encoder.encode(rewriteSseDataLine(line, responseModel, thinkingMode, state))
                        );
                        newlineIndex = buffer.indexOf("\n");
                    }
                }
            } catch (err) {
                logger.warn({ err, responseModel }, "ai-proxy: enrichGrokChatSseStream failed");

                if (!safeStreamControllerError(controller, err, closed)) {
                    logger.debug(
                        { err, responseModel, closed },
                        "ai-proxy: enrichGrokChatSseStream skipped controller.error (client abort or detached)"
                    );
                }
            } finally {
                try {
                    reader.releaseLock();
                } catch (lockErr) {
                    logger.debug(
                        { err: lockErr, responseModel },
                        "ai-proxy: enrichGrokChatSseStream releaseLock failed"
                    );
                }
            }
        },
    });
}

export function enrichGrokChatCompletionJson(
    bodyText: string,
    responseModel: string,
    thinkingMode: ThinkingPresentationMode
): string {
    try {
        const parsed = SafeJSON.parse(bodyText, { strict: true });

        if (!isObject(parsed)) {
            return bodyText;
        }

        const state = createStreamEnrichState();
        const rewritten = transformChatPayload(parsed, responseModel, thinkingMode, state);

        return SafeJSON.stringify(rewritten);
    } catch (err) {
        logger.debug({ err, responseModel }, "ai-proxy: enrichGrokChatCompletionJson fallback");
        return bodyText;
    }
}

export async function enrichGrokChatResponse(
    response: Response,
    responseModel: string,
    thinkingMode: ThinkingPresentationMode
): Promise<Response> {
    if (!response.body) {
        return response;
    }

    const contentType = response.headers.get("content-type") ?? "";

    if (contentType.includes("text/event-stream")) {
        return new Response(enrichGrokChatSseStream(response.body, responseModel, thinkingMode), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    }

    if (contentType.includes("application/json")) {
        const bodyText = await response.text();
        const rewritten = enrichGrokChatCompletionJson(bodyText, responseModel, thinkingMode);
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        headers.delete("etag");

        return new Response(rewritten, {
            status: response.status,
            statusText: response.statusText,
            headers,
        });
    }

    return response;
}
