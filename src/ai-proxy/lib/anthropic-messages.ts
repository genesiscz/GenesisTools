import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { safeStreamControllerError } from "@app/ai-proxy/lib/safe-stream-controller";
import { withSseKeepalive } from "@app/ai-proxy/lib/sse-keepalive";
import { normalizeAnthropicToOpenAI } from "@app/ai-proxy/lib/translators/formats/anthropic/normalize";
import {
    type AnthropicStreamState,
    anthropicStreamChunk,
    anthropicStreamEnd,
    anthropicStreamStart,
    createAnthropicStreamState,
    openAiCompletionToAnthropicMessage,
} from "@app/ai-proxy/lib/translators/formats/anthropic/openai-to-anthropic-responses";
import { type CallTimeline, TimelineCollector } from "@app/ai-proxy/lib/usage/call-timeline";
import { captureResponseBody } from "@app/ai-proxy/lib/usage/capture-response";
import { type PipelineResult, pipelineResult } from "@app/ai-proxy/lib/usage/pipeline-result";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import { type ProfilerScope, profiler } from "@genesiscz/utils/profile";
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

/** Anthropic's own cadence through quiet stretches of a stream. */
const PING_INTERVAL_MS = 10_000;

/** Matches the transcript's own text cap — capturing more than it stores is waste. */
const CLIENT_CAPTURE_MAX_CHARS = 1_000_000;

export interface AnthropicMessagesResult extends PipelineResult {
    /** The translated request body, for the usage row (the client's body is Anthropic-shaped). */
    openAiBodyText: string;
    /** The Anthropic frames the client actually received, for triage. */
    clientResponseBody: Promise<string>;
}

function errorResponse(status: number, message: string, type = "invalid_request_error"): Response {
    return new Response(SafeJSON.stringify({ type: "error", error: { type, message } }), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

/** The failure triple every error path needs: pipeline result from a clone, client body from the original. */
function errorPipelineResult(
    failure: Response,
    rawText: string,
    startedAt: number | undefined,
    timeline: Promise<CallTimeline>
): PipelineResult & { clientResponseBody: Promise<string> } {
    return {
        ...pipelineResult(failure.clone(), rawText, startedAt, timeline),
        clientResponseBody: failure.text(),
    };
}

/**
 * Anthropic's `max_tokens` is required and Claude Code sends a large one; the
 * OpenAI field name differs per upstream, so both are set and providers drop
 * whichever they reject.
 */
export function anthropicBodyToOpenAiBody(parsed: Record<string, unknown>, upstreamModel: string): string {
    // A spread is SHALLOW, so `body.messages` was the caller's own array and
    // `normalizeAnthropicToOpenAI` unshifted the system turn straight into it.
    // Calling this twice on one body produced two system messages, and the
    // transcript capture recorded a request nobody had actually sent.
    const body: Record<string, unknown> = structuredClone(parsed);

    normalizeAnthropicToOpenAI(body);

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
    prof,
    startedAt,
}: {
    provider: ProxyProvider;
    upstreamModel: string;
    proxyModel: string;
    req: Request;
    openAiBodyText: string;
    prof: ProfilerScope;
    startedAt?: number;
}): Promise<PipelineResult & { clientResponseBody: Promise<string> }> {
    const collector = new TimelineCollector(startedAt ?? performance.now());
    const endDispatch = prof.start("messages.upstream-dispatch");
    const upstream = await provider.chatCompletions(req, upstreamModel, openAiBodyText);
    collector.markUpstreamHeaders();
    endDispatch();

    const endBody = prof.start("messages.upstream-body");
    const rawText = await upstream.text();
    endBody();
    collector.push(rawText);
    const timeline = Promise.resolve(collector.finish());

    if (!upstream.ok) {
        return errorPipelineResult(
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
        const clientText = SafeJSON.stringify(message) ?? "";

        return {
            ...pipelineResult(
                new Response(clientText, { status: 200, headers: { "Content-Type": "application/json" } }),
                rawText,
                startedAt,
                timeline
            ),
            clientResponseBody: Promise.resolve(clientText),
        };
    } catch (err) {
        logger.warn({ err, proxyModel, upstreamModel }, "ai-proxy: /v1/messages JSON translation failed");

        return errorPipelineResult(
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
    prof,
    startedAt,
}: {
    provider: ProxyProvider;
    upstreamModel: string;
    proxyModel: string;
    req: Request;
    openAiBodyText: string;
    fallbackInputTokens: number;
    prof: ProfilerScope;
    startedAt?: number;
}): Promise<PipelineResult & { clientResponseBody: Promise<string> }> {
    const collector = new TimelineCollector(startedAt ?? performance.now());
    const endDispatch = prof.start("messages.upstream-dispatch");
    const upstream = await provider.chatCompletions(req, upstreamModel, openAiBodyText);
    collector.markUpstreamHeaders();
    endDispatch();

    if (!upstream.ok || !upstream.body) {
        const rawText = await upstream.text();
        collector.push(rawText);

        return errorPipelineResult(
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

    let resolveClientBody: (body: string) => void = () => {};
    const clientResponseBody = new Promise<string>((resolve) => {
        resolveClientBody = resolve;
    });

    let resolveTimeline: (timeline: CallTimeline) => void = () => {};
    const timeline = new Promise<CallTimeline>((resolve) => {
        resolveTimeline = resolve;
    });

    const upstreamBody = upstream.body;

    // Defense in depth, NOT a leak fix. Measured on Bun 1.3: a real client
    // disconnect fires `req.signal` abort AND this stream's `cancel()` about 1ms
    // apart, and every provider forwards `signal: req.signal` upstream, so the
    // read already rejects and the `finally` already clears the ping. This
    // handler covers the paths where only the body is cancelled (no signal
    // abort) and a provider that forgets to forward the signal.
    let abortUpstream: (reason?: unknown) => void = () => {};

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const encoder = new TextEncoder();
            const decoder = new TextDecoder();
            const reader = upstreamBody.getReader();
            const state: AnthropicStreamState = createAnthropicStreamState(proxyModel, fallbackInputTokens);
            // Three phases, so a slow turn can be attributed without argument:
            // how long the upstream stayed silent, how fast the client saw its
            // first CONTENT frame (the synthetic message_start does not count),
            // and how long the whole stream took.
            const endTtfb = prof.start("messages.upstream-ttfb");
            const endFirstContent = prof.start("messages.upstream-first-content");
            const endToClientFirstFrame = prof.start("messages.client-first-frame");
            const endStream = prof.start("messages.stream-total");
            let sawContent = false;
            let clientSawFirstFrame = false;
            let sawKeepalive = false;
            let endOfStream = false;

            // The usage layer books the UPSTREAM exchange, so the capture buffer
            // holds the OpenAI bytes we read, not the Anthropic bytes we write.
            let upstreamBuffer = "";
            let clientBuffer = "";
            let buffer = "";
            let streamSucceeded = false;

            const emit = (frames: string): void => {
                if (frames.length === 0) {
                    return;
                }

                // Bounded: this is a SECOND full copy of a stream the usage layer
                // already retains, and its only consumer (the transcript) caps
                // the text anyway. An unbounded copy made a long reply cost twice
                // its own size in memory for no extra recorded detail.
                if (clientBuffer.length < CLIENT_CAPTURE_MAX_CHARS) {
                    clientBuffer += frames;
                }

                controller.enqueue(encoder.encode(frames));
            };

            // The real Anthropic API opens with message_start before the model has
            // produced anything, and Claude Code renders nothing until it arrives.
            // Emitting it lazily on the first content delta meant a reasoning model
            // that thinks for 40s looked completely dead for 40s.
            emit(anthropicStreamStart(state));

            // Anthropic sends `ping` through quiet stretches. Grok's first byte lands
            // ~16s in and thinking can run a further 20s; without traffic the client
            // (and any proxy in between) is free to treat that silence as a dead
            // connection.
            const ping = setInterval(() => {
                try {
                    emit('event: ping\ndata: {"type":"ping"}\n\n');
                } catch (err) {
                    logger.debug({ err }, "ai-proxy: /v1/messages ping enqueue failed (stream closing)");
                    // The controller is gone; retrying every 10s only logs.
                    abortUpstream(err);
                }
            }, PING_INTERVAL_MS);

            abortUpstream = (reason?: unknown): void => {
                clearInterval(ping);
                reader.cancel(reason).catch((err) => {
                    logger.debug({ err, model: proxyModel }, "ai-proxy: /v1/messages upstream cancel failed");
                });
            };

            try {
                while (true) {
                    const { done, value } = await reader.read();

                    // A stream can end WITHOUT a trailing newline, leaving a whole
                    // `data:` frame in `buffer`. Breaking out here discarded it and
                    // truncated the reply mid-word — the user saw sentences cut off
                    // ("...deleting client.ts, session.ts, oauthEnv."). Instead, flush
                    // the decoder, terminate the residual line and let the SAME parsing
                    // below consume it. The reference translator has always done this
                    // (anthropic-to-openai-completions.ts:299-303).
                    if (done) {
                        const tail = decoder.decode();

                        if (tail.length > 0) {
                            upstreamBuffer += tail;
                            buffer += tail;
                            collector.push(tail);
                        }

                        if (buffer.trim().length === 0) {
                            break;
                        }

                        buffer += "\n";
                        endOfStream = true;
                    }

                    const text = done ? "" : decoder.decode(value, { stream: true });

                    if (text.length > 0 && upstreamBuffer.length === 0) {
                        // The number that settles "is it us or them": everything before
                        // this is the upstream thinking, everything after is our translation.
                        endTtfb();
                    }

                    upstreamBuffer += text;
                    buffer += text;
                    if (text.length > 0) {
                        // The timeline parser reads OpenAI `choices[0].delta` frames, so
                        // it gets the upstream bytes — the same ones the usage row books.
                        collector.push(text);
                    }

                    const lines = buffer.split("\n");
                    buffer = lines.pop() ?? "";

                    for (const line of lines) {
                        const trimmed = line.trimStart();

                        if (!trimmed.startsWith("data:")) {
                            // An SSE comment. Upstream sends `: keepalive` while it has
                            // nothing yet, which is the signature of a stalled turn.
                            if (trimmed.startsWith(":") && !sawKeepalive && !sawContent) {
                                sawKeepalive = true;
                                logger.debug(
                                    { model: proxyModel, comment: trimmed.slice(0, 40) },
                                    "ai-proxy: upstream sent an SSE keepalive before any content"
                                );
                            }

                            continue;
                        }

                        const payload = trimmed.slice("data:".length).trim();

                        if (payload.length === 0 || payload === "[DONE]") {
                            continue;
                        }

                        try {
                            const chunk = SafeJSON.parse(payload, { strict: true });

                            if (isObject(chunk)) {
                                const frames = anthropicStreamChunk(state, chunk);

                                // `upstream-ttfb` above stops on the first byte of ANY
                                // kind, and an idle upstream sends `: keepalive` comments
                                // that carry no model output — so a stall could otherwise
                                // read as a fast first byte. This stops on the first byte
                                // that actually renders.
                                const firstContent = frames.length > 0 && !sawContent;

                                if (firstContent) {
                                    sawContent = true;
                                    endFirstContent();
                                }

                                emit(frames);

                                // The client-facing half of the same first-content
                                // moment, taken AFTER the enqueue. Ending this phase
                                // on any first frame made it stop at the synthetic
                                // message_start, which is emitted immediately — the
                                // column always read ~0ms and meant nothing.
                                if (firstContent) {
                                    clientSawFirstFrame = true;
                                    endToClientFirstFrame();
                                }
                            }
                        } catch (err) {
                            logger.debug(
                                { err, payloadPreview: payload.slice(0, 120) },
                                "ai-proxy: /v1/messages skipped an unparseable upstream SSE line"
                            );
                        }
                    }

                    if (endOfStream) {
                        break;
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
                clearInterval(ping);

                if (!sawContent) {
                    // Never fired in the loop; stop it here so the timer is not left
                    // dangling and the stat reflects the full, contentless turn.
                    endFirstContent();
                }

                if (!clientSawFirstFrame) {
                    endToClientFirstFrame();
                }

                endStream();
                resolveBody(upstreamBuffer);
                resolveClientBody(clientBuffer);
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
        cancel(reason) {
            logger.debug({ reason, model: proxyModel }, "ai-proxy: /v1/messages client cancelled — releasing upstream");
            abortUpstream(reason);
        },
    });

    return {
        ...pipelineResult(
            new Response(stream, { status: 200, headers: sseHeaders() }),
            responseBody,
            startedAt,
            timeline
        ),
        clientResponseBody,
    };
}

/**
 * No translation at all: the client's Anthropic bytes go up, the upstream's
 * Anthropic bytes come back.
 *
 * Usage tracking still books the exchange, but the bodies here are Anthropic on
 * BOTH sides, so they are recorded as the client exchange rather than fed to the
 * OpenAI-shaped usage parser, which would read them as empty.
 */
async function anthropicPassthrough({
    provider,
    upstreamModel,
    req,
    bodyText,
    prof,
    startedAt,
}: {
    provider: ProxyProvider;
    upstreamModel: string;
    req: Request;
    bodyText: string;
    prof: ProfilerScope;
    startedAt?: number;
}): Promise<AnthropicMessagesResult> {
    const collector = new TimelineCollector(startedAt ?? performance.now());
    const endDispatch = prof.start("messages.passthrough-dispatch");
    const upstream = await provider.messages?.(req, upstreamModel, bodyText);
    collector.markUpstreamHeaders();
    endDispatch();

    if (!upstream) {
        throw new Error("provider.messages disappeared between the capability check and the call");
    }

    const captured = captureResponseBody(upstream, startedAt);

    return {
        response: withSseKeepalive(captured.response),
        responseBody: captured.responseBody,
        timeline: captured.timeline,
        captureFailure: captured.captureFailure,
        openAiBodyText: bodyText,
        clientResponseBody: captured.responseBody,
    };
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
    const prof = profiler.scope("ai-proxy");
    const parsed = SafeJSON.parse(bodyText, { strict: true });

    if (!isObject(parsed)) {
        throw new Error("Request body must be a JSON object");
    }

    const wantsStream = parsed.stream === true;

    // Both ends already speak Anthropic: translating down to OpenAI and back
    // would only lose fields OpenAI cannot carry. Forward untouched.
    if (provider.messages) {
        return anthropicPassthrough({ provider, upstreamModel, req, bodyText, prof, startedAt });
    }

    const openAiBodyText = prof.measure("messages.translate-request", () =>
        anthropicBodyToOpenAiBody(parsed, upstreamModel)
    );

    const result = wantsStream
        ? await messagesSse({
              provider,
              upstreamModel,
              proxyModel,
              req,
              openAiBodyText,
              fallbackInputTokens: countAnthropicInputTokens(bodyText),
              prof,
              startedAt,
          })
        : await messagesJson({ provider, upstreamModel, proxyModel, req, openAiBodyText, prof, startedAt });

    return { ...result, openAiBodyText };
}
