import { listCopilotProxyModels, listGrokProxyModels } from "@app/ai-proxy/lib/model-meta";
import type { AiProxyAccountConfig, ProxyModelMeta } from "@app/ai-proxy/lib/types";
import { GROK_CLI_CHAT_PROXY_BASE_URL } from "@app/utils/ai/grok";

export { catalogFilePath, loadCatalogFile, type ModelsCatalogFile } from "@app/ai-proxy/lib/catalog-file";

export async function buildProxyModelCatalog(accounts: AiProxyAccountConfig[]): Promise<ProxyModelMeta[]> {
    const models: ProxyModelMeta[] = [];

    for (const account of accounts) {
        if (!account.enabled) {
            continue;
        }

        if (account.provider === "grok-subscription") {
            const baseUrl = account.baseUrl ?? GROK_CLI_CHAT_PROXY_BASE_URL;
            models.push(...listGrokProxyModels(account, baseUrl));
        }

        if (account.provider === "github-copilot-subscription") {
            models.push(...(await listCopilotProxyModels(account)));
        }
    }

    return models;
}
