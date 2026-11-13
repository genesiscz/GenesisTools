import { anthropicMessagesPipeline, countAnthropicInputTokens } from "@app/ai-proxy/lib/anthropic-messages";
import { handleAudioTranscriptions } from "@app/ai-proxy/lib/audio";
import { buildProxyModelCatalog } from "@app/ai-proxy/lib/catalog";
import { resolveClient, sessionKeyRejection, validateClients } from "@app/ai-proxy/lib/clients";
import { loadConfigFresh } from "@app/ai-proxy/lib/config";
import { stripBasePath } from "@app/ai-proxy/lib/path-prefix";
import { buildProviderMap } from "@app/ai-proxy/lib/providers/pool";
import { configureModelFacts } from "@app/ai-proxy/lib/providers/registry";
import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { handleRealtimeClientSecrets, handleRealtimeUpgrade, realtimeWebsocket } from "@app/ai-proxy/lib/realtime";
import {
    anthropicEnvelope,
    BODY_UNREADABLE_MESSAGE,
    logRequestFailure,
    type ModelDoor,
    type ModelRequestBody,
    openAiEnvelope,
    parseModelBody,
    readRequestText,
    serveModelDoor,
} from "@app/ai-proxy/lib/request-lifecycle";
import { applyReasoningEffortToBody } from "@app/ai-proxy/lib/rewrite-upstream-body";
import { messageToAnthropicSse } from "@app/ai-proxy/lib/server-tools/web-search";
import { sweepBackgroundCompactions } from "@app/ai-proxy/lib/sessions/background-compaction";
import { sweepCompactions } from "@app/ai-proxy/lib/sessions/codex-compaction";
import { sessionLaunchLimit, sessionPickerGroups, sessionPickerModels } from "@app/ai-proxy/lib/sessions/picker-models";
import { DEFAULT_SESSION_RETENTION_DAYS, sweepSessionRecords } from "@app/ai-proxy/lib/sessions/records";
import { resolveThinkingMode } from "@app/ai-proxy/lib/thinking-config";
import { resolveTranslationMode } from "@app/ai-proxy/lib/translation-config";
import { handleChatCompletions } from "@app/ai-proxy/lib/translators";
import { modelProbeReply } from "@app/ai-proxy/lib/translators/formats/anthropic/claude-code-turns";
import { identityPipeline } from "@app/ai-proxy/lib/translators/identity-pipeline";
import type { AiProxyConfig, EffortSource, ResolvedRoute, ThinkingPresentationMode } from "@app/ai-proxy/lib/types";
import { prefixDiffFor } from "@app/ai-proxy/lib/usage/prefix-diff";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

export interface ServeRuntimeOptions {
    translateCursor?: AiProxyConfig["translation"]["cursorAgent"];
    thinking?: ThinkingPresentationMode;
    noTranslate?: boolean;
}

export interface AiProxyRuntime {
    config: AiProxyConfig;
    providers: Map<string, ProxyProvider>;
    serveOptions: ServeRuntimeOptions;
}

export async function createRuntime(
    config: AiProxyConfig,
    serveOptions: ServeRuntimeOptions = {}
): Promise<AiProxyRuntime> {
    const providers = await buildProviderMap(config.accounts);

    return { config, providers, serveOptions };
}

function normalizePath(pathname: string, basePath?: string): string {
    const stripped = stripBasePath(pathname, basePath);

    if (stripped.startsWith("/openai/v1/")) {
        return `/v1/${stripped.slice("/openai/v1/".length)}`;
    }

    return stripped;
}

/** The effort a `/v1/messages` request asked for, and from where: the id's suffix wins over the client's setting. */
function requestEffort(route: ResolvedRoute, body: ModelRequestBody): { effort?: string; effortSource: EffortSource } {
    if (route.reasoningEffort) {
        return { effort: route.reasoningEffort, effortSource: "suffix" };
    }

    return body.clientEffort ? { effort: body.clientEffort, effortSource: "client" } : { effortSource: "default" };
}

/**
 * `/v1/messages`: Claude Code and the Anthropic SDKs. A provider without a Messages endpoint gets the body translated
 * both ways (anthropic-messages.ts).
 */
const messagesDoor: ModelDoor<ModelRequestBody> = {
    name: "messages",
    envelope: anthropicEnvelope,
    parse: parseModelBody,
    async run({ req, config, body, bodyText, client, session, route, provider, startedAt, record }) {
        const { model } = body;

        // Answered here once the route and its account check passed: forwarding it would run a whole
        // Codex turn (WHAM ignores the one-token cap) inside the probe's 15 s, for an answer nobody reads.
        if (client.session && body.probe) {
            logger.info(
                { model, account: route.accountName, session: session?.id },
                "ai-proxy: answered Claude Code's model_validation probe"
            );
            const reply = modelProbeReply(model);

            return body.stream
                ? new Response(messageToAnthropicSse(reply), { headers: { "Content-Type": "text/event-stream" } })
                : new Response(SafeJSON.stringify(reply), { headers: { "Content-Type": "application/json" } });
        }

        const effort = requestEffort(route, body);

        // Stamped on the Anthropic body: normalizeAnthropicToOpenAI keeps
        // reasoning_effort, so it rides through to the OpenAI body the
        // provider forwards. Without this, an
        // id like martin/grok/grok-4.6:xhigh would honour its effort suffix on
        // /v1/chat/completions but silently ignore it for Claude Code.
        //
        // On the translated path, and on passthroughs whose upstream
        // tolerates the field (grok's CLI proxy — otherwise the suffix
        // was silently inert on exactly the door Claude Code uses).
        // Never for a real Anthropic Messages endpoint, where
        // `reasoning_effort` is not a field — stamping it there sends an
        // OpenAI-ism to api.anthropic.com and risks a 400 on every
        // effort-suffixed request.
        const translatesToOpenAi = !provider.messages;
        const stampEffort = translatesToOpenAi || provider.messagesAcceptsReasoningEffort === true;
        const routedBody = stampEffort ? applyReasoningEffortToBody(bodyText, route.reasoningEffort) : bodyText;

        if (route.reasoningEffort && !stampEffort) {
            logger.debug(
                { proxyModel: model, provider: provider.id, effort: route.reasoningEffort },
                "ai-proxy: dropped the effort suffix — this provider passes the Anthropic body through"
            );
        }

        const { response, responseBody, timeline, openAiBodyText, clientResponseBody, captureFailure, promptCacheKey } =
            await anthropicMessagesPipeline({
                startedAt,
                provider,
                upstreamModel: route.upstreamId,
                proxyModel: model,
                req,
                bodyText: routedBody,
                cacheKeyPolicy: session?.cacheKeyPolicy,
                recordId: session?.id,
                sessionAgents: session?.agents,
                sessionsIn: config.sessionsIn,
            });

        // The usage layer only parses the OpenAI shape, and the exchange it
        // should book is the one the upstream actually saw. The Anthropic
        // pair rides along separately so a translation bug is visible in the
        // transcript instead of only in the client's UI.
        record({
            upstreamBody: openAiBodyText,
            clientRequestBody: routedBody,
            responseBody,
            clientResponseBody,
            timeline,
            translate: "anthropic",
            // A stream that stalled and was cut short is not a
            // success; the other two routes already forward this.
            captureFailure,
            cacheKey: promptCacheKey?.key,
            compaction: body.compaction,
            ...effort,
            prefix: prefixDiffFor(req),
            logFields: {
                // The whole key: a session id or a content hash, never a secret, and the only place the
                // log can be joined with Claude Code's own transcript and the upstream's cache.
                cacheKey: promptCacheKey ? `${promptCacheKey.key} (${promptCacheKey.source})` : undefined,
            },
        });

        return response;
    },
};

/** `/v1/responses`: forwarded as the client sent it, with the effort suffix stamped. */
const responsesDoor: ModelDoor<ModelRequestBody> = {
    name: "responses",
    envelope: openAiEnvelope,
    parse: parseModelBody,
    async run({ req, bodyText, route, provider, startedAt, record }) {
        const routedBody = applyReasoningEffortToBody(bodyText, route.reasoningEffort);
        const { response, responseBody, timeline, captureFailure } = await identityPipeline({
            startedAt,
            provider,
            upstreamModel: route.upstreamId,
            path: "responses",
            req,
            bodyText: routedBody,
        });

        record({
            upstreamBody: routedBody,
            responseBody,
            timeline,
            captureFailure,
            translate: "off",
            // Verbatim client bytes, pre effort-stamp. Without this
            // the 2026-08-19 field-loss audit could not quantify
            // anything on the OpenAI doors (0 of 3,068 recoverable).
            clientRequestBody: bodyText,
        });

        return response;
    },
};

/** `/v1/chat/completions`: the Cursor-agent translation and the thinking presentation follow config, flags and headers. */
function chatDoor(serveOptions: ServeRuntimeOptions): ModelDoor<ModelRequestBody> {
    return {
        name: "chat",
        envelope: openAiEnvelope,
        parse: parseModelBody,
        async run({ req, config, body, bodyText, route, provider, startedAt, record }) {
            const routedBody = applyReasoningEffortToBody(bodyText, route.reasoningEffort);
            const mode = resolveTranslationMode({
                configMode: config.translation.cursorAgent,
                flagMode: serveOptions.translateCursor,
                noTranslate: serveOptions.noTranslate,
                headerMode: req.headers.get("x-ai-proxy-translate"),
            });
            const thinkingMode = resolveThinkingMode({
                configMode: config.translation.thinking,
                flagMode: serveOptions.thinking,
                headerMode: req.headers.get("x-ai-proxy-thinking"),
                rules: config.translation.thinkingRules,
                userAgent: req.headers.get("user-agent"),
            });
            const { response, responseBody, timeline, captureFailure } = await handleChatCompletions({
                startedAt,
                mode,
                thinkingMode,
                provider,
                upstreamModel: route.upstreamId,
                proxyModel: body.model,
                req,
                bodyText: routedBody,
            });

            record({
                upstreamBody: routedBody,
                responseBody,
                timeline,
                captureFailure,
                translate: mode,
                thinking: thinkingMode,
                // Verbatim client bytes, pre effort-stamp — see the /v1/responses door.
                clientRequestBody: bodyText,
                logFields: { translate: mode, thinking: thinkingMode },
            });

            return response;
        },
    };
}

export function startAiProxyServer(runtime: AiProxyRuntime) {
    const clientProblems = validateClients(runtime.config.clients);

    if (clientProblems.length > 0) {
        throw new Error(`ai-proxy: invalid clients config — ${clientProblems.join("; ")}`);
    }

    try {
        sweepSessionRecords({ retentionDays: runtime.config.sessionRetentionDays });
        sweepCompactions(runtime.config.sessionRetentionDays ?? DEFAULT_SESSION_RETENTION_DAYS);
        sweepBackgroundCompactions(runtime.config.sessionRetentionDays ?? DEFAULT_SESSION_RETENTION_DAYS);
    } catch (err) {
        logger.warn({ err }, "ai-proxy: session sweep failed; records stay as they are");
    }

    const listen = runtime.config.listen;
    const modelDoors = new Map<string, ModelDoor<ModelRequestBody>>([
        ["/v1/messages", messagesDoor],
        ["/v1/chat/completions", chatDoor(runtime.serveOptions)],
        ["/v1/responses", responsesDoor],
    ]);

    return Bun.serve({
        hostname: listen.host,
        port: listen.port,
        // Bun's max (255s). Keepalive frames (see sse-keepalive.ts) normally keep
        // streams well under this; the high ceiling covers non-streaming replies
        // from reasoning models, which send nothing at all until they are done.
        idleTimeout: 255,
        websocket: realtimeWebsocket,
        async fetch(req, server) {
            const url = new URL(req.url);
            const path = normalizePath(url.pathname, runtime.config.public?.basePath);

            if (req.method === "GET" && (path === "/health" || path === "/v1/health")) {
                return new Response(SafeJSON.stringify({ status: "ok" }), {
                    headers: { "Content-Type": "application/json" },
                });
            }

            const config = await loadConfigFresh();
            configureModelFacts(config);

            // An unknown or closed session key is refused before any route runs, and never forwarded anywhere.
            const sessionRejection = sessionKeyRejection(req);

            if (sessionRejection) {
                logger.warn({ path, reason: sessionRejection }, "ai-proxy: session key refused");

                const envelope = path.startsWith("/v1/messages") ? anthropicEnvelope : openAiEnvelope;
                return envelope(403, sessionRejection, { type: "permission_error", code: "session_unknown" });
            }

            if (path === "/v1/realtime" && req.method === "GET") {
                return handleRealtimeUpgrade({ req, url, server, config, providers: runtime.providers });
            }

            if (path === "/v1/realtime/client_secrets" && req.method === "POST") {
                return handleRealtimeClientSecrets({ req, config, providers: runtime.providers });
            }

            if (path === "/v1/audio/transcriptions" && req.method === "POST") {
                return handleAudioTranscriptions({ req, config, providers: runtime.providers });
            }

            if (path === "/v1/models" && req.method === "GET") {
                const client = await resolveClient(req, config);

                if (!client) {
                    return openAiEnvelope(401, "Invalid proxy API key", { type: "auth_error" });
                }

                if (client.session) {
                    return new Response(
                        SafeJSON.stringify(
                            sessionPickerModels({
                                groups: sessionPickerGroups(client.session),
                                contextLimit: sessionLaunchLimit(client.session),
                            })
                        ),
                        {
                            headers: { "Content-Type": "application/json" },
                        }
                    );
                }

                const models = await buildProxyModelCatalog(config.accounts);

                return new Response(
                    SafeJSON.stringify({
                        object: "list",
                        data: models.map((model) => ({
                            id: model.proxyId,
                            object: model.object,
                            created: model.created,
                            owned_by: model.owned_by,
                            description: model.description,
                        })),
                    }),
                    { headers: { "Content-Type": "application/json" } }
                );
            }

            if (path === "/v1/messages/count_tokens" && req.method === "POST") {
                const client = await resolveClient(req, config);

                if (!client) {
                    return anthropicEnvelope(401, "Invalid proxy API key");
                }

                let countBody: string;

                try {
                    countBody = await readRequestText(req);
                } catch (err) {
                    logRequestFailure({ req, err, status: 400, fields: { path } });
                    return anthropicEnvelope(400, BODY_UNREADABLE_MESSAGE);
                }

                return new Response(SafeJSON.stringify({ input_tokens: countAnthropicInputTokens(countBody) }), {
                    headers: { "Content-Type": "application/json" },
                });
            }

            const door = req.method === "POST" ? modelDoors.get(path) : undefined;

            if (door) {
                return serveModelDoor(req, door, { config, providers: runtime.providers, path });
            }

            return new Response("Not Found", { status: 404 });
        },
    });
}
