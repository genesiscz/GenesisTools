import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { safeStreamControllerError } from "@app/ai-proxy/lib/safe-stream-controller";
import { normalizeAnthropicToOpenAI } from "@app/ai-proxy/lib/translators/formats/anthropic/normalize";
import {
    type AnthropicStreamState,
    anthropicStreamChunk,
    anthropicStreamEnd,
    createAnthropicStreamState,
    openAiCompletionToAnthropicMessage,
} from "@app/ai-proxy/lib/translators/formats/anthropic/openai-to-anthropic-responses";
import { type CallTimeline, TimelineCollector } from "@app/ai-proxy/lib/usage/call-timeline";
import { type PipelineResult, pipelineResult } from "@app/ai-proxy/lib/usage/pipeline-result";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import { estimateTokens } from "@genesiscz/utils/tokens";

/**
 * The Anthropic-native inbound surface: `POST /v1/messages`, the API Claude Code
 * speaks. The proxy's providers all speak OpenAI chat/completions, so a request
 * is normalized down on the way in and translated back up on the way out.
 *
 * Usage tracking sees the OPENAI-shaped exchange (`openAiBodyText` plus the raw
 * upstream bytes), not the Anthropic frames the client gets — that keeps the
 * whole usage/billing layer on the single shape it already parses.
 */

export interface AnthropicMessagesResult extends PipelineResult {
    /** The translated request body, for the usage row (the client's body is Anthropic-shaped). */
    openAiBodyText: string;
}

function errorResponse(status: number, message: string, type = "invalid_request_error"): Response {
    return new Response(SafeJSON.stringify({ type: "error", error: { type, message } }), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

/**
 * Anthropic's `max_tokens` is required and Claude Code sends a large one; the
 * OpenAI field name differs per upstream, so both are set and providers drop
 * whichever they reject.
 */
export function anthropicBodyToOpenAiBody(parsed: Record<string, unknown>, upstreamModel: string): string {
    const body: Record<string, unknown> = { ...parsed };

    normalizeAnthropicToOpenAI(body, /claude/i.test(upstreamModel));

    body.model = upstreamModel;

    return SafeJSON.stringify(body);
}

function sseHeaders(): Record<string, string> {
    return {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        // Same undici keep-alive-reuse hazard as every other SSE path here.
        Connection: "close",
        "X-Accel-Buffering": "no",
    };
}

/**
 * `POST /v1/messages/count_tokens`. Claude Code calls this before every turn to
 * draw its context meter, and a 404 there makes the session look broken. No
 * upstream in this proxy exposes a token counter, so this is the same ~4 chars
 * per token heuristic the usage estimator already uses.
 */
export function countAnthropicInputTokens(bodyText: string): number {
    const sink: string[] = [];

    try {
        const parsed = SafeJSON.parse(bodyText, { strict: true });

        if (!isObject(parsed)) {
            return estimateTokens(bodyText);
        }

        collectText(parsed.system, sink);
        collectText(parsed.messages, sink);
        collectText(parsed.tools, sink);
    } catch (err) {
        logger.debug({ err }, "ai-proxy: count_tokens body parse failed, falling back to raw length");
        return estimateTokens(bodyText);
    }

    return estimateTokens(sink.join("\n"));
}

function collectText(value: unknown, sink: string[]): void {
    if (typeof value === "string") {
        sink.push(value);
        return;
    }

    if (Array.isArray(value)) {
        for (const entry of value) {
            collectText(entry, sink);
        }

        return;
    }

    if (isObject(value)) {
        for (const entry of Object.values(value)) {
            collectText(entry, sink);
        }
    }
}

async function messagesJson({
    provider,
    upstreamModel,
    proxyModel,
    req,
    openAiBodyText,
    startedAt,
}: {
    provider: ProxyProvider;
    upstreamModel: string;
    proxyModel: string;
    req: Request;
    openAiBodyText: string;
    startedAt?: number;
}): Promise<PipelineResult> {
    const collector = new TimelineCollector(startedAt ?? performance.now());
    const upstream = await provider.chatCompletions(req, upstreamModel, openAiBodyText);
    collector.markUpstreamHeaders();

    const rawText = await upstream.text();
    collector.push(rawText);
    const timeline = Promise.resolve(collector.finish());

    if (!upstream.ok) {
        return pipelineResult(
            errorResponse(upstream.status, `Upstream ${upstream.status}: ${rawText.slice(0, 500)}`, "api_error"),
            rawText,
            startedAt,
            timeline
        );
    }

    try {
        const parsed = SafeJSON.parse(rawText, { strict: true });

        if (!isObject(parsed)) {
            throw new Error("upstream body was not a JSON object");
        }

        const message = openAiCompletionToAnthropicMessage(parsed, { model: proxyModel });

        return pipelineResult(
            new Response(SafeJSON.stringify(message), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            }),
            rawText,
            startedAt,
            timeline
        );
    } catch (err) {
        logger.warn({ err, proxyModel, upstreamModel }, "ai-proxy: /v1/messages JSON translation failed");

        return pipelineResult(
            errorResponse(502, "Upstream returned a body the Anthropic translator could not read.", "api_error"),
            rawText,
            startedAt,
            timeline
        );
    }
}

async function messagesSse({
    provider,
    upstreamModel,
    proxyModel,
    req,
    openAiBodyText,
    fallbackInputTokens,
    startedAt,
}: {
    provider: ProxyProvider;
    upstreamModel: string;
    proxyModel: string;
    req: Request;
    openAiBodyText: string;
    fallbackInputTokens: number;
    startedAt?: number;
}): Promise<PipelineResult> {
    const collector = new TimelineCollector(startedAt ?? performance.now());
    const upstream = await provider.chatCompletions(req, upstreamModel, openAiBodyText);
    collector.markUpstreamHeaders();

    if (!upstream.ok || !upstream.body) {
        const rawText = await upstream.text();
        collector.push(rawText);

        return pipelineResult(
            errorResponse(
                upstream.ok ? 502 : upstream.status,
                `Upstream ${upstream.status}: ${rawText.slice(0, 500)}`,
                "api_error"
            ),
            rawText,
            startedAt,
            Promise.resolve(collector.finish())
        );
    }

    let resolveBody: (body: string) => void = () => {};
    const responseBody = new Promise<string>((resolve) => {
        resolveBody = resolve;
    });

    let resolveTimeline: (timeline: CallTimeline) => void = () => {};
    const timeline = new Promise<CallTimeline>((resolve) => {
        resolveTimeline = resolve;
    });

    const upstreamBody = upstream.body;

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const encoder = new TextEncoder();
            const decoder = new TextDecoder();
            const reader = upstreamBody.getReader();
            const state: AnthropicStreamState = createAnthropicStreamState(proxyModel, fallbackInputTokens);

            // The usage layer books the UPSTREAM exchange, so the capture buffer
            // holds the OpenAI bytes we read, not the Anthropic bytes we write.
            let upstreamBuffer = "";
            let buffer = "";
            let streamSucceeded = false;

            const emit = (frames: string): void => {
                if (frames.length === 0) {
                    return;
                }

                controller.enqueue(encoder.encode(frames));
            };

            try {
                while (true) {
                    const { done, value } = await reader.read();

                    if (done) {
                        break;
                    }

                    const text = decoder.decode(value, { stream: true });
                    upstreamBuffer += text;
                    buffer += text;
                    // The timeline parser reads OpenAI `choices[0].delta` frames, so it
                    // gets the upstream bytes — the same ones the usage row books.
                    collector.push(text);

                    const lines = buffer.split("\n");
                    buffer = lines.pop() ?? "";

                    for (const line of lines) {
                        const trimmed = line.trimStart();

                        if (!trimmed.startsWith("data:")) {
                            continue;
                        }

                        const payload = trimmed.slice("data:".length).trim();

                        if (payload.length === 0 || payload === "[DONE]") {
                            continue;
                        }

                        try {
                            const chunk = SafeJSON.parse(payload, { strict: true });

                            if (isObject(chunk)) {
                                emit(anthropicStreamChunk(state, chunk));
                            }
                        } catch (err) {
                            logger.debug(
                                { err, payloadPreview: payload.slice(0, 120) },
                                "ai-proxy: /v1/messages skipped an unparseable upstream SSE line"
                            );
                        }
                    }
                }

                emit(anthropicStreamEnd(state));
                streamSucceeded = true;
            } catch (err) {
                logger.warn({ err, model: proxyModel }, "ai-proxy: /v1/messages SSE stream failed");

                if (!safeStreamControllerError(controller, err, streamSucceeded)) {
                    logger.debug(
                        { err, model: proxyModel, streamSucceeded },
                        "ai-proxy: /v1/messages skipped controller.error (client abort or detached)"
                    );
                }
            } finally {
                resolveBody(upstreamBuffer);
                resolveTimeline(collector.finish());

                if (streamSucceeded) {
                    try {
                        controller.close();
                    } catch (controllerErr) {
                        logger.warn(
                            { err: controllerErr, model: proxyModel },
                            "ai-proxy: /v1/messages controller.close() threw — client likely disconnected"
                        );
                    }
                }
            }
        },
    });

    return pipelineResult(
        new Response(stream, { status: 200, headers: sseHeaders() }),
        responseBody,
        startedAt,
        timeline
    );
}

export async function anthropicMessagesPipeline({
    provider,
    upstreamModel,
    proxyModel,
    req,
    bodyText,
    startedAt,
}: {
    provider: ProxyProvider;
    upstreamModel: string;
    proxyModel: string;
    req: Request;
    bodyText: string;
    /** performance.now() taken when the proxy received the request (timeline anchor). */
    startedAt?: number;
}): Promise<AnthropicMessagesResult> {
    const parsed = SafeJSON.parse(bodyText, { strict: true });

    if (!isObject(parsed)) {
        throw new Error("Request body must be a JSON object");
    }

    const wantsStream = parsed.stream === true;
    const openAiBodyText = anthropicBodyToOpenAiBody(parsed, upstreamModel);

    const result = wantsStream
        ? await messagesSse({
              provider,
              upstreamModel,
              proxyModel,
              req,
              openAiBodyText,
              fallbackInputTokens: countAnthropicInputTokens(bodyText),
              startedAt,
          })
        : await messagesJson({ provider, upstreamModel, proxyModel, req, openAiBodyText, startedAt });

    return { ...result, openAiBodyText };
}
