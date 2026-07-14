import { buildProxyModelCatalog } from "@app/ai-proxy/lib/catalog";
import { loadConfig } from "@app/ai-proxy/lib/config";
import { displayModelsTable } from "@app/ai-proxy/lib/display";
import { out } from "@app/logger";

export async function runModelsCommand(options: {
    provider?: string;
    visibility?: string;
    json?: boolean;
    cursorIds?: boolean;
}): Promise<void> {
    const config = await loadConfig();
    let models = await buildProxyModelCatalog(config.accounts);

    if (options.provider) {
        models = models.filter((model) => model.providerSlug === options.provider);
    }

    if (options.visibility) {
        models = models.filter((model) => model.visibility === options.visibility);
    }

    if (options.json) {
        out.result(models);
        return;
    }

    if (options.cursorIds) {
        out.result(models.map((model) => model.proxyId).join("\n"));
        return;
    }

    displayModelsTable(models);
}
