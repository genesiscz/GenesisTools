import { accountConfigFingerprint } from "@app/ai-proxy/lib/account-config";
import { assertApiKeySourceAllowed, resolveAccountApiKey } from "@app/ai-proxy/lib/providers/api-key-guard";
import { defaultApiKeyEnvName, maskApiKey } from "@app/ai-proxy/lib/providers/api-key-state";
import { OPENROUTER_API_BASE_URL } from "@app/ai-proxy/lib/providers/endpoints";
import { type ExchangeFetch, exchange } from "@app/ai-proxy/lib/providers/http-relay";
import type { OpenAiModel, ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { mapOpenRouterReasoningEffort } from "@app/ai-proxy/lib/reasoning-effort-vocab";
import type { AiProxyAccountConfig, AiProxyOpenRouterRoute, UsageSummary } from "@app/ai-proxy/lib/types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { fetchDirect } from "@genesiscz/utils/net/fetch-direct";
import { isObject } from "@genesiscz/utils/object";
import { matchGlob } from "@genesiscz/utils/string";

const APP_NAME = "GenesisTools";
const APP_URL = "https://github.com/genesiscz/GenesisTools";

/** First route (in array order) whose glob matches the upstream model id, if any. */
function matchOpenRouterRoute(
    routes: AiProxyOpenRouterRoute[] | undefined,
    upstreamModel: string
): AiProxyOpenRouterRoute | undefined {
    return routes?.find((route) => matchGlob(upstreamModel, route.match));
}

/**
 * OpenRouter as a proxy provider: a `/chat/completions` relay with two things
 * bolted on that the OpenAI relay does not need.
 *
 * 🛑 **Usage accounting is injected.** The body is the CLIENT's and sets neither
 * `usage.include` nor `stream_options.include_usage`, so without this the ledger
 * has no upstream cost to book and the whole precise-cost story degrades to an
 * estimate — silently, because an absent field looks like an absent charge.
 *
 * 🛑 **The client's body WINS.** Account defaults (`provider` routing, the
 * `models` fallback list) are injected only for top-level keys the client did not
 * set. A client that sends `{provider: {order: ["Morph"], allow_fallbacks: false}}`
 * gets exactly that upstream: never merged with the account's, never stripped.
 * Merging would silently defeat a caller who pinned a route on purpose.
 */
export class OpenRouterApiKeyProvider implements ProxyProvider {
    readonly id = "openrouter";
    readonly accountFingerprint: string;
    private readonly account: AiProxyAccountConfig;
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly fetch: ExchangeFetch;

    constructor(account: AiProxyAccountConfig, apiKey: string, fetch: ExchangeFetch = fetchDirect) {
        this.account = account;
        this.accountFingerprint = accountConfigFingerprint(account);
        this.apiKey = apiKey;
        this.fetch = fetch;
        this.baseUrl = (account.baseUrl ?? OPENROUTER_API_BASE_URL).replace(/\/$/, "");
    }

    /** `fetch` is the upstream seam for tests; the proxy always sends through `fetchDirect`. */
    static async create(
        account: AiProxyAccountConfig,
        fetch: ExchangeFetch = fetchDirect
    ): Promise<OpenRouterApiKeyProvider> {
        const envName = defaultApiKeyEnvName(account);
        const resolved = resolveAccountApiKey({
            account,
            defaultEnvKey: () => env.ai.openrouter.getKey(),
            knownEnvNames: env.ai.openrouter.getKeys(),
        });

        if (!resolved) {
            // Name both: the fallback is always consulted, so an account with a
            // custom `apiKeyEnv` would otherwise be told only half of what failed.
            const checked = envName === "OPENROUTER_API_KEY" ? envName : `${envName} / OPENROUTER_API_KEY`;

            throw new Error(`No OpenRouter API key found (checked config apiKey, ${checked}).`);
        }

        assertApiKeySourceAllowed({ account, source: resolved.source, envName });

        logger.info(
            { account: account.name, provider: account.provider, keySource: resolved.source, apiKeyEnv: envName },
            "ai-proxy: openrouter account using a billed API key"
        );

        return new OpenRouterApiKeyProvider(account, resolved.key, fetch);
    }

    /**
     * The advertised catalog comes from `openrouter-api-key.models.ts`, which reads the
     * shared, public model feed. This method exists for the `ProxyProvider`
     * contract; returning [] keeps one catalog rather than two that can disagree.
     */
    async listModels(): Promise<OpenAiModel[]> {
        return [];
    }

    async chatCompletions(req: Request, model: string, bodyText: string): Promise<Response> {
        return this.forward("/chat/completions", model, bodyText, req);
    }

    /**
     * OpenRouter serves no Responses API. Relaying would produce an upstream 404
     * with an OpenRouter-shaped error body, which reads as "the proxy is broken";
     * 501 naming the endpoint that does work is the honest answer.
     */
    async responses(): Promise<Response> {
        return new Response(
            SafeJSON.stringify({
                error: {
                    message: "OpenRouter has no /v1/responses API — use /v1/chat/completions.",
                    type: "invalid_request_error",
                    code: "responses_not_supported",
                },
            }),
            { status: 501, headers: { "Content-Type": "application/json" } }
        );
    }

    /** `GET /api/v1/key` is key-scoped and real, unlike OpenAI's platform billing. */
    async getUsage(): Promise<UsageSummary> {
        try {
            const response = await this.fetch(`${this.baseUrl}/key`, {
                headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
            });

            if (!response.ok) {
                return {
                    accountName: this.account.name,
                    provider: "openrouter",
                    summary: `GET /key failed (${response.status}) for key ${maskApiKey(this.apiKey)}.`,
                };
            }

            const payload = SafeJSON.parse(await response.text(), { strict: true });
            const data = isObject(payload) && isObject(payload.data) ? payload.data : undefined;

            if (!data) {
                return {
                    accountName: this.account.name,
                    provider: "openrouter",
                    summary: `Key ${maskApiKey(this.apiKey)} present; /key returned no data block.`,
                };
            }

            const spend = typeof data.usage === "number" ? `$${data.usage.toFixed(4)} spent` : "spend unknown";
            const limit = typeof data.limit === "number" ? `, limit $${data.limit.toFixed(2)}` : ", no limit set";
            const remaining =
                typeof data.limit_remaining === "number" ? `, $${data.limit_remaining.toFixed(4)} remaining` : "";

            return {
                accountName: this.account.name,
                provider: "openrouter",
                summary: `${spend}${limit}${remaining}`,
            };
        } catch (err) {
            logger.warn({ err, account: this.account.name }, "ai-proxy: openrouter GET /key threw");

            return {
                accountName: this.account.name,
                provider: "openrouter",
                summary: `Key ${maskApiKey(this.apiKey)} present; usage lookup failed.`,
            };
        }
    }

    /**
     * The one place the outbound body is built.
     *
     * `model` is always overwritten (that is the proxy's job). Everything else is
     * a default: present in the client's body means the client decided.
     */
    private buildUpstreamBody(bodyText: string, upstreamModel: string, streaming: boolean): string {
        let parsed: unknown;

        try {
            parsed = SafeJSON.parse(bodyText, { strict: true });
        } catch (err) {
            // An unparseable body cannot be enriched, and rejecting it here would
            // be a worse error than the upstream's own 400.
            logger.debug({ err, upstreamModel }, "ai-proxy: openrouter body unparseable — relaying it unchanged");
            return bodyText;
        }

        if (!isObject(parsed)) {
            return bodyText;
        }

        const body: Record<string, unknown> = { ...parsed, model: upstreamModel };
        const defaults = this.account.openrouter;
        const route = matchOpenRouterRoute(defaults?.routes, upstreamModel);
        // Each field falls back to the account-level default independently: a
        // route naming only `provider` still picks up the account's
        // `fallbackModels`, and vice versa.
        const effectiveProvider = route?.provider ?? defaults?.provider;
        const effectiveFallbackModels = route?.fallbackModels ?? defaults?.fallbackModels;

        if (!("usage" in body)) {
            body.usage = { include: true };
        }

        if (streaming && !("stream_options" in body)) {
            body.stream_options = { include_usage: true };
        }

        // Cursor (and most OpenAI-shaped clients) never send `reasoning`, and
        // OpenRouter then omits the thinking from the response entirely — the
        // tokens are generated and billed regardless, so asking for them back
        // is free and is what makes a client's thinking panel work at all.
        if (!("reasoning" in body)) {
            body.reasoning = defaults?.reasoning ?? { enabled: true };
        }

        if (effectiveProvider && !("provider" in body)) {
            body.provider = effectiveProvider;
        }

        if (effectiveFallbackModels?.length && !("models" in body)) {
            body.models = effectiveFallbackModels;
        }

        // What the upstream is actually asked for, after the client's body and
        // the account defaults are merged. "No thinking appeared" is otherwise
        // unanswerable: it cannot be told apart from the client having asked for
        // none, and the request body itself is too large to log.
        logger.debug(
            {
                account: this.account.name,
                upstreamModel,
                streaming,
                clientSentReasoning: "reasoning" in (parsed as Record<string, unknown>),
                reasoning: body.reasoning,
                routeMatched: route?.match,
                provider: body.provider,
                models: body.models,
                tools: Array.isArray(body.tools) ? body.tools.length : undefined,
            },
            "ai-proxy: openrouter outbound body"
        );

        return SafeJSON.stringify(body);
    }

    private forward(path: string, upstreamModel: string, bodyText: string, req: Request): Promise<Response> {
        const streaming = /"stream"\s*:\s*true/.test(bodyText);
        const defaults = this.account.openrouter;

        return exchange({
            fetch: this.fetch,
            request: {
                url: `${this.baseUrl}${path}`,
                init: {
                    method: "POST",
                    body: this.buildUpstreamBody(mapOpenRouterReasoningEffort(bodyText), upstreamModel, streaming),
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        "Content-Type": "application/json",
                        Accept: req.headers.get("Accept") ?? "application/json",
                        // Attribution on the openrouter.ai dashboard, so spend from
                        // this proxy is distinguishable from a direct SDK call.
                        "HTTP-Referer": defaults?.appUrl ?? APP_URL,
                        "X-Title": defaults?.appName ?? APP_NAME,
                    },
                },
            },
            signal: req.signal,
            log: { provider: "openrouter", account: this.account.name, route: path, fields: { upstreamModel } },
            failureCode: "openrouter_api_fetch_failed",
        });
    }
}
