import { accountConfigFingerprint, resolveGrokAuthPath } from "@app/ai-proxy/lib/account-config";
import { listGrokProxyModels } from "@app/ai-proxy/lib/model-meta";
import { mapGrokError } from "@app/ai-proxy/lib/providers/grok-errors";
import type { OpenAiModel, ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { parseRetryAfterSeconds } from "@app/ai-proxy/lib/providers/wham-errors";
import { prepareGrokUpstreamBody } from "@app/ai-proxy/lib/rewrite-upstream-body";
import type { AiProxyAccountConfig, UsageSummary } from "@app/ai-proxy/lib/types";
import {
    formatBillingSummary,
    GrokAuthExpiredError,
    GrokSubscriptionClient,
    resolveGrokSubToken,
} from "@genesiscz/utils/ai/grok";
import { GROK_CLI_CHAT_PROXY_BASE_URL } from "@genesiscz/utils/ai/grok/paths";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

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
        const started = performance.now();

        try {
            const upstream = await this.client.fetch(path, {
                method: "POST",
                body: prepared.bodyText,
                modelOverride: prepared.upstreamModel,
                signal: req.signal,
                headers: {
                    Accept: req.headers.get("Accept") ?? "application/json",
                },
            });

            const elapsedMs = Math.round(performance.now() - started);

            if (!upstream.ok) {
                const retryAfter = upstream.headers.get("retry-after");
                const errorBody = await upstream.text();
                logger.warn(
                    {
                        account: this.account.name,
                        upstreamModel: prepared.upstreamModel,
                        requestedModel: upstreamModel,
                        imageRouted: prepared.imageRouted,
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
                    upstreamModel: prepared.upstreamModel,
                    requestedModel: upstreamModel,
                    imageRouted: prepared.imageRouted,
                    path,
                    status: upstream.status,
                    elapsedMs,
                },
                "ai-proxy: upstream request ok"
            );

            return new Response(upstream.body, {
                status: upstream.status,
                headers: upstream.headers,
            });
        } catch (err) {
            if (err instanceof GrokAuthExpiredError) {
                logger.warn(
                    {
                        account: this.account.name,
                        upstreamModel: prepared.upstreamModel,
                        requestedModel: upstreamModel,
                        imageRouted: prepared.imageRouted,
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
