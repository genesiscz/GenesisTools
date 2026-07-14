import { resolveGithubCopilotDataDir, resolveGrokAuthPath } from "@app/ai-proxy/lib/account-config";
import { catalogFilePath, loadCatalogFile } from "@app/ai-proxy/lib/catalog-file";
import { loadConfig } from "@app/ai-proxy/lib/config";
import { out } from "@app/logger";
import { fetchCopilotModels, GithubCopilotApi, readGithubToken } from "@app/utils/ai/github-copilot";
import { GITHUB_COPILOT_UPSTREAM_ENDPOINTS } from "@app/utils/ai/github-copilot/endpoints";
import { COPILOT_INDIVIDUAL_API } from "@app/utils/ai/github-copilot/paths";
import {
    buildGrokModelCatalog,
    GROK_UPSTREAM_ENDPOINTS,
    GrokSubscriptionClient,
    readGrokClientVersion,
} from "@app/utils/ai/grok";
import { SafeJSON } from "@app/utils/json";

type CatalogAccountEntry = {
    accountName: string;
    provider: string;
    baseUrl: string;
    pickerModels: unknown[];
    probedModels: unknown[];
    upstreamEndpoints: unknown[];
};

export async function runUpdateModelsCommand(options: {
    account?: string;
    provider?: string;
    dryRun?: boolean;
    noProbe?: boolean;
}): Promise<void> {
    const config = await loadConfig();
    const providerFilter = options.provider?.toLowerCase();

    const accounts = config.accounts.filter((account) => {
        if (options.account && account.name !== options.account) {
            return false;
        }

        if (providerFilter && account.providerSlug !== providerFilter) {
            return false;
        }

        return account.provider === "grok-subscription" || account.provider === "github-copilot-subscription";
    });

    if (accounts.length === 0) {
        out.log.error("No matching grok or github-copilot accounts in config");
        return;
    }

    const existing = loadCatalogFile();
    const preserved = (existing?.accounts ?? []).filter(
        (entry) =>
            !accounts.some((account) => account.name === entry.accountName && account.provider === entry.provider)
    );

    const payload = {
        updatedAt: new Date().toISOString(),
        grokVersion: readGrokClientVersion(),
        accounts: [...preserved] as CatalogAccountEntry[],
    };

    for (const account of accounts) {
        if (account.provider === "grok-subscription") {
            try {
                const authPath = resolveGrokAuthPath(account);
                const client = await GrokSubscriptionClient.fromAuthFile(authPath);

                if (!client) {
                    out.log.warn(`Skipping ${account.name}: no auth at ${authPath}`);
                    continue;
                }

                const catalog = await buildGrokModelCatalog(client, { probe: !options.noProbe });
                // Never persist dead ids — proxy list and Cursor pickers only see working models.
                const available = catalog.filter((model) => model.probeStatus !== "fail");
                const dropped = catalog.length - available.length;
                const pickerModels = available.filter((model) => model.source === "picker");
                const probedModels = available.filter((model) => model.source !== "picker");

                if (dropped > 0) {
                    out.log.info(`${account.name}: dropped ${dropped} probe-fail model(s) from catalog`);
                }

                payload.accounts.push({
                    accountName: account.name,
                    provider: account.provider,
                    baseUrl: account.baseUrl ?? "https://cli-chat-proxy.grok.com/v1",
                    pickerModels,
                    probedModels,
                    upstreamEndpoints: GROK_UPSTREAM_ENDPOINTS,
                });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                out.log.warn(`Skipping ${account.name}: ${message}`);
            }

            continue;
        }

        if (account.provider === "github-copilot-subscription") {
            try {
                const dataDir = resolveGithubCopilotDataDir(account);
                if (!(await readGithubToken(dataDir))) {
                    out.log.warn(`Skipping ${account.name}: no GitHub token at ${dataDir}`);
                    continue;
                }

                const client = new GithubCopilotApi({ dataDir, apiBaseUrl: account.baseUrl });
                const models = await fetchCopilotModels(client);
                const pickerModels = models.filter((model) => model.model_picker_enabled !== false);
                const probedModels = models.filter((model) => model.model_picker_enabled === false);

                payload.accounts.push({
                    accountName: account.name,
                    provider: account.provider,
                    baseUrl: account.baseUrl ?? COPILOT_INDIVIDUAL_API,
                    pickerModels,
                    probedModels,
                    upstreamEndpoints: [...GITHUB_COPILOT_UPSTREAM_ENDPOINTS],
                });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                out.log.warn(`Skipping ${account.name}: ${message}`);
            }
        }
    }

    const target = catalogFilePath();

    if (options.dryRun) {
        out.log.info(`Would write ${target} (${payload.accounts.length} account(s))`);
        out.result(payload);
        return;
    }

    await Bun.write(target, `${SafeJSON.stringify(payload, null, 2)}\n`);
    out.log.success(`Wrote ${target}`);
}
