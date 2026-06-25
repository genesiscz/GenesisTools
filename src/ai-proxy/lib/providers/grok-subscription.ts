import { accountConfigFingerprint, resolveGrokAuthPath } from "@app/ai-proxy/lib/account-config";
import { listGrokProxyModels } from "@app/ai-proxy/lib/model-meta";
import type { OpenAiModel, ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { prepareGrokUpstreamBody } from "@app/ai-proxy/lib/rewrite-upstream-body";
import type { AiProxyAccountConfig, UsageSummary } from "@app/ai-proxy/lib/types";
import { logger } from "@app/logger";
import { formatBillingSummary, GrokAuthExpiredError, GrokSubscriptionClient } from "@app/utils/ai/grok";
import { GROK_CLI_CHAT_PROXY_BASE_URL } from "@app/utils/ai/grok/paths";
import { SafeJSON } from "@app/utils/json";

export class GrokSubscriptionProvider implements ProxyProvider {
    readonly id = "grok-subscription";
    readonly accountFingerprint: string;
    private client: GrokSubscriptionClient;
    private readonly account: AiProxyAccountConfig;

    constructor(account: AiProxyAccountConfig, client: GrokSubscriptionClient) {
        this.account = account;
        this.accountFingerprint = accountConfigFingerprint(account);
        this.client = client;
    }

    static async create(account: AiProxyAccountConfig): Promise<GrokSubscriptionProvider> {
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
            description: SafeDescription(model),
        }));
    }

    async chatCompletions(req: Request, model: string, bodyText: string): Promise<Response> {
        return this.forward("/chat/completions", model, bodyText, req);
    }

    async responses(req: Request, model: string, bodyText: string): Promise<Response> {
        return this.forward("/responses", model, bodyText, req);
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
        const upstreamBody = prepareGrokUpstreamBody(bodyText, upstreamModel, target);
        const started = performance.now();

        try {
            const upstream = await this.client.fetch(path, {
                method: "POST",
                body: upstreamBody,
                modelOverride: upstreamModel,
                signal: req.signal,
                headers: {
                    Accept: req.headers.get("Accept") ?? "application/json",
                },
            });

            const elapsedMs = Math.round(performance.now() - started);

            if (!upstream.ok) {
                const retryAfter = upstream.headers.get("retry-after");
                logger.warn(
                    {
                        account: this.account.name,
                        upstreamModel,
                        path,
                        status: upstream.status,
                        elapsedMs,
                        retryAfter,
                    },
                    "ai-proxy: upstream request failed"
                );
            } else {
                logger.debug(
                    { account: this.account.name, upstreamModel, path, status: upstream.status, elapsedMs },
                    "ai-proxy: upstream request ok"
                );
            }

            return new Response(upstream.body, {
                status: upstream.status,
                headers: upstream.headers,
            });
        } catch (err) {
            if (err instanceof GrokAuthExpiredError) {
                return new Response(
                    SafeJSON.stringify({
                        error: {
                            message: err.message,
                            type: "auth_error",
                            code: "grok_auth_expired",
                        },
                    }),
                    {
                        status: 401,
                        headers: { "Content-Type": "application/json" },
                    }
                );
            }

            throw err;
        }
    }
}

function SafeDescription(model: {
    visibility: string;
    speed: string;
    thinking: string;
    contextWindow?: number;
    agentType?: string;
    probeStatus?: string;
}): string {
    return SafeJSON.stringify({
        visibility: model.visibility,
        speed: model.speed,
        thinking: model.thinking,
        contextWindow: model.contextWindow,
        agentType: model.agentType,
        probeStatus: model.probeStatus,
    });
}
