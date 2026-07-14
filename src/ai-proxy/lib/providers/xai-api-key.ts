import { accountConfigFingerprint } from "@app/ai-proxy/lib/account-config";
import { listXaiProxyModels } from "@app/ai-proxy/lib/model-meta";
import type { OpenAiModel, ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { resolveXaiApiKey, XAI_API_BASE_URL } from "@app/ai-proxy/lib/providers/xai-api-key-auth";
import { rewriteBodyModel } from "@app/ai-proxy/lib/rewrite-upstream-body";
import type { AiProxyAccountConfig, UsageSummary } from "@app/ai-proxy/lib/types";
import { logger } from "@app/logger";
import { GrokManagementClient } from "@app/utils/ai/grok";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { fetchDirect } from "@app/utils/net/fetch-direct";

export { resolveXaiApiKey, XAI_API_BASE_URL } from "@app/ai-proxy/lib/providers/xai-api-key-auth";

function maskKey(key: string): string {
    if (key.length <= 8) {
        return "****";
    }

    return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * OpenAI-compatible xAI API key provider (`https://api.x.ai/v1`).
 * Bills the team API key (not Grok subscription). Catalog comes from GET /models.
 */
export class XaiApiKeyProvider implements ProxyProvider {
    readonly id = "xai-api-key";
    readonly accountFingerprint: string;
    private readonly account: AiProxyAccountConfig;
    private readonly apiKey: string;
    private readonly baseUrl: string;

    constructor(account: AiProxyAccountConfig, apiKey: string) {
        this.account = account;
        this.accountFingerprint = accountConfigFingerprint(account);
        this.apiKey = apiKey;
        this.baseUrl = (account.baseUrl ?? XAI_API_BASE_URL).replace(/\/$/, "");
    }

    static async create(account: AiProxyAccountConfig): Promise<XaiApiKeyProvider> {
        const apiKey = resolveXaiApiKey(account);
        const envName = account.apiKeyEnv ?? env.x.getApiEnvKey() ?? "XAI_API_KEY";

        if (!apiKey) {
            throw new Error(
                `No xAI API key found (checked ${envName} / X_AI_API_KEY). Get one at https://console.x.ai/team/default/api-keys`
            );
        }

        return new XaiApiKeyProvider(account, apiKey);
    }

    async listModels(): Promise<OpenAiModel[]> {
        const models = await listXaiProxyModels(this.account);

        return models.map((model) => ({
            id: model.proxyId,
            object: "model" as const,
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

    async getUsage(): Promise<UsageSummary> {
        const managementEnv = this.account.managementKeyEnv ?? "XAI_MANAGEMENT_KEY";
        const managementKey =
            (this.account.managementKeyEnv ? env.getTrimmed(this.account.managementKeyEnv as never) : undefined) ??
            env.x.getManagementKey();
        const teamId = this.account.teamId ?? env.x.getTeamId();

        if (!managementKey || !teamId) {
            return {
                accountName: this.account.name,
                provider: "xai-api-key",
                summary: `API key ${maskKey(this.apiKey)} present. Inference has no usage endpoint — set ${managementEnv} + teamId for Management API usage.`,
            };
        }

        try {
            const client = new GrokManagementClient(managementKey);
            const [teamUsage, prepaidBalance] = await Promise.all([
                client.getTeamUsage({ teamId }),
                client.getPrepaidBalance(teamId),
            ]);

            return {
                accountName: this.account.name,
                provider: "xai-api-key",
                summary: formatXaiManagementSummary(teamUsage, prepaidBalance),
                details: {
                    xai: {
                        teamUsage,
                        prepaidBalance,
                    },
                },
            };
        } catch (err) {
            logger.warn({ err, account: this.account.name }, "ai-proxy: xai management usage failed");

            return {
                accountName: this.account.name,
                provider: "xai-api-key",
                summary: `API key ${maskKey(this.apiKey)} present; Management API usage failed: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            };
        }
    }

    private async forward(path: string, upstreamModel: string, bodyText: string, req: Request): Promise<Response> {
        const started = performance.now();
        const upstreamBody = rewriteBodyModel(bodyText, upstreamModel);
        const url = `${this.baseUrl}${path}`;

        try {
            const upstream = await fetchDirect(url, {
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

            if (!upstream.ok) {
                logger.warn(
                    {
                        account: this.account.name,
                        upstreamModel,
                        path,
                        status: upstream.status,
                        elapsedMs,
                    },
                    "ai-proxy: xai-api-key upstream request failed"
                );
            } else {
                logger.debug(
                    {
                        account: this.account.name,
                        upstreamModel,
                        path,
                        status: upstream.status,
                        elapsedMs,
                    },
                    "ai-proxy: xai-api-key upstream request ok"
                );
            }

            return new Response(upstream.body, {
                status: upstream.status,
                headers: upstream.headers,
            });
        } catch (err) {
            if (req.signal.aborted) {
                logger.debug({ account: this.account.name, path }, "ai-proxy: xai-api-key client aborted");
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
                "ai-proxy: xai-api-key upstream fetch threw"
            );

            return new Response(
                SafeJSON.stringify({
                    error: {
                        message: err instanceof Error ? err.message : String(err),
                        type: "upstream_error",
                        code: "xai_api_fetch_failed",
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

function formatXaiManagementSummary(teamUsage: unknown, prepaidBalance: unknown): string {
    const parts: string[] = [];

    if (teamUsage && typeof teamUsage === "object") {
        parts.push(`team usage: ${SafeJSON.stringify(teamUsage)}`);
    }

    if (prepaidBalance && typeof prepaidBalance === "object") {
        parts.push(`prepaid balance: ${SafeJSON.stringify(prepaidBalance)}`);
    }

    if (parts.length > 0) {
        return parts.join("; ");
    }

    return "Management API usage fetched";
}
