import { buildProxyModelCatalog } from "@app/ai-proxy/lib/catalog";
import { loadConfig } from "@app/ai-proxy/lib/config";
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

    for (const model of models) {
        out.log.info(
            `${model.proxyId.padEnd(42)} ${model.visibility.padEnd(6)} ${model.speed.padEnd(6)} ${model.thinking.padEnd(12)} ${String(model.contextWindow ?? "-").padEnd(6)} ${model.probeStatus ?? "-"}`
        );
    }
}
