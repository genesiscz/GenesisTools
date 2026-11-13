import { accountConfigFingerprint } from "@app/ai-proxy/lib/account-config";
import { assertApiKeySourceAllowed, resolveAccountApiKey } from "@app/ai-proxy/lib/providers/api-key-guard";
import { defaultApiKeyEnvName, maskApiKey } from "@app/ai-proxy/lib/providers/api-key-state";
import { OPENAI_API_BASE_URL } from "@app/ai-proxy/lib/providers/endpoints";
import { type ExchangeFetch, exchange, rewriteSessionModel, toWsBase } from "@app/ai-proxy/lib/providers/http-relay";
import type { OpenAiModel, ProxyProvider, RealtimeConnectTarget } from "@app/ai-proxy/lib/providers/types";
import { rewriteBodyModel } from "@app/ai-proxy/lib/rewrite-upstream-body";
import type { AiProxyAccountConfig, UsageSummary } from "@app/ai-proxy/lib/types";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { fetchDirect } from "@genesiscz/utils/net/fetch-direct";

/**
 * OpenAI API-key provider (`https://api.openai.com/v1`, provider type
 * "openai"). Bills the platform API key — distinct from openai-subscription
 * (ChatGPT/Codex OAuth). Exists primarily for the realtime voice tunnel
 * (gpt-realtime / gpt-realtime-mini / gpt-4o-realtime-preview); chat and
 * responses forward too since the surface is identical.
 */
export class OpenAiApiKeyProvider implements ProxyProvider {
    readonly id = "openai";
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
        this.baseUrl = (account.baseUrl ?? OPENAI_API_BASE_URL).replace(/\/$/, "");
    }

    static async create(account: AiProxyAccountConfig): Promise<OpenAiApiKeyProvider> {
        const envName = defaultApiKeyEnvName(account);
        const resolved = resolveAccountApiKey({
            account,
            defaultEnvKey: () => env.ai.openai.getKey(),
            knownEnvNames: env.ai.openai.getKeys(),
        });

        if (!resolved) {
            // Name both: the fallback is always consulted, so an account with a
            // custom `apiKeyEnv` would otherwise be told only half of what failed.
            const checked = envName === "OPENAI_API_KEY" ? envName : `${envName} / OPENAI_API_KEY`;

            throw new Error(`No OpenAI API key found (checked config apiKey, ${checked}).`);
        }

        assertApiKeySourceAllowed({ account, source: resolved.source, envName });

        logger.info(
            {
                account: account.name,
                provider: account.provider,
                keySource: resolved.source,
                apiKeyEnv: envName,
            },
            "ai-proxy: openai account using a billed API key"
        );

        return new OpenAiApiKeyProvider(account, resolved.key);
    }

    async listModels(): Promise<OpenAiModel[]> {
        try {
            const response = await this.fetch(`${this.baseUrl}/models`, {
                headers: { Authorization: `Bearer ${this.apiKey}` },
            });

            if (!response.ok) {
                return [];
            }

            const body = (await response.json()) as { data?: { id: string; created?: number; owned_by?: string }[] };

            return (body.data ?? []).map((model) => ({
                id: `${this.account.name}/${this.account.providerSlug}/${model.id}`,
                object: "model" as const,
                created: model.created ?? 0,
                owned_by: model.owned_by ?? "openai",
            }));
        } catch (err) {
            logger.warn({ err, account: this.account.name }, "ai-proxy: openai listModels failed");
            return [];
        }
    }

    async chatCompletions(req: Request, model: string, bodyText: string): Promise<Response> {
        return this.forward("/chat/completions", model, bodyText, req);
    }

    async responses(req: Request, model: string, bodyText: string): Promise<Response> {
        return this.forward("/responses", model, bodyText, req);
    }

    async getUsage(): Promise<UsageSummary> {
        return {
            accountName: this.account.name,
            provider: "openai",
            summary: `API key ${maskApiKey(this.apiKey)} present. Platform billing has no key-scoped usage endpoint.`,
        };
    }

    /** Upstream realtime WS: `baseUrl` with ws(s) scheme unless `realtimeBaseUrl` overrides. */
    realtimeConnect(model: string): RealtimeConnectTarget {
        const wsBase = toWsBase(this.account.realtimeBaseUrl ?? this.baseUrl);

        return {
            url: `${wsBase}/realtime?model=${encodeURIComponent(model)}`,
            headers: { Authorization: `Bearer ${this.apiKey}` },
        };
    }

    /** Ephemeral client-secret mint — model is rewritten both top-level and in `session.model`. */
    async realtimeClientSecrets(req: Request, model: string, bodyText: string): Promise<Response> {
        return this.forward("/realtime/client_secrets", model, rewriteSessionModel(bodyText, model), req);
    }

    private forward(path: string, upstreamModel: string, bodyText: string, req: Request): Promise<Response> {
        return exchange({
            fetch: this.fetch,
            request: {
                url: `${this.baseUrl}${path}`,
                init: {
                    method: "POST",
                    body: rewriteBodyModel(bodyText, upstreamModel),
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        "Content-Type": "application/json",
                        Accept: req.headers.get("Accept") ?? "application/json",
                    },
                },
            },
            signal: req.signal,
            log: { provider: "openai", account: this.account.name, route: path, fields: { upstreamModel } },
            failureCode: "openai_api_fetch_failed",
        });
    }
}
