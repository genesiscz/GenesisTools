import { resolveProxyRoute } from "@app/ai-proxy/lib/account-model-ref";
import { anthropicMessagesPipeline, countAnthropicInputTokens } from "@app/ai-proxy/lib/anthropic-messages";
import { handleAudioTranscriptions } from "@app/ai-proxy/lib/audio";
import { buildProxyModelCatalog } from "@app/ai-proxy/lib/catalog";
import {
    type ResolvedClient,
    resolveClient,
    routeDenial,
    sessionKeyRejection,
    validateClients,
} from "@app/ai-proxy/lib/clients";
import { listedCodexModels, setCodexModelOverrides } from "@app/ai-proxy/lib/codex-catalog";
import { loadConfigFresh } from "@app/ai-proxy/lib/config";
import { stripBasePath } from "@app/ai-proxy/lib/path-prefix";
import { acquireProvider, buildProviderMap, providerUnavailableResponse } from "@app/ai-proxy/lib/providers/registry";
import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { handleRealtimeClientSecrets, handleRealtimeUpgrade, realtimeWebsocket } from "@app/ai-proxy/lib/realtime";
import { applyReasoningEffortToBody, findInvalidImageDataPayload } from "@app/ai-proxy/lib/rewrite-upstream-body";
import { messageToAnthropicSse } from "@app/ai-proxy/lib/server-tools/web-search";
import { sweepCompactions } from "@app/ai-proxy/lib/sessions/codex-compaction";
import { recordCompactionEvent } from "@app/ai-proxy/lib/sessions/compaction-events";
import { sessionPickerModels } from "@app/ai-proxy/lib/sessions/picker-models";
import {
    DEFAULT_SESSION_RETENTION_DAYS,
    noteSessionRequest,
    sweepSessionRecords,
} from "@app/ai-proxy/lib/sessions/records";
import { resolveSessionRoute, sessionPinnedRoute } from "@app/ai-proxy/lib/sessions/routing";
import { setClaudeSessionSettings } from "@app/ai-proxy/lib/sessions/settings";
import { requestTagsFor } from "@app/ai-proxy/lib/sessions/tags";
import { resolveThinkingMode } from "@app/ai-proxy/lib/thinking-config";
import { resolveTranslationMode } from "@app/ai-proxy/lib/translation-config";
import { handleChatCompletions } from "@app/ai-proxy/lib/translators";
import { ClaudeCodeTurn, modelProbeReply } from "@app/ai-proxy/lib/translators/formats/anthropic/claude-code-turns";
import { identityPipeline } from "@app/ai-proxy/lib/translators/identity-pipeline";
import type { AiProxyConfig, EffortSource, ResolvedRoute, ThinkingPresentationMode } from "@app/ai-proxy/lib/types";
import { scheduleBillingSync } from "@app/ai-proxy/lib/usage/billing-sync";
import type { CallTimeline } from "@app/ai-proxy/lib/usage/call-timeline";
import { checkClientQuota } from "@app/ai-proxy/lib/usage/client-ledger";
import { type PrefixDiff, prefixDiffFor } from "@app/ai-proxy/lib/usage/prefix-diff";
import { scheduleUsageTracking } from "@app/ai-proxy/lib/usage/track-response";
import type { RequestTags } from "@app/ai-proxy/lib/usage/types";
import { CopilotAuthExpiredError } from "@genesiscz/utils/ai/github-copilot";
import { GrokAuthExpiredError } from "@genesiscz/utils/ai/grok";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Logs a request that threw. When the client already hung up (Claude Code quit or was interrupted), the upstream
 * fetch fails with "The connection was closed": that is the client's choice, logged at debug as 499, not a 502
 * warning (on 2026-10-27 every resume of a ccx session left one in the warn log).
 */
export function logRequestFailure(input: {
    req: Request;
    err: unknown;
    status: number;
    fields: Record<string, unknown>;
}): void {
    if (input.req.signal.aborted) {
        logger.debug({ ...input.fields, status: 499, error: input.err }, "ai-proxy: the client closed the request");
        return;
    }

    logger.warn({ ...input.fields, status: input.status, error: input.err }, "ai-proxy: request failed");
}

function mapProxyRequestError(err: unknown): { status: number; message: string } {
    if (err instanceof GrokAuthExpiredError || err instanceof CopilotAuthExpiredError) {
        return {
            status: 502,
            message: "Upstream provider auth expired or invalid — the ai-proxy host must refresh its login.",
        };
    }

    const message = err instanceof Error ? err.message : String(err);

    if (
        message.startsWith("Model id must be") ||
        message.startsWith("No enabled account for model") ||
        message.startsWith("Ambiguous model")
    ) {
        return { status: 400, message };
    }

    return { status: 502, message: "Request failed" };
}

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

function trackProxyRequest(input: {
    runtime: AiProxyRuntime;
    route: ResolvedRoute;
    client: string;
    proxyModel: string;
    path: string;
    status: number;
    elapsedMs: number;
    bodyText: string;
    responseBody: Promise<string>;
    timeline?: Promise<CallTimeline>;
    captureFailure?: Promise<string | undefined>;
    clientRequestBody?: string;
    clientResponseBody?: Promise<string>;
    translate?: string;
    thinking?: string;
    tags?: RequestTags;
    cacheKey?: string;
    compaction?: boolean;
    effort?: string;
    effortSource?: EffortSource;
    prefix?: PrefixDiff;
}): void {
    scheduleUsageTracking({
        route: input.route,
        client: input.client,
        proxyModel: input.proxyModel,
        path: input.path,
        status: input.status,
        elapsedMs: input.elapsedMs,
        bodyText: input.bodyText,
        responseBody: input.responseBody,
        clientRequestBody: input.clientRequestBody,
        clientResponseBody: input.clientResponseBody,
        timeline: input.timeline,
        captureFailure: input.captureFailure,
        translate: input.translate,
        thinking: input.thinking,
        tags: input.tags,
        cacheKey: input.cacheKey,
        compaction: input.compaction,
        effort: input.effort,
        effortSource: input.effortSource,
        prefix: input.prefix,
    });
    scheduleBillingSync(input.route.account, input.runtime.providers);
}

function jsonError(status: number, error: Record<string, unknown>): Response {
    return new Response(SafeJSON.stringify({ error }), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

/**
 * A refusal in the client's own error shape. Claude Code reads `type: "error"` first and showed an OpenAI-shaped
 * body as a blank failure, so `/v1/messages` gets Anthropic's envelope; the OpenAI endpoints keep theirs.
 */
const ANTHROPIC_ERROR_TYPES = {
    400: "invalid_request_error",
    403: "permission_error",
    429: "rate_limit_error",
} as const;

function refusal(
    status: keyof typeof ANTHROPIC_ERROR_TYPES,
    message: string,
    openAi: { type: string; code: string },
    anthropic: boolean
): Response {
    if (!anthropic) {
        return jsonError(status, { message, ...openAi });
    }

    const type = ANTHROPIC_ERROR_TYPES[status];
    return new Response(SafeJSON.stringify({ type: "error", error: { type, message } }), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

/**
 * Read a model-bearing POST body once, with the size and shape guards every
 * inference route needs. Shared by /v1/chat/completions, /v1/responses and
 * /v1/messages so a guard added for one door is never missing from another.
 */
interface ModelBody {
    bodyText: string;
    model: string;
    /** The session id Claude Code put in `metadata.user_id`. */
    claudeSessionId?: string;
    /** The conversation id the client sent on its own: Claude Code's session id, else a body `prompt_cache_key`. */
    conversationId?: string;
    /** Claude Code's compaction turn (`/v1/messages`). */
    compaction: boolean;
    /** Claude Code's one-token `model_validation` probe (`/v1/messages`). */
    probe: boolean;
    stream: boolean;
    /** The effort the client set itself: Claude Code's `/effort`, sent as `output_config.effort`. */
    clientEffort?: string;
}

async function readModelBody(req: Request): Promise<ModelBody | { error: Response }> {
    const contentLength = req.headers.get("content-length");

    if (contentLength) {
        const declaredBytes = Number.parseInt(contentLength, 10);

        if (Number.isFinite(declaredBytes) && declaredBytes > MAX_REQUEST_BODY_BYTES) {
            return { error: jsonError(413, { message: "Request body too large" }) };
        }
    }

    const bodyText = await req.text();

    if (Buffer.byteLength(bodyText, "utf8") > MAX_REQUEST_BODY_BYTES) {
        return { error: jsonError(413, { message: "Request body too large" }) };
    }

    let parsed: {
        model?: string;
        metadata?: unknown;
        prompt_cache_key?: unknown;
        messages?: unknown;
        max_tokens?: unknown;
        tools?: unknown;
        stream?: unknown;
        output_config?: unknown;
    };

    try {
        parsed = SafeJSON.parse(bodyText, { strict: true }) as typeof parsed;
    } catch (err) {
        logger.debug({ err }, "ai-proxy: invalid JSON body");
        return { error: jsonError(400, { message: "Invalid JSON body" }) };
    }

    if (!parsed.model) {
        return { error: jsonError(400, { message: "Missing model" }) };
    }

    const invalidImagePayload = findInvalidImageDataPayload(parsed as Record<string, unknown>);

    if (invalidImagePayload !== null) {
        logger.warn(
            { model: parsed.model, payloadPreview: invalidImagePayload },
            "ai-proxy: rejecting image content with invalid base64 payload"
        );

        return {
            error: jsonError(400, {
                message:
                    `Image content part carries an invalid base64 payload (${SafeJSON.stringify(invalidImagePayload)}) — ` +
                    "the image bytes never reached the proxy. This usually means the client stringified an object " +
                    'into the data URL (e.g. AI SDK v2-compat file parts becoming "[object Object]").',
                type: "invalid_request_error",
                code: "invalid_image_data",
            }),
        };
    }

    const turn = ClaudeCodeTurn.read(parsed as Record<string, unknown>);
    const claudeSessionId = turn.sessionId;
    const cacheKey = typeof parsed.prompt_cache_key === "string" ? parsed.prompt_cache_key.trim() : "";

    if (turn.missedCompaction) {
        recordCompactionEvent({
            kind: "missed",
            ...(claudeSessionId ? { claudeSession: claudeSessionId } : {}),
            ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
            reason: "the request carries Claude Code's compaction prompt, but it was not read as a compaction turn",
        });
    }

    return {
        bodyText,
        model: parsed.model,
        claudeSessionId,
        conversationId: claudeSessionId ?? (cacheKey || undefined),
        compaction: turn.isCompaction,
        probe: turn.isModelProbe,
        stream: turn.stream,
        clientEffort: turn.effort,
    };
}

/** The effort a `/v1/messages` request asked for, and from where: the id's suffix wins over the client's setting. */
function requestEffort(route: ResolvedRoute, body: ModelBody): { effort?: string; effortSource: EffortSource } {
    if (route.reasoningEffort) {
        return { effort: route.reasoningEffort, effortSource: "suffix" };
    }

    return body.clientEffort ? { effort: body.clientEffort, effortSource: "client" } : { effortSource: "default" };
}

/** Model → account route plus a live provider, with the per-client denial and quota gates. */
async function authorizeModelRoute({
    client,
    config,
    model,
    providers,
    anthropic = false,
}: {
    /** The request came in on `/v1/messages`: refusals use Anthropic's error envelope. */
    anthropic?: boolean;
    client: ResolvedClient;
    config: AiProxyConfig;
    model: string;
    providers: Map<string, ProxyProvider>;
}): Promise<{ route: ResolvedRoute; provider: ProxyProvider } | { error: Response }> {
    const sessionRoute = client.session ? resolveSessionRoute(model, client.session, config.accounts) : undefined;

    if (sessionRoute && "refusal" in sessionRoute) {
        logger.warn({ client: client.name, model, refusal: sessionRoute.refusal }, "ai-proxy: session route refused");
        return {
            error: refusal(
                400,
                sessionRoute.refusal,
                { type: "invalid_request_error", code: "model_not_in_session" },
                anthropic
            ),
        };
    }

    const resolved = sessionRoute?.route ?? (await resolveProxyRoute(model, config.accounts));
    // A session reaches only the accounts its record names, also through a full account id: never their failover.
    const route = client.session ? sessionPinnedRoute(resolved) : resolved;
    const denial = routeDenial(client, route.account);

    if (denial) {
        logger.warn({ client: client.name, model, denial }, "ai-proxy: provider denied");
        return { error: refusal(403, denial, { type: "forbidden", code: "provider_not_allowed" }, anthropic) };
    }

    const quota = checkClientQuota(client);

    if (!quota.ok) {
        logger.warn({ client: client.name, reason: quota.reason }, "ai-proxy: quota exceeded");
        return {
            error: refusal(429, quota.reason, { type: "quota_exceeded", code: "monthly_quota_exceeded" }, anthropic),
        };
    }

    const provider = await acquireProvider(providers, route);

    if (!provider) {
        return { error: providerUnavailableResponse(route) };
    }

    return { route, provider };
}

export function startAiProxyServer(runtime: AiProxyRuntime) {
    const clientProblems = validateClients(runtime.config.clients);

    if (clientProblems.length > 0) {
        throw new Error(`ai-proxy: invalid clients config — ${clientProblems.join("; ")}`);
    }

    try {
        sweepSessionRecords({ retentionDays: runtime.config.sessionRetentionDays });
        sweepCompactions(runtime.config.sessionRetentionDays ?? DEFAULT_SESSION_RETENTION_DAYS);
    } catch (err) {
        logger.warn({ err }, "ai-proxy: session sweep failed; records stay as they are");
    }

    const listen = runtime.config.listen;

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
            setCodexModelOverrides(config.codexModels);
            setClaudeSessionSettings(config.claudeSessions);

            // An unknown or closed session key is refused before any route runs, and never forwarded anywhere.
            const sessionRejection = sessionKeyRejection(req);

            if (sessionRejection) {
                logger.warn({ path, reason: sessionRejection }, "ai-proxy: session key refused");

                return refusal(
                    403,
                    sessionRejection,
                    { type: "permission_error", code: "session_unknown" },
                    path.startsWith("/v1/messages")
                );
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
                    return new Response(
                        SafeJSON.stringify({ error: { message: "Invalid proxy API key", type: "auth_error" } }),
                        { status: 401, headers: { "Content-Type": "application/json" } }
                    );
                }

                if (client.session) {
                    return new Response(
                        SafeJSON.stringify(
                            sessionPickerModels({
                                models: listedCodexModels(),
                                contextLimit: client.session.pickerContextTokens,
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

            // Claude Code and the Anthropic SDKs speak /v1/messages, not
            // /v1/chat/completions. Every provider behind this proxy speaks
            // OpenAI, so the body is translated both ways (anthropic-messages.ts).
            if (path === "/v1/messages/count_tokens" && req.method === "POST") {
                const client = await resolveClient(req, config);

                if (!client) {
                    return jsonError(401, { message: "Invalid proxy API key", type: "auth_error" });
                }

                const countBody = await req.text();

                return new Response(SafeJSON.stringify({ input_tokens: countAnthropicInputTokens(countBody) }), {
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (path === "/v1/messages" && req.method === "POST") {
                const client = await resolveClient(req, config);

                if (!client) {
                    return jsonError(401, { message: "Invalid proxy API key", type: "auth_error" });
                }

                const requestStarted = performance.now();
                const body = await readModelBody(req);

                if ("error" in body) {
                    return body.error;
                }

                const { bodyText, model } = body;
                const session = client.session ? noteSessionRequest(client.session, body.claudeSessionId) : undefined;
                const tags = requestTagsFor(req.headers, session, body.conversationId);

                try {
                    const routed = await authorizeModelRoute({
                        client,
                        config,
                        model,
                        providers: runtime.providers,
                        anthropic: true,
                    });

                    if ("error" in routed) {
                        return routed.error;
                    }

                    const { route, provider } = routed;

                    // Answered here once the route and its account check passed: forwarding it would run a whole
                    // Codex turn (WHAM ignores the one-token cap) inside the probe's 15 s, for an answer nobody reads.
                    if (client.session && body.probe) {
                        logger.info(
                            { model, account: route.accountName, session: session?.id },
                            "ai-proxy: answered Claude Code's model_validation probe"
                        );
                        const reply = modelProbeReply(model);

                        return body.stream
                            ? new Response(messageToAnthropicSse(reply), {
                                  headers: { "Content-Type": "text/event-stream" },
                              })
                            : new Response(SafeJSON.stringify(reply), {
                                  headers: { "Content-Type": "application/json" },
                              });
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
                    const routedBody = stampEffort
                        ? applyReasoningEffortToBody(bodyText, route.reasoningEffort)
                        : bodyText;

                    if (route.reasoningEffort && !stampEffort) {
                        logger.debug(
                            { proxyModel: model, provider: provider.id, effort: route.reasoningEffort },
                            "ai-proxy: dropped the effort suffix — this provider passes the Anthropic body through"
                        );
                    }

                    const {
                        response,
                        responseBody,
                        timeline,
                        openAiBodyText,
                        clientResponseBody,
                        captureFailure,
                        promptCacheKey,
                    } = await anthropicMessagesPipeline({
                        startedAt: requestStarted,
                        provider,
                        upstreamModel: route.upstreamId,
                        proxyModel: model,
                        req,
                        bodyText: routedBody,
                        cacheKeyPolicy: session?.cacheKeyPolicy,
                        recordId: session?.id,
                        sessionAgents: session?.agents,
                    });
                    const elapsedMs = Math.round(performance.now() - requestStarted);

                    // The usage layer only parses the OpenAI shape, and the exchange it
                    // should book is the one the upstream actually saw. The Anthropic
                    // pair rides along separately so a translation bug is visible in the
                    // transcript instead of only in the client's UI.
                    trackProxyRequest({
                        runtime,
                        route,
                        client: client.name,
                        proxyModel: model,
                        path,
                        status: response.status,
                        elapsedMs,
                        bodyText: openAiBodyText,
                        responseBody,
                        clientRequestBody: routedBody,
                        clientResponseBody,
                        timeline,
                        translate: "anthropic",
                        // A stream that stalled and was cut short is not a
                        // success; the other two routes already forward this.
                        captureFailure,
                        tags,
                        cacheKey: promptCacheKey?.key,
                        compaction: body.compaction,
                        ...effort,
                        prefix: prefixDiffFor(req),
                    });

                    logger.info(
                        {
                            path,
                            model,
                            upstreamModel: route.upstreamId,
                            status: response.status,
                            elapsedMs,
                            ...tags,
                            // The whole key: a session id or a content hash, never a secret, and the only place the
                            // log can be joined with Claude Code's own transcript and the upstream's cache.
                            cacheKey: promptCacheKey ? `${promptCacheKey.key} (${promptCacheKey.source})` : undefined,
                            userAgent: req.headers.get("User-Agent") ?? undefined,
                        },
                        "ai-proxy: request"
                    );

                    return response;
                } catch (err) {
                    const mapped = mapProxyRequestError(err);
                    logRequestFailure({
                        req,
                        err,
                        status: mapped.status,
                        fields: { path, model, elapsedMs: Math.round(performance.now() - requestStarted) },
                    });

                    return new Response(
                        SafeJSON.stringify({
                            type: "error",
                            error: { type: "invalid_request_error", message: mapped.message },
                        }),
                        { status: mapped.status, headers: { "Content-Type": "application/json" } }
                    );
                }
            }

            if ((path === "/v1/chat/completions" || path === "/v1/responses") && req.method === "POST") {
                const client = await resolveClient(req, config);

                if (!client) {
                    return new Response(
                        SafeJSON.stringify({ error: { message: "Invalid proxy API key", type: "auth_error" } }),
                        { status: 401, headers: { "Content-Type": "application/json" } }
                    );
                }

                const requestStarted = performance.now();
                const body = await readModelBody(req);

                if ("error" in body) {
                    return body.error;
                }

                const { bodyText, model } = body;
                const session = client.session ? noteSessionRequest(client.session, body.claudeSessionId) : undefined;
                const tags = requestTagsFor(req.headers, session, body.conversationId);

                try {
                    const routed = await authorizeModelRoute({
                        client,
                        config,
                        model,
                        providers: runtime.providers,
                    });

                    if ("error" in routed) {
                        return routed.error;
                    }

                    const { route, provider } = routed;
                    const routedBody = applyReasoningEffortToBody(bodyText, route.reasoningEffort);

                    if (path === "/v1/responses") {
                        const { response, responseBody, timeline, captureFailure } = await identityPipeline({
                            startedAt: requestStarted,
                            provider,
                            upstreamModel: route.upstreamId,
                            path: "responses",
                            req,
                            bodyText: routedBody,
                        });
                        const elapsedMs = Math.round(performance.now() - requestStarted);

                        trackProxyRequest({
                            runtime,
                            route,
                            client: client.name,
                            proxyModel: model,
                            path,
                            status: response.status,
                            elapsedMs,
                            bodyText: routedBody,
                            responseBody,
                            timeline,
                            captureFailure,
                            translate: "off",
                            // Verbatim client bytes, pre effort-stamp. Without this
                            // the 2026-08-19 field-loss audit could not quantify
                            // anything on the OpenAI doors (0 of 3,068 recoverable).
                            clientRequestBody: bodyText,
                            tags,
                        });

                        logger.info(
                            {
                                path,
                                model,
                                upstreamModel: route.upstreamId,
                                status: response.status,
                                elapsedMs,
                                ...tags,
                                userAgent: req.headers.get("User-Agent") ?? undefined,
                            },
                            "ai-proxy: request"
                        );

                        return response;
                    }

                    const mode = resolveTranslationMode({
                        configMode: config.translation.cursorAgent,
                        flagMode: runtime.serveOptions.translateCursor,
                        noTranslate: runtime.serveOptions.noTranslate,
                        headerMode: req.headers.get("x-ai-proxy-translate"),
                    });

                    const thinkingMode = resolveThinkingMode({
                        configMode: config.translation.thinking,
                        flagMode: runtime.serveOptions.thinking,
                        headerMode: req.headers.get("x-ai-proxy-thinking"),
                        rules: config.translation.thinkingRules,
                        userAgent: req.headers.get("user-agent"),
                    });

                    const { response, responseBody, timeline, captureFailure } = await handleChatCompletions({
                        startedAt: requestStarted,
                        mode,
                        thinkingMode,
                        provider,
                        upstreamModel: route.upstreamId,
                        proxyModel: model,
                        req,
                        bodyText: routedBody,
                    });
                    const elapsedMs = Math.round(performance.now() - requestStarted);

                    trackProxyRequest({
                        runtime,
                        route,
                        client: client.name,
                        proxyModel: model,
                        path,
                        status: response.status,
                        elapsedMs,
                        bodyText: routedBody,
                        responseBody,
                        timeline,
                        captureFailure,
                        translate: mode,
                        thinking: thinkingMode,
                        // Verbatim client bytes, pre effort-stamp — see the
                        // /v1/responses call above.
                        clientRequestBody: bodyText,
                        tags,
                    });

                    logger.info(
                        {
                            path,
                            model,
                            upstreamModel: route.upstreamId,
                            status: response.status,
                            translate: mode,
                            thinking: thinkingMode,
                            elapsedMs,
                            ...tags,
                            userAgent: req.headers.get("User-Agent") ?? undefined,
                        },
                        "ai-proxy: request"
                    );

                    return response;
                } catch (err) {
                    const mapped = mapProxyRequestError(err);
                    logRequestFailure({
                        req,
                        err,
                        status: mapped.status,
                        fields: { path, model, elapsedMs: Math.round(performance.now() - requestStarted) },
                    });

                    return new Response(SafeJSON.stringify({ error: { message: mapped.message } }), {
                        status: mapped.status,
                        headers: { "Content-Type": "application/json" },
                    });
                }
            }

            return new Response("Not Found", { status: 404 });
        },
    });
}
