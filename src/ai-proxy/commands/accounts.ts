import { buildProxyModelCatalog } from "@app/ai-proxy/lib/catalog";
import { loadConfig, saveConfig } from "@app/ai-proxy/lib/config";
import { createProvider } from "@app/ai-proxy/lib/providers/registry";
import { out } from "@app/logger";

export async function runAccountsList(): Promise<void> {
    const config = await loadConfig();

    for (const account of config.accounts) {
        const modelCount = (await buildProxyModelCatalog([account])).length;
        out.log.info(
            `${account.name.padEnd(12)} ${account.providerSlug.padEnd(6)} ${account.provider.padEnd(18)} enabled=${account.enabled} models=${modelCount}`
        );
    }
}

export async function runAccountsTest(name: string): Promise<void> {
    const config = await loadConfig();
    const account = config.accounts.find((item) => item.name === name);

    if (!account) {
        out.log.error(`Account not found: ${name}`);
        return;
    }

    const provider = await createProvider(account);
    const usage = await provider.getUsage();
    const models = await provider.listModels();

    out.log.success(`${name}: ${usage.summary}`);
    out.log.info(`Models available: ${models.length}`);
}

export async function runAccountsRemove(name: string): Promise<void> {
    const config = await loadConfig();
    const before = config.accounts.length;
    config.accounts = config.accounts.filter((account) => account.name !== name);

    if (config.accounts.length === before) {
        out.log.warn(`Account not found: ${name}`);
        return;
    }

    await saveConfig(config);
    out.log.success(`Removed account: ${name}`);
}
