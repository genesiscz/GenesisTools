import { resolveGithubCopilotDataDir } from "@app/ai-proxy/lib/account-config";
import { listCopilotProxyModels } from "@app/ai-proxy/lib/model-meta";
import type { ProviderDefinition } from "@app/ai-proxy/lib/providers/definition";
import { GithubCopilotSubscriptionProvider } from "@app/ai-proxy/lib/providers/github-copilot-subscription";
import {
    fetchCopilotModels,
    fetchCopilotUserInfo,
    formatCopilotUsageSummary,
    GithubCopilotApi,
    readGithubToken,
} from "@genesiscz/utils/ai/github-copilot";
import { GITHUB_COPILOT_UPSTREAM_ENDPOINTS } from "@genesiscz/utils/ai/github-copilot/endpoints";
import {
    COPILOT_GHO_TOKEN_SERVICE,
    COPILOT_INDIVIDUAL_API,
    githubTokenPath,
} from "@genesiscz/utils/ai/github-copilot/paths";
import { logger } from "@genesiscz/utils/logger";

export const githubCopilotSubscriptionDefinition: ProviderDefinition = {
    title: "GitHub Copilot",
    defaultSlug: "github-copilot",
    agent: "other",
    // The Copilot login lives in its own token store, not in an AI-config account.
    plugin: null,
    billing: {
        plane: "subscription",
        nativeSource: (account) => `OAuth ${resolveGithubCopilotDataDir(account)}`,
    },
    login: null,
    failover: null,
    models: {
        list: (account) => listCopilotProxyModels(account),
        cacheFiles: (account) => [githubTokenPath(resolveGithubCopilotDataDir(account))],
        bookedId: (upstreamId) => upstreamId,
        servesCatalogIds: false,
        emptyHint: null,
        catalogEntry: async (account) => {
            const dataDir = resolveGithubCopilotDataDir(account);

            if (!(await readGithubToken(dataDir))) {
                return { skipped: `no GitHub token at ${dataDir}` };
            }

            const client = new GithubCopilotApi({ dataDir, apiBaseUrl: account.baseUrl });
            const models = await fetchCopilotModels(client);

            return {
                entry: {
                    accountName: account.name,
                    provider: account.provider,
                    baseUrl: account.baseUrl ?? COPILOT_INDIVIDUAL_API,
                    pickerModels: models.filter((model) => model.model_picker_enabled !== false),
                    probedModels: models.filter((model) => model.model_picker_enabled === false),
                    upstreamEndpoints: [...GITHUB_COPILOT_UPSTREAM_ENDPOINTS],
                },
                dropped: 0,
            };
        },
        facts: null,
    },
    usage: {
        snapshot: (usage) => {
            const copilot = usage.details && "copilot" in usage.details ? usage.details.copilot : undefined;

            if (!copilot) {
                return null;
            }

            return {
                fetchedAt: new Date().toISOString(),
                tier: usage.tier,
                summary: usage.summary,
                details: { copilot },
            };
        },
    },
    routes: { chatViaResponses: true, reshapesChat: false, recoversCompaction: false },
    upstreamEndpoints: GITHUB_COPILOT_UPSTREAM_ENDPOINTS,
    create: (account) => GithubCopilotSubscriptionProvider.create(account),
    suggestedModel: (account) => `${account.name}/github-copilot/claude-sonnet-4`,
    introspect: async (account) => {
        const dataDir = resolveGithubCopilotDataDir(account);
        const lines = [
            `Upstream:     ${account.baseUrl ?? COPILOT_INDIVIDUAL_API}`,
            `Auth:         AuthStorage(${COPILOT_GHO_TOKEN_SERVICE}) — legacy ${githubTokenPath(dataDir)}`,
        ];

        try {
            const gho = await readGithubToken(dataDir);

            if (gho) {
                const raw = await fetchCopilotUserInfo(gho);
                const plan = typeof raw.copilot_plan === "string" ? raw.copilot_plan : "unknown";
                lines.push(`Tier:         ${plan}`);
                lines.push(`Usage:        ${formatCopilotUsageSummary(raw)}`);
            }
        } catch (err) {
            logger.warn({ err, account: account.name, dataDir }, "ai-proxy introspect: copilot auth probe failed");
            lines.push("Auth status:  unavailable");
        }

        return lines;
    },
};
