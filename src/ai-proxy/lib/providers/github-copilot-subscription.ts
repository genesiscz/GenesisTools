import { accountConfigFingerprint } from "@app/ai-proxy/lib/account-config";
import { resolveGithubCopilotDataDir } from "@app/ai-proxy/lib/providers/account-paths";
import { exchange } from "@app/ai-proxy/lib/providers/http-relay";
import type { OpenAiModel, ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { rewriteBodyModel } from "@app/ai-proxy/lib/rewrite-upstream-body";
import { prepareCopilotRequest } from "@app/ai-proxy/lib/translators/providers/github-copilot/prepare-request";
import type { AiProxyAccountConfig, UsageSummary } from "@app/ai-proxy/lib/types";
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
} from "@genesiscz/utils/ai/github-copilot";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/** An expired Copilot login is the host's to fix: say so in the error envelope instead of a bare fetch failure. */
function copilotAuthExpiredResponse(err: unknown, account: string): Response | undefined {
    if (!(err instanceof CopilotAuthExpiredError)) {
        return undefined;
    }

    logger.warn({ account, authPath: err.authPath }, "ai-proxy: github-copilot login expired; answering 502");

    return new Response(
        SafeJSON.stringify({
            error: {
                message: `Upstream GitHub Copilot auth expired or invalid — the ai-proxy host must refresh its login. ${err.message}`,
                type: "upstream_auth_error",
                code: "github_copilot_auth_expired",
            },
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
    );
}

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

    /**
     * The client's own fetch carries the Copilot session and its one refresh on 401; the exchange adds the log,
     * the relay and the 499 for a client that hung up, which used to be logged here as an upstream error.
     */
    private forward(path: string, upstreamModel: string, bodyText: string, req: Request): Promise<Response> {
        return exchange({
            fetch: (input, init) => this.client.fetch(String(input), init),
            request: {
                url: path,
                init: {
                    method: "POST",
                    body: rewriteBodyModel(bodyText, upstreamModel),
                    headers: { Accept: req.headers.get("Accept") ?? "application/json" },
                },
            },
            signal: req.signal,
            log: {
                provider: "github-copilot",
                account: this.account.name,
                route: path,
                fields: { upstreamModel },
            },
            mapThrown: (err) => copilotAuthExpiredResponse(err, this.account.name),
            failureCode: "github_copilot_fetch_failed",
        });
    }
}
