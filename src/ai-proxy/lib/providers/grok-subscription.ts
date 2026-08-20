import { accountConfigFingerprint, resolveGrokAuthPath } from "@app/ai-proxy/lib/account-config";
import { listGrokProxyModels } from "@app/ai-proxy/lib/model-meta";
import { mapGrokError } from "@app/ai-proxy/lib/providers/grok-errors";
import { relayHeaders } from "@app/ai-proxy/lib/providers/http-relay";
import type { OpenAiModel, ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { parseRetryAfterSeconds } from "@app/ai-proxy/lib/providers/wham-errors";
import { prepareGrokUpstreamBody } from "@app/ai-proxy/lib/rewrite-upstream-body";
import { ensureToolRequiredArrays } from "@app/ai-proxy/lib/translators/formats/anthropic/ensure-tool-required";
import { toAnthropicErrorResponse } from "@app/ai-proxy/lib/translators/formats/anthropic/error-envelope";
import { hoistSystemMessages } from "@app/ai-proxy/lib/translators/formats/anthropic/hoist-system-messages";
import {
    repairAnthropicSseIndices,
    type ToolMatcher,
    toolMatchersFromBody,
} from "@app/ai-proxy/lib/translators/formats/anthropic/repair-sse-indices";
import { findServerTool } from "@app/ai-proxy/lib/translators/formats/anthropic/server-tools";
import { stringifyUnknownToolResultBlocks } from "@app/ai-proxy/lib/translators/formats/anthropic/stringify-unknown-blocks";
import {
    braveSearchFn,
    type EmulationOutcome,
    emulateWebSearch,
    emulationStream,
    parseWebSearchServerTool,
    type WebSearchServerTool,
} from "@app/ai-proxy/lib/server-tools/web-search";
import type { AiProxyAccountConfig, UsageSummary } from "@app/ai-proxy/lib/types";
import {
    formatBillingSummary,
    GrokAuthExpiredError,
    GrokSubscriptionClient,
    resolveGrokSubToken,
} from "@genesiscz/utils/ai/grok";
import { GROK_CLI_CHAT_PROXY_BASE_URL } from "@genesiscz/utils/ai/grok/paths";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

export class GrokSubscriptionProvider implements ProxyProvider {
    readonly id = "grok-subscription";
    // Grok's CLI proxy ignores unknown parameters, so the `:<effort>` suffix
    // may be stamped onto the /v1/messages passthrough body instead of being
    // silently dropped for Claude Code sessions.
    readonly messagesAcceptsReasoningEffort = true;
    readonly accountFingerprint: string;
    private client: GrokSubscriptionClient;
    private readonly account: AiProxyAccountConfig;

    constructor(account: AiProxyAccountConfig, client: GrokSubscriptionClient) {
        this.account = account;
        this.accountFingerprint = accountConfigFingerprint(account);
        this.client = client;
    }

    static async create(account: AiProxyAccountConfig): Promise<GrokSubscriptionProvider> {
        // grok-sub account in ~/.genesis-tools/ai/config.json — resolves the
        // token via the account's authFile reference (same store the other
        // subscription providers bill through).
        if (account.grok?.accountName) {
            const { token, authPath } = await resolveGrokSubToken(account.grok.accountName);
            const client = new GrokSubscriptionClient({
                token,
                authPath,
                baseUrl: account.baseUrl ?? GROK_CLI_CHAT_PROXY_BASE_URL,
            });

            return new GrokSubscriptionProvider(account, client);
        }

        const authPath = resolveGrokAuthPath(account);
        const fromFile = await GrokSubscriptionClient.fromAuthFile(authPath);

        if (!fromFile) {
            throw new Error(`No Grok auth entry found at ${authPath}`);
        }

        const client = new GrokSubscriptionClient({
            token: fromFile.getToken(),
            authPath,
            baseUrl: account.baseUrl ?? GROK_CLI_CHAT_PROXY_BASE_URL,
        });

        return new GrokSubscriptionProvider(account, client);
    }

    async listModels(): Promise<OpenAiModel[]> {
        const baseUrl = this.account.baseUrl ?? GROK_CLI_CHAT_PROXY_BASE_URL;
        return listGrokProxyModels(this.account, baseUrl).map((model) => ({
            id: model.proxyId,
            object: "model",
            created: model.created,
            owned_by: model.owned_by,
            description: model.description,
        }));
    }

    async chatCompletions(req: Request, model: string, bodyText: string): Promise<Response> {
        return this.forward("/chat/completions", model, bodyText, req);
    }

    async responses(req: Request, model: string, bodyText: string): Promise<Response> {
        return this.forward("/responses", model, bodyText, req);
    }

    // Grok's CLI proxy speaks the Anthropic Messages API natively (verified:
    // 200, correct SSE, Anthropic-shaped usage, and it accepts its own
    // `thinking` blocks with `signature: ""` replayed in history). Keeping the
    // client's Anthropic body is what preserves reasoning continuity — the
    // OpenAI round trip discards assistant thinking entirely.
    //
    // It is a passthrough, not a verbatim relay: three deterministic repairs run
    // on the body for shapes Grok's deserializer rejects, and one on the SSE.
    // `stringifyUnknownToolResultBlocks` is the only lossy one — see
    // docs/ai-proxy/FlowMatrix.md.
    async messages(req: Request, model: string, bodyText: string): Promise<Response> {
        const parsed = SafeJSON.parse(bodyText, { strict: true });

        let outBody = bodyText;
        let toolMatchers: ToolMatcher[] = [];

        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            // Anthropic server tools execute inside Anthropic's API; grok's
            // deserializer rejects them with an opaque `missing field
            // description` that reads like a proxy bug (probe session
            // d20dfdfe, Claude Code's WebSearch). web_search is emulated by
            // the proxy when a Brave key is available; anything else (or a
            // keyless environment) gets an error naming the real cause.
            const serverTool = findServerTool(parsed as Record<string, unknown>);

            if (serverTool !== undefined) {
                const webSearch = parseWebSearchServerTool(parsed as Record<string, unknown>);
                const braveKey = env.brave.getKey();

                if (webSearch && braveKey !== undefined) {
                    return this.emulatedWebSearchResponse(req, model, parsed as Record<string, unknown>, webSearch, braveKey);
                }

                const hint = webSearch ? " Set BRAVE_API_KEY to let the proxy emulate web_search." : "";
                return new Response(
                    SafeJSON.stringify({
                        type: "error",
                        error: {
                            type: "invalid_request_error",
                            message: `The grok upstream cannot run Anthropic server tools; this request offers "${serverTool}". Server tools (web search, code execution) execute inside Anthropic's API, which this account does not reach.${hint}`,
                        },
                    }),
                    { status: 400, headers: { "Content-Type": "application/json" } }
                );
            }

            const body = stringifyUnknownToolResultBlocks(
                hoistSystemMessages(ensureToolRequiredArrays(parsed as Record<string, unknown>))
            );
            body.model = model;
            outBody = SafeJSON.stringify(body);
            toolMatchers = toolMatchersFromBody(body);
        }

        const response = await this.dispatch({
            path: "/messages",
            req,
            bodyText: outBody,
            modelOverride: model,
            requestedModel: model,
            imageRouted: false,
            headers: { "anthropic-version": "2023-06-01" },
        });

        // `dispatch` re-wraps upstream failures in the OpenAI error envelope,
        // which is right for the OpenAI doors and wrong here: this response goes
        // back to an Anthropic client, which reads `{type:"error", error:{…}}`
        // and would show nothing for an OpenAI-shaped body.
        if (!response.ok) {
            return toAnthropicErrorResponse(response);
        }

        const contentType = response.headers.get("content-type") ?? "";

        // Grok reuses index 0 for every content block and omits it on deltas,
        // which makes Anthropic SDKs overwrite the thinking block with the text
        // block. Verified live 2026-08-19; repaired, not translated.
        if (response.body && contentType.includes("text/event-stream")) {
            return new Response(repairAnthropicSseIndices(response.body, { tools: toolMatchers }), {
                status: response.status,
                headers: relayHeaders(response),
            });
        }

        return new Response(response.body, { status: response.status, headers: relayHeaders(response) });
    }

    /**
     * Plays Anthropic's role for the web_search server tool: rewrites it into
     * a custom tool, answers the model's calls with Brave results, and returns
     * only the final turn — streamed with pings so a multi-search loop does
     * not read as a dead connection.
     */
    private async emulatedWebSearchResponse(
        req: Request,
        model: string,
        body: Record<string, unknown>,
        tool: WebSearchServerTool,
        braveKey: string
    ): Promise<Response> {
        logger.info({ model, maxUses: tool.maxUses }, "ai-proxy: emulating web_search server tool for grok");

        const run = (): Promise<EmulationOutcome | Response> =>
            emulateWebSearch({
                body,
                tool,
                search: braveSearchFn(braveKey),
                callUpstream: async (turnBody) => {
                    const repaired = stringifyUnknownToolResultBlocks(
                        hoistSystemMessages(ensureToolRequiredArrays(turnBody))
                    );
                    repaired.model = model;
                    const response = await this.dispatch({
                        path: "/messages",
                        req,
                        bodyText: SafeJSON.stringify(repaired),
                        modelOverride: model,
                        requestedModel: model,
                        imageRouted: false,
                        headers: { "anthropic-version": "2023-06-01" },
                    });

                    return response.ok ? response : toAnthropicErrorResponse(response);
                },
            });

        if (body.stream === true) {
            return new Response(emulationStream(run), {
                status: 200,
                headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
            });
        }

        const outcome = await run();

        if (outcome instanceof Response) {
            return outcome;
        }

        return new Response(SafeJSON.stringify(outcome.message), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    }

    async getUsage(): Promise<UsageSummary> {
        const [settings, billing] = await Promise.all([this.client.getSettings(), this.client.getBilling()]);

        return {
            accountName: this.account.name,
            provider: "grok-subscription",
            tier: settings.subscription_tier_display,
            summary: formatBillingSummary(billing),
            details: {
                grok: {
                    billing,
                    settings,
                },
            },
        };
    }

    private async forward(path: string, upstreamModel: string, bodyText: string, req: Request): Promise<Response> {
        const target = path.includes("responses") ? "responses" : "chat";
        const prepared = prepareGrokUpstreamBody(bodyText, upstreamModel, target);

        return this.dispatch({
            path,
            req,
            bodyText: prepared.bodyText,
            modelOverride: prepared.upstreamModel,
            requestedModel: upstreamModel,
            imageRouted: prepared.imageRouted,
        });
    }

    private async dispatch({
        path,
        req,
        bodyText,
        modelOverride,
        requestedModel,
        imageRouted,
        headers,
    }: {
        path: string;
        req: Request;
        bodyText: string;
        modelOverride: string;
        requestedModel: string;
        imageRouted: boolean;
        headers?: Record<string, string>;
    }): Promise<Response> {
        const started = performance.now();

        try {
            const upstream = await this.client.fetch(path, {
                method: "POST",
                body: bodyText,
                modelOverride,
                signal: req.signal,
                headers: {
                    Accept: req.headers.get("Accept") ?? "application/json",
                    ...headers,
                },
            });

            const elapsedMs = Math.round(performance.now() - started);

            if (!upstream.ok) {
                const retryAfter = upstream.headers.get("retry-after");
                const errorBody = await upstream.text();
                logger.warn(
                    {
                        account: this.account.name,
                        upstreamModel: modelOverride,
                        requestedModel,
                        imageRouted,
                        path,
                        status: upstream.status,
                        elapsedMs,
                        retryAfter,
                        body: errorBody.slice(0, 500),
                    },
                    "ai-proxy: upstream request failed"
                );

                // Grok's `{"code":…,"error":"…"}` shape doesn't match the OpenAI
                // error envelope, so SDK clients would only surface the bare
                // statusText ("Bad Request") — re-wrap so the real message survives.
                const envelope = mapGrokError({
                    status: upstream.status,
                    bodyText: errorBody,
                    retryAfterSec: parseRetryAfterSeconds(upstream.headers),
                });
                const headers = new Headers({ "Content-Type": "application/json" });
                if (retryAfter) {
                    headers.set("retry-after", retryAfter);
                }

                return new Response(SafeJSON.stringify(envelope), {
                    status: upstream.status,
                    headers,
                });
            }

            logger.debug(
                {
                    account: this.account.name,
                    upstreamModel: modelOverride,
                    requestedModel,
                    imageRouted,
                    path,
                    status: upstream.status,
                    elapsedMs,
                },
                "ai-proxy: upstream request ok"
            );

            return new Response(upstream.body, {
                status: upstream.status,
                headers: relayHeaders(upstream),
            });
        } catch (err) {
            if (err instanceof GrokAuthExpiredError) {
                logger.warn(
                    {
                        account: this.account.name,
                        upstreamModel: modelOverride,
                        requestedModel,
                        imageRouted,
                        path,
                        elapsedMs: Math.round(performance.now() - started),
                        authPath: err.authPath,
                    },
                    "ai-proxy: synthesizing 502 from GrokAuthExpiredError (upstream said 401/403 — see prior 'grok: upstream returned auth-status' log for body)"
                );

                return new Response(
                    SafeJSON.stringify({
                        error: {
                            message: `Upstream Grok auth expired or invalid — the ai-proxy host must refresh its Grok login. ${err.message}`,
                            type: "upstream_auth_error",
                            code: "grok_auth_expired",
                        },
                    }),
                    {
                        status: 502,
                        headers: { "Content-Type": "application/json" },
                    }
                );
            }

            throw err;
        }
    }
}
