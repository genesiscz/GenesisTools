import { accountConfigFingerprint } from "@app/ai-proxy/lib/account-config";
import { assertApiKeySourceAllowed, resolveAccountApiKey } from "@app/ai-proxy/lib/providers/api-key-guard";
import { defaultApiKeyEnvName } from "@app/ai-proxy/lib/providers/api-key-state";
import { relayHeaders } from "@app/ai-proxy/lib/providers/http-relay";
import type { OpenAiModel, ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import type { AiProxyAccountConfig, UsageSummary } from "@app/ai-proxy/lib/types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { fetchDirect } from "@genesiscz/utils/net/fetch-direct";
import { isObject } from "@genesiscz/utils/object";

export const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";

const APP_NAME = "GenesisTools";
const APP_URL = "https://github.com/genesiscz/GenesisTools";

function maskKey(key: string): string {
    if (key.length <= 8) {
        return "****";
    }

    return `${key.slice(0, 4)}…${key.slice(-4)}`;
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

    constructor(account: AiProxyAccountConfig, apiKey: string) {
        this.account = account;
        this.accountFingerprint = accountConfigFingerprint(account);
        this.apiKey = apiKey;
        this.baseUrl = (account.baseUrl ?? OPENROUTER_API_BASE_URL).replace(/\/$/, "");
    }

    static async create(account: AiProxyAccountConfig): Promise<OpenRouterApiKeyProvider> {
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

        return new OpenRouterApiKeyProvider(account, resolved.key);
    }

    /**
     * The advertised catalog comes from `lib/model-meta.ts`, which reads the
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
            const response = await fetchDirect(`${this.baseUrl}/key`, {
                headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
            });

            if (!response.ok) {
                return {
                    accountName: this.account.name,
                    provider: "openrouter",
                    summary: `GET /key failed (${response.status}) for key ${maskKey(this.apiKey)}.`,
                };
            }

            const payload = SafeJSON.parse(await response.text(), { strict: true });
            const data = isObject(payload) && isObject(payload.data) ? payload.data : undefined;

            if (!data) {
                return {
                    accountName: this.account.name,
                    provider: "openrouter",
                    summary: `Key ${maskKey(this.apiKey)} present; /key returned no data block.`,
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
                summary: `Key ${maskKey(this.apiKey)} present; usage lookup failed.`,
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

        if (!("usage" in body)) {
            body.usage = { include: true };
        }

        if (streaming && !("stream_options" in body)) {
            body.stream_options = { include_usage: true };
        }

        if (defaults?.provider && !("provider" in body)) {
            body.provider = defaults.provider;
        }

        if (defaults?.fallbackModels?.length && !("models" in body)) {
            body.models = defaults.fallbackModels;
        }

        return SafeJSON.stringify(body);
    }

    private async forward(path: string, upstreamModel: string, bodyText: string, req: Request): Promise<Response> {
        const started = performance.now();
        const streaming = /"stream"\s*:\s*true/.test(bodyText);
        const upstreamBody = this.buildUpstreamBody(bodyText, upstreamModel, streaming);
        const defaults = this.account.openrouter;

        try {
            const upstream = await fetchDirect(`${this.baseUrl}${path}`, {
                method: "POST",
                body: upstreamBody,
                signal: req.signal,
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json",
                    Accept: req.headers.get("Accept") ?? "application/json",
                    // Attribution on the openrouter.ai dashboard, so spend from
                    // this proxy is distinguishable from a direct SDK call.
                    "HTTP-Referer": defaults?.appUrl ?? APP_URL,
                    "X-Title": defaults?.appName ?? APP_NAME,
                },
            });

            const elapsedMs = Math.round(performance.now() - started);
            logger[upstream.ok ? "debug" : "warn"](
                { account: this.account.name, upstreamModel, path, status: upstream.status, elapsedMs },
                `ai-proxy: openrouter upstream request ${upstream.ok ? "ok" : "failed"}`
            );

            return new Response(upstream.body, { status: upstream.status, headers: relayHeaders(upstream) });
        } catch (err) {
            if (req.signal.aborted) {
                logger.debug({ account: this.account.name, path }, "ai-proxy: openrouter client aborted");
                return new Response(null, { status: 499 });
            }

            logger.warn(
                {
                    err,
                    account: this.account.name,
                    upstreamModel,
                    path,
                    elapsedMs: Math.round(performance.now() - started),
                },
                "ai-proxy: openrouter upstream fetch threw"
            );

            return new Response(
                SafeJSON.stringify({
                    error: {
                        message: err instanceof Error ? err.message : String(err),
                        type: "upstream_error",
                        code: "openrouter_api_fetch_failed",
                    },
                }),
                { status: 502, headers: { "Content-Type": "application/json" } }
            );
        }
    }
}
