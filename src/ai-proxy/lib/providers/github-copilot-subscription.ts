import { accountConfigFingerprint, resolveGithubCopilotDataDir } from "@app/ai-proxy/lib/account-config";
import type { OpenAiModel, ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { rewriteBodyModel } from "@app/ai-proxy/lib/rewrite-upstream-body";
import { prepareCopilotRequest } from "@app/ai-proxy/lib/translators/providers/github-copilot/prepare-request";
import type { AiProxyAccountConfig, UsageSummary } from "@app/ai-proxy/lib/types";
import { logger } from "@app/logger";
import {
    CopilotAuthExpiredError,
    fetchCopilotModels,
    fetchCopilotUserInfo,
    formatCopilotUsageSummary,
    GithubCopilotApi,
    readGithubToken,
    resolveGithubCopilotGhoToken,
    summarizeCopilotUsage,
    toProxyId,
} from "@app/utils/ai/github-copilot";
export class GithubCopilotSubscriptionProvider implements ProxyProvider {
    readonly id = "github-copilot-subscription";
    readonly accountFingerprint: string;
    private readonly account: AiProxyAccountConfig;
    private readonly client: GithubCopilotApi;

    constructor(account: AiProxyAccountConfig, client: GithubCopilotApi) {
        this.account = account;
        this.accountFingerprint = accountConfigFingerprint(account);
        this.client = client;
    }

    static async create(account: AiProxyAccountConfig): Promise<GithubCopilotSubscriptionProvider> {
        const dataDir = resolveGithubCopilotDataDir(account);
        const resolved = await resolveGithubCopilotGhoToken({
            dataDir,
            allowKeychain: true,
        });

        if (!resolved?.token) {
            throw new CopilotAuthExpiredError(dataDir);
        }

        const client = new GithubCopilotApi({
            dataDir,
            apiBaseUrl: account.baseUrl,
        });

        return new GithubCopilotSubscriptionProvider(account, client);
    }

    async listModels(): Promise<OpenAiModel[]> {
        const models = await fetchCopilotModels(this.client);

        return models.map((model) => ({
            id: toProxyId(this.account.name, model.id),
            object: "model",
            created: 1_740_960_000,
            owned_by: `${this.account.name}/github-copilot`,
            description: model.description ?? model.name ?? model.id,
        }));
    }

    async chatCompletions(req: Request, model: string, bodyText: string): Promise<Response> {
        const prepared = prepareCopilotRequest(bodyText, model);
        const path = prepared.route.api === "responses" ? "/responses" : prepared.route.path;

        return this.forward(path, model, prepared.bodyText, req);
    }

    async responses(req: Request, model: string, bodyText: string): Promise<Response> {
        const prepared = prepareCopilotRequest(bodyText, model);
        return this.forward("/responses", model, prepared.bodyText, req);
    }

    async getUsage(): Promise<UsageSummary> {
        const dataDir = resolveGithubCopilotDataDir(this.account);
        const gho = await readGithubToken(dataDir);

        if (!gho) {
            throw new CopilotAuthExpiredError(dataDir);
        }

        const raw = await fetchCopilotUserInfo(gho);
        const summary = summarizeCopilotUsage(raw);

        return {
            accountName: this.account.name,
            provider: "github-copilot-subscription",
            tier: summary.plan,
            summary: formatCopilotUsageSummary(raw),
            details: {
                copilot: summary,
            },
        };
    }

    private async forward(path: string, upstreamModel: string, bodyText: string, req: Request): Promise<Response> {
        const started = performance.now();

        try {
            const upstreamBody = rewriteBodyModel(bodyText, upstreamModel);

            const upstream = await this.client.fetch(path, {
                method: "POST",
                body: upstreamBody,
                signal: req.signal,
                headers: {
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
                    "ai-proxy: github-copilot upstream request failed"
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
                    "ai-proxy: github-copilot upstream request ok"
                );
            }

            return new Response(upstream.body, {
                status: upstream.status,
                headers: upstream.headers,
            });
        } catch (err) {
            if (err instanceof CopilotAuthExpiredError) {
                throw err;
            }

            logger.error({ err, account: this.account.name, path }, "ai-proxy: github-copilot upstream error");
            throw err;
        }
    }
}
