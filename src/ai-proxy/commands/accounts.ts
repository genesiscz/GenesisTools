import { buildProxyModelCatalog } from "@app/ai-proxy/lib/catalog";
import { loadConfig, saveConfig } from "@app/ai-proxy/lib/config";
import { type AccountListRow, displayAccountsTable, displayAccountTestResult } from "@app/ai-proxy/lib/display";
import { createProvider, isProviderImplemented } from "@app/ai-proxy/lib/providers/registry";
import { out } from "@app/logger";
import { suggestCommand } from "@app/utils/cli";

function cmd(replaceCommand: string[]): string {
    return suggestCommand("tools ai-proxy", { replaceCommand });
}

export async function runAccountsList(): Promise<void> {
    const config = await loadConfig();
    const rows: AccountListRow[] = [];

    for (const account of config.accounts) {
        const modelCount = (await buildProxyModelCatalog([account])).length;
        rows.push({ account, modelCount });
    }

    displayAccountsTable(rows);
}

export async function runAccountsTest(name: string): Promise<void> {
    const config = await loadConfig();
    const account = config.accounts.find((item) => item.name === name);

    if (!account) {
        out.println();
        out.printlnErr(`  Account not found: ${name}`);
        out.println();
        out.println(`  ${suggestCommand("tools ai-proxy", { replaceCommand: ["accounts", "list"] })}`);
        out.println();
        return;
    }

    if (!account.enabled) {
        out.println();
        out.printlnErr(`  Account "${name}" is disabled in config.`);
        out.println();
        out.println(`  ${cmd(["config", "show"])}`);
        out.println();
        return;
    }

    if (!isProviderImplemented(account.provider)) {
        out.println();
        out.printlnErr(`  Provider not implemented for runtime yet: ${account.provider}`);
        out.println(`  Account "${name}" is configured but has no catalog/runtime adapter.`);
        out.println();
        out.println(`  ${cmd(["accounts", "list"])}`);
        out.println(`  ${cmd(["config", "show"])}`);
        out.println();
        return;
    }

    try {
        const provider = await createProvider(account);
        const usage = await provider.getUsage();
        const models = await provider.listModels();

        displayAccountTestResult({
            name,
            provider: account.provider,
            providerSlug: account.providerSlug,
            summary: usage.summary,
            modelCount: models.length,
            modelsSample: models.map((model) => model.id),
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        out.println();
        out.printlnErr(`  Upstream test failed for "${name}"`);
        out.printlnErr(`  ${message}`);
        out.println();
        out.println(`  ${cmd(["config", "detect"])}`);
        out.println(`  ${cmd(["config", "show"])}`);
        out.println(`  ${cmd(["status"])}`);
        out.println();
    }
}

export async function runAccountsRemove(name: string): Promise<void> {
    const config = await loadConfig();
    const before = config.accounts.length;
    config.accounts = config.accounts.filter((account) => account.name !== name);

    if (config.accounts.length === before) {
        out.log.warn(`Account not found: ${name}`);
        out.log.info(cmd(["accounts", "list"]));
        return;
    }

    await saveConfig(config);
    out.log.success(`Removed account: ${name}`);
}
