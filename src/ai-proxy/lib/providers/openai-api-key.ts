import { accountConfigFingerprint } from "@app/ai-proxy/lib/account-config";
import { relayHeaders, rewriteSessionModel, toWsBase } from "@app/ai-proxy/lib/providers/http-relay";
import type { OpenAiModel, ProxyProvider, RealtimeConnectTarget } from "@app/ai-proxy/lib/providers/types";
import { rewriteBodyModel } from "@app/ai-proxy/lib/rewrite-upstream-body";
import type { AiProxyAccountConfig, UsageSummary } from "@app/ai-proxy/lib/types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { fetchDirect } from "@genesiscz/utils/net/fetch-direct";

export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

function maskKey(key: string): string {
    if (key.length <= 8) {
        return "****";
    }

    return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

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

    constructor(account: AiProxyAccountConfig, apiKey: string) {
        this.account = account;
        this.accountFingerprint = accountConfigFingerprint(account);
        this.apiKey = apiKey;
        this.baseUrl = (account.baseUrl ?? OPENAI_API_BASE_URL).replace(/\/$/, "");
    }

    static async create(account: AiProxyAccountConfig): Promise<OpenAiApiKeyProvider> {
        const envName = account.apiKeyEnv ?? "OPENAI_API_KEY";
        const apiKey = env.getTrimmed(envName as never);

        if (!apiKey) {
            throw new Error(`No OpenAI API key found (checked ${envName}).`);
        }

        return new OpenAiApiKeyProvider(account, apiKey);
    }

    async listModels(): Promise<OpenAiModel[]> {
        try {
            const response = await fetchDirect(`${this.baseUrl}/models`, {
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
            summary: `API key ${maskKey(this.apiKey)} present. Platform billing has no key-scoped usage endpoint.`,
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

    private async forward(path: string, upstreamModel: string, bodyText: string, req: Request): Promise<Response> {
        const started = performance.now();
        const upstreamBody = rewriteBodyModel(bodyText, upstreamModel);

        try {
            const upstream = await fetchDirect(`${this.baseUrl}${path}`, {
                method: "POST",
                body: upstreamBody,
                signal: req.signal,
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json",
                    Accept: req.headers.get("Accept") ?? "application/json",
                },
            });

            const elapsedMs = Math.round(performance.now() - started);
            logger[upstream.ok ? "debug" : "warn"](
                { account: this.account.name, upstreamModel, path, status: upstream.status, elapsedMs },
                `ai-proxy: openai upstream request ${upstream.ok ? "ok" : "failed"}`
            );

            return new Response(upstream.body, {
                status: upstream.status,
                headers: relayHeaders(upstream),
            });
        } catch (err) {
            if (req.signal.aborted) {
                logger.debug({ account: this.account.name, path }, "ai-proxy: openai client aborted");
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
                "ai-proxy: openai upstream fetch threw"
            );

            return new Response(
                SafeJSON.stringify({
                    error: {
                        message: err instanceof Error ? err.message : String(err),
                        type: "upstream_error",
                        code: "openai_api_fetch_failed",
                    },
                }),
                {
                    status: 502,
                    headers: { "Content-Type": "application/json" },
                }
            );
        }
    }
}
