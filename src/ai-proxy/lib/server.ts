import { accountConfigFingerprint } from "@app/ai-proxy/lib/account-config";
import { requireProxyApiKey } from "@app/ai-proxy/lib/auth-middleware";
import { buildProxyModelCatalog } from "@app/ai-proxy/lib/catalog";
import { loadConfigFresh } from "@app/ai-proxy/lib/config";
import { stripBasePath } from "@app/ai-proxy/lib/path-prefix";
import { buildProviderMap, routeProviderKey, tryCreateProvider } from "@app/ai-proxy/lib/providers/registry";
import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { resolveModel } from "@app/ai-proxy/lib/resolve-model";
import { resolveThinkingMode } from "@app/ai-proxy/lib/thinking-config";
import { resolveTranslationMode } from "@app/ai-proxy/lib/translation-config";
import { handleChatCompletions } from "@app/ai-proxy/lib/translators";
import { identityPipeline } from "@app/ai-proxy/lib/translators/identity-pipeline";
import type { AiProxyConfig, ResolvedRoute, ThinkingPresentationMode } from "@app/ai-proxy/lib/types";
import { scheduleBillingSync } from "@app/ai-proxy/lib/usage/billing-sync";
import { scheduleUsageTracking } from "@app/ai-proxy/lib/usage/track-response";
import { logger } from "@app/logger";
import { CopilotAuthExpiredError } from "@app/utils/ai/github-copilot";
import { GrokAuthExpiredError } from "@app/utils/ai/grok";
import { SafeJSON } from "@app/utils/json";

const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

function mapProxyRequestError(err: unknown): { status: number; message: string } {
    if (err instanceof GrokAuthExpiredError || err instanceof CopilotAuthExpiredError) {
        return { status: 401, message: err.message };
    }

    const message = err instanceof Error ? err.message : String(err);

    if (
        message.startsWith("Model id must be") ||
        message.startsWith("No enabled account for model") ||
        message.startsWith("Provider not loaded:")
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
    proxyModel: string;
    path: string;
    status: number;
    elapsedMs: number;
    bodyText: string;
    responseBody: Promise<string>;
    translate?: string;
    thinking?: string;
}): void {
    scheduleUsageTracking({
        route: input.route,
        proxyModel: input.proxyModel,
        path: input.path,
        status: input.status,
        elapsedMs: input.elapsedMs,
        bodyText: input.bodyText,
        responseBody: input.responseBody,
        translate: input.translate,
        thinking: input.thinking,
    });
    scheduleBillingSync(input.route.account, input.runtime.providers);
}

export function startAiProxyServer(runtime: AiProxyRuntime) {
    const listen = runtime.config.listen;

    return Bun.serve({
        hostname: listen.host,
        port: listen.port,
        idleTimeout: 120,
        async fetch(req) {
            const url = new URL(req.url);
            const path = normalizePath(url.pathname, runtime.config.public?.basePath);

            if (req.method === "GET" && (path === "/health" || path === "/v1/health")) {
                return new Response(SafeJSON.stringify({ status: "ok" }), {
                    headers: { "Content-Type": "application/json" },
                });
            }

            const config = await loadConfigFresh();

            if (path === "/v1/models" && req.method === "GET") {
                const authError = requireProxyApiKey(req, config.proxyApiKey);
                if (authError) {
                    return authError;
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

            if ((path === "/v1/chat/completions" || path === "/v1/responses") && req.method === "POST") {
                const authError = requireProxyApiKey(req, config.proxyApiKey);
                if (authError) {
                    return authError;
                }

                const requestStarted = performance.now();
                const contentLength = req.headers.get("content-length");

                if (contentLength) {
                    const declaredBytes = Number.parseInt(contentLength, 10);

                    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_REQUEST_BODY_BYTES) {
                        return new Response(SafeJSON.stringify({ error: { message: "Request body too large" } }), {
                            status: 413,
                            headers: { "Content-Type": "application/json" },
                        });
                    }
                }

                const bodyText = await req.text();

                if (Buffer.byteLength(bodyText, "utf8") > MAX_REQUEST_BODY_BYTES) {
                    return new Response(SafeJSON.stringify({ error: { message: "Request body too large" } }), {
                        status: 413,
                        headers: { "Content-Type": "application/json" },
                    });
                }

                let parsed: { model?: string };
                try {
                    parsed = SafeJSON.parse(bodyText, { strict: true }) as { model?: string };
                } catch (err) {
                    logger.debug({ err }, "ai-proxy: invalid JSON body");
                    return new Response(SafeJSON.stringify({ error: { message: "Invalid JSON body" } }), {
                        status: 400,
                        headers: { "Content-Type": "application/json" },
                    });
                }

                if (!parsed.model) {
                    return new Response(SafeJSON.stringify({ error: { message: "Missing model" } }), {
                        status: 400,
                        headers: { "Content-Type": "application/json" },
                    });
                }

                try {
                    const route = resolveModel(parsed.model, config.accounts);
                    const key = routeProviderKey(route);
                    const fingerprint = accountConfigFingerprint(route.account);
                    let provider = runtime.providers.get(key);

                    if (provider && provider.accountFingerprint !== fingerprint) {
                        const refreshed = await tryCreateProvider(route.account);
                        if (refreshed) {
                            runtime.providers.set(key, refreshed);
                            provider = refreshed;
                        } else {
                            runtime.providers.delete(key);
                            provider = undefined;
                        }
                    }

                    if (!provider) {
                        const created = await tryCreateProvider(route.account);
                        if (created) {
                            runtime.providers.set(key, created);
                            provider = created;
                        }
                    }

                    if (!provider) {
                        return new Response(SafeJSON.stringify({ error: { message: `Provider not loaded: ${key}` } }), {
                            status: 500,
                            headers: { "Content-Type": "application/json" },
                        });
                    }

                    if (path === "/v1/responses") {
                        const { response, responseBody } = await identityPipeline({
                            provider,
                            upstreamModel: route.upstreamId,
                            path: "responses",
                            req,
                            bodyText,
                        });
                        const elapsedMs = Math.round(performance.now() - requestStarted);

                        trackProxyRequest({
                            runtime,
                            route,
                            proxyModel: parsed.model,
                            path,
                            status: response.status,
                            elapsedMs,
                            bodyText,
                            responseBody,
                            translate: "off",
                        });

                        logger.info(
                            {
                                path,
                                model: parsed.model,
                                upstreamModel: route.upstreamId,
                                status: response.status,
                                elapsedMs,
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
                    });

                    const { response, responseBody } = await handleChatCompletions({
                        mode,
                        thinkingMode,
                        provider,
                        upstreamModel: route.upstreamId,
                        proxyModel: parsed.model,
                        req,
                        bodyText,
                    });
                    const elapsedMs = Math.round(performance.now() - requestStarted);

                    trackProxyRequest({
                        runtime,
                        route,
                        proxyModel: parsed.model,
                        path,
                        status: response.status,
                        elapsedMs,
                        bodyText,
                        responseBody,
                        translate: mode,
                        thinking: thinkingMode,
                    });

                    logger.info(
                        {
                            path,
                            model: parsed.model,
                            upstreamModel: route.upstreamId,
                            status: response.status,
                            translate: mode,
                            thinking: thinkingMode,
                            elapsedMs,
                            userAgent: req.headers.get("User-Agent") ?? undefined,
                        },
                        "ai-proxy: request"
                    );

                    return response;
                } catch (err) {
                    const mapped = mapProxyRequestError(err);
                    logger.warn(
                        {
                            path,
                            model: parsed.model,
                            elapsedMs: Math.round(performance.now() - requestStarted),
                            status: mapped.status,
                            error: err,
                        },
                        "ai-proxy: request failed"
                    );

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
