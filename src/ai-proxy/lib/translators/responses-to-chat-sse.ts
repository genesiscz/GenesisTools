import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { createFoldedStreamState } from "@app/ai-proxy/lib/thinking-folded";
import {
    type ChatStreamDelta,
    createToolCallIndexState,
    translateResponsesStreamEvent,
} from "@app/ai-proxy/lib/translators/responses-stream-translator";
import type { ThinkingPresentationMode } from "@app/ai-proxy/lib/types";
import { type PipelineResult, pipelineResult } from "@app/ai-proxy/lib/usage/pipeline-result";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";

type JsonObject = Record<string, unknown>;

function chatChunk({
    model,
    delta,
    finishReason,
    usage,
}: {
    model: string;
    delta: ChatStreamDelta;
    finishReason?: string | null;
    usage?: JsonObject;
}) {
    const chunk: JsonObject = {
        id: "chatcmpl-ai-proxy",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    };

    if (usage) {
        chunk.usage = usage;
    }

    return SafeJSON.stringify(chunk);
}

export async function responsesToChatSse({
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

    if (!upstream.ok || !upstream.body) {
        return pipelineResult(upstream);
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
        return pipelineResult(upstream);
    }

    let resolveBody: (body: string) => void = () => {};
    const responseBody = new Promise<string>((resolve) => {
        resolveBody = resolve;
    });

    const stream = new ReadableStream({
        async start(controller) {
            const encoder = new TextEncoder();
            const reader = upstream.body?.getReader();
            let outboundBuffer = "";

            if (!reader) {
                resolveBody("");
                controller.close();
                return;
            }

            const initialChunk = `data: ${chatChunk({ model: proxyModel, delta: { role: "assistant" } })}\n\n`;
            outboundBuffer += initialChunk;
            controller.enqueue(encoder.encode(initialChunk));

            let buffer = "";
            let finishReason: string | null = null;
            let sentFinishReason = false;
            const decoder = new TextDecoder();
            const foldedState = thinkingMode === "folded" ? createFoldedStreamState() : undefined;
            const toolCallIndexState = createToolCallIndexState();
            let streamSucceeded = false;

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
                        if (!line.startsWith("data:")) {
                            continue;
                        }

                        const payload = line.slice(5).trim();
                        if (!payload || payload === "[DONE]") {
                            continue;
                        }

                        try {
                            const event = SafeJSON.parse(payload, { strict: true }) as JsonObject;
                            const translated = translateResponsesStreamEvent({
                                event,
                                thinkingMode,
                                foldedState,
                                toolCallIndexState,
                            });

                            if (!translated) {
                                continue;
                            }

                            if (translated.finishReason !== undefined) {
                                finishReason = translated.finishReason;
                            }

                            if (translated.delta && Object.keys(translated.delta).length > 0) {
                                const chunk = `data: ${chatChunk({
                                    model: proxyModel,
                                    delta: translated.delta,
                                    usage: translated.usage,
                                })}\n\n`;
                                outboundBuffer += chunk;
                                controller.enqueue(encoder.encode(chunk));
                            } else if (translated.finishReason !== undefined) {
                                const chunk = `data: ${chatChunk({
                                    model: proxyModel,
                                    delta: {},
                                    finishReason: translated.finishReason,
                                    usage: translated.usage,
                                })}\n\n`;
                                outboundBuffer += chunk;
                                controller.enqueue(encoder.encode(chunk));
                                sentFinishReason = true;
                            }
                        } catch (err) {
                            logger.debug({ err, payloadPreview: payload.slice(0, 120) }, "ai-proxy: skipped SSE event");
                        }
                    }
                }

                buffer += decoder.decode();

                if (!sentFinishReason) {
                    const finalChunk = `data: ${chatChunk({
                        model: proxyModel,
                        delta: {},
                        finishReason: finishReason ?? "stop",
                    })}\n\n`;
                    outboundBuffer += finalChunk;
                    controller.enqueue(encoder.encode(finalChunk));
                }

                outboundBuffer += "data: [DONE]\n\n";
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                streamSucceeded = true;
            } catch (err) {
                logger.warn({ err, model: proxyModel }, "ai-proxy: SSE stream failed");
                controller.error(err);
            } finally {
                resolveBody(outboundBuffer);

                if (streamSucceeded) {
                    controller.close();
                }
            }
        },
    });

    return pipelineResult(
        new Response(stream, {
            status: 200,
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            },
        }),
        responseBody
    );
}
