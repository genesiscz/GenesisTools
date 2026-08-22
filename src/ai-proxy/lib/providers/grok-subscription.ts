import { accountConfigFingerprint, resolveGrokAuthPath } from "@app/ai-proxy/lib/account-config";
import { listGrokProxyModels } from "@app/ai-proxy/lib/model-meta";
import { mapGrokError } from "@app/ai-proxy/lib/providers/grok-errors";
import { relayHeaders } from "@app/ai-proxy/lib/providers/http-relay";
import type { OpenAiModel, ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { parseRetryAfterSeconds } from "@app/ai-proxy/lib/providers/wham-errors";
import { prepareGrokUpstreamBody } from "@app/ai-proxy/lib/rewrite-upstream-body";
import {
    braveSearchFn,
    type EmulationOutcome,
    emulateWebSearch,
    emulationStream,
    nativeTranslationLoss,
    nativeWebSearch,
    parseWebSearchServerTool,
    type WebSearchServerTool,
} from "@app/ai-proxy/lib/server-tools/web-search";
import {
    anthropicToGrokResponses,
    stripReasoningInput,
} from "@app/ai-proxy/lib/translators/formats/anthropic/anthropic-to-responses";
import { ensureToolRequiredArrays } from "@app/ai-proxy/lib/translators/formats/anthropic/ensure-tool-required";
import { toAnthropicErrorResponse } from "@app/ai-proxy/lib/translators/formats/anthropic/error-envelope";
import {
    grokResponsesSseToAnthropic,
    grokResponsesToAnthropicMessage,
} from "@app/ai-proxy/lib/translators/formats/anthropic/grok-responses-to-anthropic";
import { hoistSystemMessages } from "@app/ai-proxy/lib/translators/formats/anthropic/hoist-system-messages";
import {
    repairAnthropicSseIndices,
    type ToolMatcher,
    toolMatchersFromBody,
} from "@app/ai-proxy/lib/translators/formats/anthropic/repair-sse-indices";
import { findServerTools } from "@app/ai-proxy/lib/translators/formats/anthropic/server-tools";
import { stringifyUnknownToolResultBlocks } from "@app/ai-proxy/lib/translators/formats/anthropic/stringify-unknown-blocks";
import { tagConfusableTools } from "@app/ai-proxy/lib/translators/formats/anthropic/tool-routing-tag";
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
        let taggedTools = new Set<string>();

        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            // Anthropic server tools execute inside Anthropic's API; grok's
            // deserializer rejects them with an opaque `missing field
            // description` that reads like a proxy bug (probe session
            // d20dfdfe, Claude Code's WebSearch). web_search runs on xAI's
            // native /responses server tool; every OTHER server tool gets an
            // error naming the real cause — judged over the whole tools list,
            // so a mixed request cannot smuggle one past the web_search path.
            const serverTools = findServerTools(parsed as Record<string, unknown>);
            const unsupported = serverTools.find((type) => !type.startsWith("web_search_"));

            if (unsupported !== undefined) {
                return new Response(
                    SafeJSON.stringify({
                        type: "error",
                        error: {
                            type: "invalid_request_error",
                            message: `The grok upstream models custom tools only; this request offers "${unsupported}", a typed Anthropic tool it cannot deserialize. Server tools such as code_execution run inside Anthropic's API, which this account does not reach; client-executed typed tools (bash, text_editor) carry no description or input_schema, which is the field the upstream rejects. Web search is the one typed tool this proxy serves, on xAI's native server-side search.`,
                        },
                    }),
                    { status: 400, headers: { "Content-Type": "application/json" } }
                );
            }

            if (serverTools.length > 0) {
                const webSearch = parseWebSearchServerTool(parsed as Record<string, unknown>);

                if (webSearch) {
                    return this.emulatedWebSearchResponse(req, model, parsed as Record<string, unknown>, webSearch);
                }
            }

            // Default route: the /responses wire. The shim merges parallel
            // tool calls into ONE block (raw wire capture 2026-08-21, nine
            // request variants tried); /responses streams every call as its
            // own named item, and reasoning survives via encrypted reasoning
            // items round-tripped through thinking signatures.
            // AI_PROXY_GROK_MESSAGES_ROUTE=shim restores the passthrough
            // below instantly.
            if (env.aiProxy.getGrokMessagesRoute() === "responses") {
                return this.messagesViaResponses(req, model, parsed as Record<string, unknown>);
            }

            const body = stringifyUnknownToolResultBlocks(
                hoistSystemMessages(ensureToolRequiredArrays(parsed as Record<string, unknown>))
            );
            body.model = model;

            // Grok's STREAMING /messages merges parallel calls into one block
            // and keeps only the first name, so a `{}` orphan matches every
            // no-argument tool equally and the splitter has nothing to go on.
            // Tagging those schemas puts the name back INTO the arguments,
            // which keeps the stream a stream — the tag never reaches the
            // client. Non-streaming replies name every call already.
            if (body.stream === true) {
                taggedTools = tagConfusableTools(body);
            }

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
            return new Response(repairAnthropicSseIndices(response.body, { tools: toolMatchers, taggedTools }), {
                status: response.status,
                headers: relayHeaders(response),
            });
        }

        return new Response(response.body, { status: response.status, headers: relayHeaders(response) });
    }

    /**
     * Anthropic body → /responses wire → Anthropic reply. One upstream output
     * item maps to one content block, so the shim's merge defect cannot occur,
     * and `encrypted_content` reasoning replay is stronger than the shim's
     * plaintext thinking (grok decrypts and consumes it — a tampered blob is
     * rejected).
     */
    private async messagesViaResponses(
        req: Request,
        model: string,
        parsed: Record<string, unknown>
    ): Promise<Response> {
        const anthropicBody = hoistSystemMessages(ensureToolRequiredArrays(parsed));
        const responsesBody = anthropicToGrokResponses(anthropicBody, model);

        const send = (bodyText: string): Promise<Response> =>
            this.dispatch({
                path: "/responses",
                req,
                bodyText,
                modelOverride: model,
                requestedModel: model,
                imageRouted: false,
            });

        let response = await send(SafeJSON.stringify(responsesBody));

        if (!response.ok) {
            const errorText = await response.text();

            // A signature packed by a different conversation (or truncated by
            // the client) fails decryption for the WHOLE request. Replaying
            // once without reasoning items loses continuity for one turn
            // instead of failing it.
            if (response.status === 400 && errorText.includes("Could not decrypt")) {
                logger.warn({ model }, "ai-proxy: grok rejected replayed reasoning — retrying without reasoning items");
                response = await send(SafeJSON.stringify(stripReasoningInput(responsesBody)));

                if (!response.ok) {
                    return toAnthropicErrorResponse(response);
                }
            } else {
                return toAnthropicErrorResponse(
                    new Response(errorText, { status: response.status, headers: response.headers })
                );
            }
        }

        const contentType = response.headers.get("content-type") ?? "";

        if (response.body && contentType.includes("text/event-stream")) {
            return new Response(grokResponsesSseToAnthropic(response.body, { model }), {
                status: response.status,
                headers: relayHeaders(response),
            });
        }

        const envelope = SafeJSON.parse(await response.text(), { strict: true });
        const message = grokResponsesToAnthropicMessage(
            typeof envelope === "object" && envelope !== null && !Array.isArray(envelope)
                ? (envelope as Record<string, unknown>)
                : {},
            { model }
        );

        return new Response(SafeJSON.stringify(message), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    }

    /**
     * Plays Anthropic's role for the web_search server tool. Preferred path:
     * ONE /responses call with xAI's native `{type:"web_search"}` server tool
     * (the upstream searches itself, with citations). Fallback: the Brave
     * loop, when a key is available. Either way the final turn streams with
     * pings so a slow search does not read as a dead connection.
     */
    private async emulatedWebSearchResponse(
        req: Request,
        model: string,
        body: Record<string, unknown>,
        tool: WebSearchServerTool
    ): Promise<Response> {
        logger.info({ model, maxUses: tool.maxUses }, "ai-proxy: running web_search server tool for grok");

        const loss = nativeTranslationLoss(body, tool);
        const run = async (signal?: AbortSignal): Promise<EmulationOutcome | Response> => {
            const native =
                loss === undefined
                    ? await nativeWebSearch({
                          body,
                          tool,
                          callResponses: async (responsesBody) => {
                              responsesBody.model = model;
                              const response = await this.dispatch({
                                  path: "/responses",
                                  req,
                                  bodyText: SafeJSON.stringify(responsesBody),
                                  modelOverride: model,
                                  requestedModel: model,
                                  imageRouted: false,
                                  signal,
                              });

                              return response.ok ? response : toAnthropicErrorResponse(response);
                          },
                      })
                    : unsupportedNativeResponse(loss);

            if (!(native instanceof Response)) {
                return native;
            }

            const braveKey = env.brave.getKey();

            if (braveKey === undefined) {
                return native;
            }

            logger.warn(
                { status: native.status, model, loss },
                "ai-proxy: native /responses web_search unavailable — falling back to the Brave loop"
            );
            return emulateWebSearch({
                body,
                tool,
                signal,
                search: braveSearchFn(braveKey, signal),
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
                        signal,
                    });

                    return response.ok ? response : toAnthropicErrorResponse(response);
                },
            });
        };

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
        signal,
    }: {
        path: string;
        req: Request;
        bodyText: string;
        modelOverride: string;
        requestedModel: string;
        imageRouted: boolean;
        headers?: Record<string, string>;
        /** Extra abort source (the emulation stream's), composed with the client's. */
        signal?: AbortSignal;
    }): Promise<Response> {
        const started = performance.now();

        try {
            const upstream = await this.client.fetch(path, {
                method: "POST",
                body: bodyText,
                modelOverride,
                signal: signal === undefined ? req.signal : AbortSignal.any([req.signal, signal]),
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

/**
 * Stands in for a failed native call when the /responses translation would
 * drop part of the request, so the Brave fallback (which keeps the original
 * Anthropic body) is chosen instead. Without a Brave key this is what the
 * client sees, and it names what is unsupported rather than answering from a
 * silently truncated conversation.
 */
function unsupportedNativeResponse(loss: string): Response {
    return new Response(
        SafeJSON.stringify({
            type: "error",
            error: {
                type: "invalid_request_error",
                message: `web_search on grok cannot be combined with ${loss}: xAI's native server-side search takes plain text only. Set BRAVE_API_KEY to run the emulated search loop, which keeps the full request.`,
            },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
    );
}
