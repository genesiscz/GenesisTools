import { accountConfigFingerprint } from "@app/ai-proxy/lib/account-config";
import { assertApiKeySourceAllowed } from "@app/ai-proxy/lib/providers/api-key-guard";
import { defaultApiKeyEnvName, maskApiKey } from "@app/ai-proxy/lib/providers/api-key-state";
import { type ExchangeFetch, exchange, rewriteSessionModel, toWsBase } from "@app/ai-proxy/lib/providers/http-relay";
import type { OpenAiModel, ProxyProvider, RealtimeConnectTarget } from "@app/ai-proxy/lib/providers/types";
import {
    harvestResponsesOutput,
    inlineResponsesItemReferencesInBodyText,
    whamItemScope,
} from "@app/ai-proxy/lib/providers/wham-item-store";
import { listXaiProxyModels } from "@app/ai-proxy/lib/providers/xai-api-key.models";
import { resolveXaiApiKey, XAI_API_BASE_URL } from "@app/ai-proxy/lib/providers/xai-api-key-auth";
import { clampXaiReasoningEffort } from "@app/ai-proxy/lib/reasoning-effort-vocab";
import { rewriteBodyModel } from "@app/ai-proxy/lib/rewrite-upstream-body";
import type { AiProxyAccountConfig, UsageSummary } from "@app/ai-proxy/lib/types";
import { GrokManagementClient } from "@genesiscz/utils/ai/grok";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { fetchDirect } from "@genesiscz/utils/net/fetch-direct";

export { resolveXaiApiKey, XAI_API_BASE_URL } from "@app/ai-proxy/lib/providers/xai-api-key-auth";

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
    private readonly fetch: ExchangeFetch;

    constructor(account: AiProxyAccountConfig, apiKey: string, fetch: ExchangeFetch = fetchDirect) {
        this.account = account;
        this.accountFingerprint = accountConfigFingerprint(account);
        this.apiKey = apiKey;
        this.fetch = fetch;
        this.baseUrl = (account.baseUrl ?? XAI_API_BASE_URL).replace(/\/$/, "");
    }

    static async create(account: AiProxyAccountConfig): Promise<XaiApiKeyProvider> {
        const resolved = resolveXaiApiKey(account);
        const envName = defaultApiKeyEnvName(account);

        if (!resolved) {
            throw new Error(
                `No xAI API key found (checked config apiKey, ${envName} / X_AI_API_KEY). Set it on the account with \`${toolCommand("ai-proxy accounts set-key")} ${account.name}\` or get one at https://console.x.ai/team/default/api-keys`
            );
        }

        assertApiKeySourceAllowed({ account, source: resolved.source, envName });

        logger.info(
            { account: account.name, provider: account.provider, keySource: resolved.source, apiKeyEnv: envName },
            "ai-proxy: xai account using a billed API key"
        );

        return new XaiApiKeyProvider(account, resolved.key);
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

    /**
     * OpenAI Whisper-compatible in, xAI /stt out. xAI has no
     * /audio/transcriptions route (404, verified 2026-07-20); its STT takes
     * multipart WITHOUT a model field (routing consumed the proxy model) and
     * requires `file` appended last. Response ({text, language, duration,
     * words}) is a superset of OpenAI's json format — passed through as-is.
     */
    async audioTranscriptions(req: Request, upstreamModel: string, form: FormData): Promise<Response> {
        const upstream = new FormData();

        for (const [key, value] of form.entries()) {
            if (key === "model" || key === "file") {
                continue;
            }

            upstream.append(key, value);
        }

        const file = form.get("file");

        if (file instanceof Blob) {
            upstream.append("file", file, file instanceof File ? file.name : "audio");
        }

        return exchange({
            fetch: this.fetch,
            request: {
                url: `${this.baseUrl}/stt`,
                init: { method: "POST", body: upstream, headers: { Authorization: `Bearer ${this.apiKey}` } },
            },
            signal: req.signal,
            log: { provider: "xai-api-key", account: this.account.name, route: "/stt", fields: { upstreamModel } },
            failureCode: "xai_api_fetch_failed",
        });
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
                summary: `API key ${maskApiKey(this.apiKey)} present. Inference has no usage endpoint — set ${managementEnv} + teamId for Management API usage.`,
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
                summary: `API key ${maskApiKey(this.apiKey)} present; Management API usage failed: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            };
        }
    }

    private async forward(path: string, upstreamModel: string, bodyText: string, req: Request): Promise<Response> {
        // xAI has no item store: item_reference pointers are inlined from the
        // proxy's own store on the way in and output items remembered on the
        // way out (see wham-item-store.ts).
        const isResponses = path === "/responses";
        const itemScope = whamItemScope(req);
        const clientBody = isResponses ? inlineResponsesItemReferencesInBodyText(itemScope, bodyText) : bodyText;
        const relayed = await exchange({
            fetch: this.fetch,
            request: {
                url: `${this.baseUrl}${path}`,
                init: {
                    method: "POST",
                    body: rewriteBodyModel(clampXaiReasoningEffort(clientBody, upstreamModel), upstreamModel),
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        "Content-Type": "application/json",
                        Accept: req.headers.get("Accept") ?? "application/json",
                    },
                },
            },
            signal: req.signal,
            log: { provider: "xai-api-key", account: this.account.name, route: path, fields: { upstreamModel } },
            failureCode: "xai_api_fetch_failed",
        });

        if (!isResponses) {
            return relayed;
        }

        return new Response(await harvestResponsesOutput(itemScope, relayed), {
            status: relayed.status,
            headers: relayed.headers,
        });
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
